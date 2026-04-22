import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const FAKE_SECRET = 'ws-test-secret-456';
const FAKE_DATA_DIR = '/tmp/ws-test-project';

// Stub projects.getProjectBySecret before any module that imports it evaluates.
vi.mock('../projects.js', () => ({
  getProjectBySecret: (secret: string) => secret === FAKE_SECRET || secret === 'test-secret-123'
    ? { secret, dataDir: FAKE_DATA_DIR, name: 'ws-test', db: null, markdownSyncState: {}, backupTimers: {} }
    : undefined,
}));

// eslint-disable-next-line import/first
import { destroyAllTerminals, type PtyFactory, type PtyLike, setPtyFactory, type SpawnArgs } from './registry.js';
// eslint-disable-next-line import/first
import { authenticate, wireTerminalWebSocket } from './websocket.js';

class FakePty implements PtyLike {
  static last: FakePty | null = null;
  pid = 1234;
  cols: number;
  rows: number;
  writes: string[] = [];
  resizes: [number, number][] = [];
  private dataListeners = new Set<(s: string) => void>();
  private exitListeners = new Set<(e: { exitCode: number; signal?: number }) => void>();

  constructor(args: SpawnArgs) { this.cols = args.cols; this.rows = args.rows; FakePty.last = this; }
  onData(l: (s: string) => void) { this.dataListeners.add(l); return { dispose: () => { this.dataListeners.delete(l); } }; }
  onExit(l: (e: { exitCode: number; signal?: number }) => void) { this.exitListeners.add(l); return { dispose: () => { this.exitListeners.delete(l); } }; }
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.cols = cols; this.rows = rows; this.resizes.push([cols, rows]); }
  kill(): void { /* ignore */ }
  emit(s: string): void { for (const l of this.dataListeners) l(s); }
}

const factory: PtyFactory = (a) => new FakePty(a);

describe('authenticate', () => {
  it('accepts a valid X-Hotsheet-Secret header', () => {
    const res = authenticate({ url: '/api/terminal/ws', headers: { 'x-hotsheet-secret': 'test-secret-123' } } as never);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.dataDir).toBe(FAKE_DATA_DIR);
  });

  it('accepts a valid ?project= query param', () => {
    const res = authenticate({ url: `/api/terminal/ws?project=${FAKE_SECRET}`, headers: {} } as never);
    expect(res.ok).toBe(true);
  });

  it('rejects missing secret', () => {
    const res = authenticate({ url: '/api/terminal/ws', headers: {} } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  it('rejects unknown secret', () => {
    const res = authenticate({ url: '/api/terminal/ws?project=not-real', headers: {} } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(403);
  });

  // HS-6799 — clients send their post-fit xterm dims on the URL so the server
  // can spawn / resize the PTY to match before emitting the history frame.
  it('parses cols and rows from the query string when present', () => {
    const res = authenticate({ url: `/api/terminal/ws?project=${FAKE_SECRET}&cols=160&rows=50`, headers: {} } as never);
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.cols).toBe(160); expect(res.rows).toBe(50); }
  });

  it('leaves cols/rows undefined when not provided (backwards-compat)', () => {
    const res = authenticate({ url: `/api/terminal/ws?project=${FAKE_SECRET}`, headers: {} } as never);
    expect(res.ok).toBe(true);
    if (res.ok) { expect(res.cols).toBeUndefined(); expect(res.rows).toBeUndefined(); }
  });

  it('rejects non-numeric, zero, or negative cols/rows as undefined (not poison values for the PTY)', () => {
    const cases = ['abc', '0', '-5', ''];
    for (const bad of cases) {
      const res = authenticate({ url: `/api/terminal/ws?project=${FAKE_SECRET}&cols=${bad}&rows=${bad}`, headers: {} } as never);
      expect(res.ok).toBe(true);
      if (res.ok) { expect(res.cols).toBeUndefined(); expect(res.rows).toBeUndefined(); }
    }
  });
});

describe('WebSocket roundtrip (real http.Server)', () => {
  let server: HttpServer;
  let port: number;
  let restore: PtyFactory | undefined;

  beforeAll(() => { restore = setPtyFactory(factory); });
  afterAll(() => { if (restore !== undefined) setPtyFactory(restore); });

  beforeEach(async () => {
    server = createHttpServer((_req, res) => { res.writeHead(404); res.end(); });
    wireTerminalWebSocket(server);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    destroyAllTerminals();
    FakePty.last = null;
    // closeAllConnections() forces any lingering ws clients to disconnect so
    // server.close() actually returns. Without it, tests whose assertions ran
    // but didn't call ws.close() hang the afterEach.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * Open a WebSocket and eagerly capture every message into a queue. Prevents
   * races where the server sends a frame between `open` firing and a later
   * `on('message')` handler being attached.
   */
  function openWs(query = `?project=${FAKE_SECRET}`): { ws: WebSocket; next: (predicate: (data: unknown, isBinary: boolean) => boolean, timeoutMs?: number) => Promise<{ data: unknown; isBinary: boolean }> } {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws${query}`);
    const queue: { data: unknown; isBinary: boolean }[] = [];
    const waiters: Array<{ predicate: (d: unknown, b: boolean) => boolean; resolve: (v: { data: unknown; isBinary: boolean }) => void }> = [];
    ws.on('message', (data, isBinary) => {
      const entry = { data, isBinary };
      const idx = waiters.findIndex((w) => w.predicate(data, isBinary));
      if (idx >= 0) {
        const w = waiters.splice(idx, 1)[0];
        w.resolve(entry);
      } else {
        queue.push(entry);
      }
    });
    function next(predicate: (d: unknown, b: boolean) => boolean, timeoutMs = 2000): Promise<{ data: unknown; isBinary: boolean }> {
      const idx = queue.findIndex((q) => predicate(q.data, q.isBinary));
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
        waiters.push({
          predicate,
          resolve: (v) => { clearTimeout(timer); resolve(v); },
        });
      });
    }
    return { ws, next };
  }

  it('rejects upgrade without a valid secret with 403', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/terminal/ws`);
    const err = await new Promise<unknown>((resolve) => { ws.on('error', resolve); });
    expect(String(err)).toContain('403');
  });

  it('accepts upgrade with a valid secret and sends a history frame first', async () => {
    const { ws, next } = openWs();
    const first = await next((_d, isBinary) => !isBinary);
    const text = first.data instanceof Buffer ? first.data.toString('utf8') : String(first.data);
    const parsed = JSON.parse(text) as { type: string; alive: boolean };
    expect(parsed.type).toBe('history');
    expect(parsed.alive).toBe(true);
    ws.close();
  });

  it('roundtrips PTY output as binary frames and input via binary writes', async () => {
    const { ws, next } = openWs();
    await next((_d, isBinary) => !isBinary);

    FakePty.last!.emit('hello from pty');
    const msg = await next((_d, isBinary) => isBinary);
    const buf = msg.data instanceof Buffer ? msg.data : Buffer.from(msg.data as ArrayBuffer);
    expect(buf.toString('utf8')).toBe('hello from pty');

    // ws is already open by this point (we just roundtripped two frames).
    ws.send(Buffer.from('ls\n'));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(FakePty.last!.writes).toContain('ls\n');

    ws.close();
  });

  it('resize control message propagates to the PTY', async () => {
    const { ws, next } = openWs();
    await next((_d, isBinary) => !isBinary);
    await new Promise<void>((resolve) => { if (ws.readyState === WebSocket.OPEN) resolve(); else ws.on('open', () => resolve()); });
    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(FakePty.last!.resizes).toEqual([[120, 40]]);
    ws.close();
  });

  // HS-6799 — the WS URL carries the client's post-fit xterm dims. On first
  // attach to an eager-spawned PTY the server must resize the PTY to those
  // dims, clear the scrollback, and send Ctrl-L to the PTY so the shell
  // redraws its prompt at the correct geometry.
  it('resizes the PTY to client dims from the WS URL at attach time (HS-6799)', async () => {
    const { ws } = openWs(`?project=${FAKE_SECRET}&cols=160&rows=50`);
    await new Promise<void>((resolve) => { if (ws.readyState === WebSocket.OPEN) resolve(); else ws.on('open', () => resolve()); });
    // One small wait for the server-side attach to land before we inspect.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(FakePty.last!.cols).toBe(160);
    expect(FakePty.last!.rows).toBe(50);
    ws.close();
  });

  it('replays scrollback to a reattaching client', async () => {
    const { ws: ws1, next: next1 } = openWs();
    await next1((_d, isBinary) => !isBinary);
    FakePty.last!.emit('accumulated history');
    await next1((_d, isBinary) => isBinary);
    ws1.close();
    await new Promise<void>((resolve) => ws1.on('close', () => resolve()));

    const { ws: ws2, next: next2 } = openWs();
    const first = await next2((_d, isBinary) => !isBinary);
    const text = first.data instanceof Buffer ? first.data.toString('utf8') : String(first.data);
    const parsed = JSON.parse(text) as { type: string; bytes: string };
    expect(parsed.type).toBe('history');
    const decoded = Buffer.from(parsed.bytes, 'base64').toString('utf8');
    expect(decoded).toBe('accumulated history');
    ws2.close();
  });
});
