import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { PtyLike, SpawnArgs } from '../registry/types.js';
import { BrokerClient, type BrokerClientHandlers } from './brokerClient.js';
import { PtyBroker } from './ptyBroker.js';

/** A controllable fake PTY implementing PtyLike — no real process. */
class FakePty implements PtyLike {
  readonly pid: number;
  cols: number;
  rows: number;
  writes: string[] = [];
  killed: string | null = null;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number; signal?: number }) => void)[] = [];
  constructor(pid: number, cols: number, rows: number) { this.pid = pid; this.cols = cols; this.rows = rows; }
  onData(cb: (d: string) => void): { dispose(): void } { this.dataCbs.push(cb); return { dispose: () => { this.dataCbs = this.dataCbs.filter(c => c !== cb); } }; }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } { this.exitCbs.push(cb); return { dispose: () => { this.exitCbs = this.exitCbs.filter(c => c !== cb); } }; }
  write(d: string): void { this.writes.push(d); }
  resize(c: number, r: number): void { this.cols = c; this.rows = r; }
  kill(signal?: string): void { this.killed = signal ?? 'SIGHUP'; for (const cb of this.exitCbs) cb({ exitCode: 0 }); }
  emit(d: string): void { for (const cb of this.dataCbs) cb(d); }
}

interface Harness { broker: PtyBroker; socketPath: string; tmp: string; clients: BrokerClient[]; fakes: FakePty[] }
const harnesses: Harness[] = [];

async function startBroker(opts: { real?: boolean; leaseGraceMs?: number; onLeaseExpired?: () => void } = {}): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'hsb-'));
  const socketPath = join(tmp, 's');
  const fakes: FakePty[] = [];
  let nextPid = 1000;
  const broker = new PtyBroker({
    leaseGraceMs: opts.leaseGraceMs ?? 0, // 0 = lease disabled unless a test asks
    onLeaseExpired: opts.onLeaseExpired,
    // SAFETY: never signal real pids from tests. Fake-PTY pids are arbitrary ints;
    // killProcessTreeBestEffort on them could hit real system processes. The real-pty
    // test uses a self-exiting command, so its session is never tree-killed either.
    killTree: () => { /* no-op in tests */ },
    spawnPty: opts.real === true ? undefined : (args: SpawnArgs) => { const f = new FakePty(nextPid++, args.cols, args.rows); fakes.push(f); return f; },
  });
  await broker.listen(socketPath);
  const h: Harness = { broker, socketPath, tmp, clients: [], fakes };
  harnesses.push(h);
  return h;
}

function makeClient(h: Harness, handlers?: Partial<BrokerClientHandlers>): { client: BrokerClient; data: Map<string, Buffer[]>; exits: Map<string, number>; history: Map<string, Buffer> } {
  const data = new Map<string, Buffer[]>();
  const exits = new Map<string, number>();
  const history = new Map<string, Buffer>();
  const full: BrokerClientHandlers = {
    onData: (id, c) => { (data.get(id) ?? data.set(id, []).get(id)!).push(c); handlers?.onData?.(id, c); },
    onExit: (id, code) => { exits.set(id, code); handlers?.onExit?.(id, code); },
    onHistory: (id, c) => { history.set(id, c); handlers?.onHistory?.(id, c); },
    onDisconnect: handlers?.onDisconnect,
  };
  const client = new BrokerClient({ socketPath: h.socketPath, clientId: 'test', handlers: full, pingIntervalMs: 0 });
  h.clients.push(client);
  return { client, data, exits, history };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    for (const c of h.clients) c.close();
    h.broker.shutdown();
    try { rmSync(h.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('PTY broker ↔ client (fake pty)', () => {
  it('spawns, streams data, and reports exit', async () => {
    const h = await startBroker();
    const { client, data, exits } = makeClient(h);
    await client.connect();
    client.spawn({ sessionId: 'sec::t1', command: 'x', cwd: '/tmp', cols: 80, rows: 24, env: {} });
    await waitFor(() => h.fakes.length === 1);
    h.fakes[0].emit('hello');
    await waitFor(() => (data.get('sec::t1')?.length ?? 0) > 0);
    expect(Buffer.concat(data.get('sec::t1')!).toString()).toBe('hello');
    h.fakes[0].kill('SIGHUP'); // fake emits exit
    await waitFor(() => exits.has('sec::t1'));
    expect(exits.get('sec::t1')).toBe(0);
  });

  it('write and resize reach the pty', async () => {
    const h = await startBroker();
    const { client } = makeClient(h);
    await client.connect();
    client.spawn({ sessionId: 'sec::t1', command: 'x', cwd: '/tmp', cols: 80, rows: 24, env: {} });
    await waitFor(() => h.fakes.length === 1);
    client.write('sec::t1', Buffer.from('ls\n'));
    client.resize('sec::t1', 120, 40);
    await waitFor(() => h.fakes[0].writes.length > 0 && h.fakes[0].cols === 120);
    expect(h.fakes[0].writes.join('')).toBe('ls\n');
    expect(h.fakes[0].rows).toBe(40);
  });

  it('kill(remove) drops the session; killPrefix removes a whole project', async () => {
    const h = await startBroker();
    const { client } = makeClient(h);
    await client.connect();
    client.spawn({ sessionId: 'A::t1', command: 'x', cwd: '/tmp', cols: 80, rows: 24, env: {} });
    client.spawn({ sessionId: 'A::t2', command: 'x', cwd: '/tmp', cols: 80, rows: 24, env: {} });
    client.spawn({ sessionId: 'B::t1', command: 'x', cwd: '/tmp', cols: 80, rows: 24, env: {} });
    await waitFor(() => h.fakes.length === 3);
    client.kill('A::t1', 'SIGTERM', true);
    await waitFor(() => h.broker.sessionInfos().every(s => s.sessionId !== 'A::t1'));
    client.killPrefix('A::');
    await waitFor(() => h.broker.sessionInfos().every(s => !s.sessionId.startsWith('A::')));
    expect(h.broker.sessionInfos().map(s => s.sessionId)).toEqual(['B::t1']);
  });

  it('a fresh client RE-ADOPTS live sessions via welcome + replays history', async () => {
    const h = await startBroker();
    const c1 = makeClient(h);
    await c1.client.connect();
    c1.client.spawn({ sessionId: 'sec::t1', command: 'x', cwd: '/tmp', cols: 80, rows: 24, env: { X: '1' }, meta: { origin: 'dynamic' } });
    await waitFor(() => h.fakes.length === 1);
    h.fakes[0].emit('scrollback-line\n');
    await waitFor(() => (c1.data.get('sec::t1')?.length ?? 0) > 0);
    // Simulate an accidental node-server death: the client goes away, broker lives.
    c1.client.close();
    // A fresh server connects and re-adopts.
    const c2 = makeClient(h);
    const welcome = await c2.client.connect();
    expect(welcome.map(s => s.sessionId)).toContain('sec::t1');
    const adopted = welcome.find(s => s.sessionId === 'sec::t1')!;
    expect(adopted.alive).toBe(true);
    expect(adopted.meta).toEqual({ origin: 'dynamic' });
    await waitFor(() => c2.history.has('sec::t1'));
    expect(c2.history.get('sec::t1')!.toString()).toBe('scrollback-line\n');
    // and live data still flows to the new client
    h.fakes[0].emit('after-readopt');
    await waitFor(() => Buffer.concat(c2.data.get('sec::t1') ?? []).toString().includes('after-readopt'));
  });

  it('lease expires and fires the callback when the last client disconnects', async () => {
    let expired = false;
    const h = await startBroker({ leaseGraceMs: 40, onLeaseExpired: () => { expired = true; } });
    const { client } = makeClient(h);
    await client.connect();
    client.close();
    await waitFor(() => expired, 2000);
    expect(expired).toBe(true);
  });

  it('a connected client cancels the lease (no spurious expiry)', async () => {
    let expired = false;
    const h = await startBroker({ leaseGraceMs: 40, onLeaseExpired: () => { expired = true; } });
    const { client } = makeClient(h);
    await client.connect();
    await new Promise((r) => setTimeout(r, 120));
    expect(expired).toBe(false);
  });
});

describe('PTY broker ↔ client (real node-pty)', () => {
  it('spawns a real self-exiting PTY and streams its output', async () => {
    const h = await startBroker({ real: true });
    const { client, data, exits } = makeClient(h);
    await client.connect();
    // A benign, self-exiting command — no kill needed, so no process-tree signalling.
    client.spawn({ sessionId: 'sec::real', command: 'printf HS9662OK', cwd: tmpdir(), cols: 80, rows: 24, env: { ...process.env } as Record<string, string> });
    await waitFor(() => exits.has('sec::real'), 8000);
    expect(Buffer.concat(data.get('sec::real') ?? []).toString()).toContain('HS9662OK');
  });
});
