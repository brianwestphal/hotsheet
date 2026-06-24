import { createServer as createHttpServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

const FAKE_SECRET = 'sync-ws-secret';

// Stub the project registry so the secret resolves without a real DB.
vi.mock('../projects.js', () => ({
  getProjectBySecret: (s: string) =>
    s === FAKE_SECRET ? { secret: s, dataDir: '/tmp/sync-ws', name: 'x', db: null, markdownSyncState: {}, backupTimers: {} } : undefined,
}));

// eslint-disable-next-line import/first
import { emitEvent, eventBus } from '../sync/eventBus.js';
// eslint-disable-next-line import/first
import { authenticateSync, wireSyncWebSocket } from './wsSync.js';

const NOT_EXPOSED = { exposed: false, trustedOrigins: [] as string[] };

function req(url: string, headers: Record<string, string> = {}) {
  return { url, headers } as never;
}

describe('authenticateSync', () => {
  it('accepts the secret via header / query / subprotocol', () => {
    expect(authenticateSync(req('/ws/sync', { 'x-hotsheet-secret': FAKE_SECRET }), NOT_EXPOSED).ok).toBe(true);
    expect(authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`), NOT_EXPOSED).ok).toBe(true);
    expect(authenticateSync(req('/ws/sync', { 'sec-websocket-protocol': `hotsheet-secret-${FAKE_SECRET}` }), NOT_EXPOSED).ok).toBe(true);
  });

  it('rejects a missing or unknown secret with 403', () => {
    const missing = authenticateSync(req('/ws/sync'), NOT_EXPOSED);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(403);
    expect(authenticateSync(req('/ws/sync?project=nope'), NOT_EXPOSED).ok).toBe(false);
  });

  it('parses ?since into a non-negative integer (else undefined)', () => {
    const a = authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}&since=5`), NOT_EXPOSED);
    expect(a.ok && a.since).toBe(5);
    const b = authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}&since=0`), NOT_EXPOSED);
    expect(b.ok && b.since).toBe(0);
    const c = authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`), NOT_EXPOSED);
    expect(c.ok && c.since).toBe(undefined);
    const d = authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}&since=junk`), NOT_EXPOSED);
    expect(d.ok && d.since).toBe(undefined);
  });

  describe('origin gate when exposed', () => {
    const exposed = { exposed: true, trustedOrigins: [] as string[] };
    it('rejects a present-but-untrusted origin even with a valid secret', () => {
      const r = authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`, { origin: 'https://evil.com' }), exposed);
      expect(r.ok).toBe(false);
    });
    it('allows a trusted (localhost / configured) origin', () => {
      expect(authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`, { origin: 'http://localhost:4174' }), exposed).ok).toBe(true);
      expect(authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`, { origin: 'http://100.96.1.2' }), { exposed: true, trustedOrigins: ['tailscale'] }).ok).toBe(true);
    });
    it('allows an origin-less client (non-browser) with a valid secret', () => {
      expect(authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`), exposed).ok).toBe(true);
    });
    it('does NOT gate origin when not exposed', () => {
      expect(authenticateSync(req(`/ws/sync?project=${FAKE_SECRET}`, { origin: 'https://evil.com' }), NOT_EXPOSED).ok).toBe(true);
    });
  });
});

describe('wireSyncWebSocket roundtrip (real http.Server)', () => {
  let server: HttpServer;
  let port: number;

  beforeEach(async () => {
    server = createHttpServer((_r, res) => { res.writeHead(404); res.end(); });
    wireSyncWebSocket(server, NOT_EXPOSED);
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function openWs(query = `?project=${FAKE_SECRET}`) {
    const ws = new WebSocket(`ws://localhost:${port}/ws/sync${query}`);
    const queue: unknown[] = [];
    const waiters: Array<{ pred: (d: unknown) => boolean; resolve: (v: unknown) => void }> = [];
    ws.on('message', (data) => {
      // Our frames are always JSON text → a Buffer in `ws`.
      const parsed: unknown = JSON.parse((data as Buffer).toString('utf8'));
      const idx = waiters.findIndex((w) => w.pred(parsed));
      if (idx >= 0) waiters.splice(idx, 1)[0].resolve(parsed);
      else queue.push(parsed);
    });
    function next(pred: (d: unknown) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
      const idx = queue.findIndex(pred);
      if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0] as Record<string, unknown>);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        waiters.push({ pred, resolve: (v) => { clearTimeout(timer); resolve(v as Record<string, unknown>); } });
      });
    }
    return { ws, next };
  }

  it('rejects an upgrade with no secret (403)', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/sync`);
    const err = await new Promise<unknown>((resolve) => ws.on('error', resolve));
    expect(String(err)).toContain('403');
  });

  it('sends a connected frame, then pushes live events; cleans up the sink on close', async () => {
    const { ws, next } = openWs();
    const connected = await next((d) => (d as { type?: string }).type === 'connected');
    expect(connected.type).toBe('connected');
    expect(typeof connected.seq).toBe('number');

    // Sink is registered while open.
    expect(eventBus.sinkCount(FAKE_SECRET)).toBe(1);

    // A bus emit reaches the client with its seq.
    const emitted = emitEvent(FAKE_SECRET, { type: 'ticket-deleted', id: 42 });
    const live = await next((d) => (d as { type?: string; id?: number }).type === 'ticket-deleted' && (d as { id?: number }).id === 42);
    expect(live.seq).toBe(emitted.seq);

    // Closing the client triggers the server-side cleanup (unregister) on the
    // server socket's own close event — poll until it lands.
    ws.close();
    for (let i = 0; i < 100 && eventBus.sinkCount(FAKE_SECRET) !== 0; i++) {
      await new Promise<void>((r) => setTimeout(r, 10));
    }
    expect(eventBus.sinkCount(FAKE_SECRET)).toBe(0);
  });

  it('replays missed events on ?since reconnect', async () => {
    // Emit two events while no client is connected.
    const e1 = emitEvent(FAKE_SECRET, { type: 'ticket-deleted', id: 101 });
    const e2 = emitEvent(FAKE_SECRET, { type: 'ticket-deleted', id: 102 });

    // Reconnect as a client that already applied through e1 → should replay e2.
    const { ws, next } = openWs(`?project=${FAKE_SECRET}&since=${e1.seq}`);
    const replayed = await next((d) => (d as { type?: string }).type === 'ticket-deleted' && (d as { id?: number }).id === 102);
    expect(replayed.seq).toBe(e2.seq);
    await new Promise<void>((resolve) => { ws.on('close', () => resolve()); ws.close(); });
  });
});
