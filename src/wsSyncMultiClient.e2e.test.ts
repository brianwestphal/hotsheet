/**
 * HS-9437 — end-to-end two-client `/ws/sync` live-sync test against a REAL
 * spawned Hot Sheet server (docs/93, HS-8981). The manual §7 plan step this
 * automates: "client A mutates a ticket → client B receives the /ws/sync event",
 * plus the `?since` catch-up on reconnect.
 *
 * This is the full stack the bare-harness `routes/wsSync.test.ts` can't reach:
 * a real HTTP mutation route → `emitSync` → the process event bus → the WS sink
 * → a second connected client. The `resync` directive is left to the bare
 * harness (forcing ring eviction needs 1000+ mutations — impractical against a
 * live server).
 *
 * Gated by `canRunServerSpawnTests` like the other `*.e2e.test.ts` suites (skips
 * when tsx child-spawn isn't possible or when running inside a Hot Sheet
 * terminal — HS-8202).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { canRunServerSpawnTests, postJson, readSecret, type SpawnedHotSheet, spawnHotSheet } from './spawnTestServer.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** Minimal message pump over a `ws` client: `connected()` resolves on the
 *  baseline frame; `next(pred)` resolves on the first frame (queued or future)
 *  matching `pred`. */
function pump(ws: WebSocket) {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<{ pred: (d: Record<string, unknown>) => boolean; resolve: (v: Record<string, unknown>) => void }> = [];
  ws.on('message', (data) => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse((data as Buffer).toString('utf8')) as Record<string, unknown>; }
    catch { return; }
    const idx = waiters.findIndex((w) => w.pred(parsed));
    if (idx >= 0) waiters.splice(idx, 1)[0].resolve(parsed);
    else queue.push(parsed);
  });
  function next(pred: (d: Record<string, unknown>) => boolean, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const idx = queue.findIndex(pred);
    if (idx >= 0) return Promise.resolve(queue.splice(idx, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws frame timeout')), timeoutMs);
      waiters.push({ pred, resolve: (v) => { clearTimeout(timer); resolve(v); } });
    });
  }
  return { next };
}

function openSync(port: number, secret: string, since?: number): { ws: WebSocket; next: ReturnType<typeof pump>['next'] } {
  const q = since !== undefined ? `&since=${String(since)}` : '';
  const ws = new WebSocket(`ws://localhost:${port}/ws/sync?project=${secret}${q}`);
  return { ws, next: pump(ws).next };
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

describe.skipIf(!canRunServerSpawnTests)('/ws/sync two-client live sync e2e (HS-9437) (skipped: no tsx child-spawn / inside a Hot Sheet terminal)', () => {
  let hs: SpawnedHotSheet | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) { try { ws.close(); } catch { /* ignore */ } }
    if (hs !== null) {
      hs.proc.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      hs = null;
    }
  });

  it('client A mutation reaches client B; a reconnecting B replays what it missed via ?since', async () => {
    hs = spawnHotSheet();
    await hs.ready;
    const secret = readSecret(hs.dataDir);
    const base = `http://localhost:${hs.port}`;

    // Two clients connect and each gets its baseline `connected` frame.
    const a = openSync(hs.port, secret);
    const b = openSync(hs.port, secret);
    sockets.push(a.ws, b.ws);
    await Promise.all([waitOpen(a.ws), waitOpen(b.ws)]);
    await Promise.all([
      a.next((d) => d.type === 'connected'),
      b.next((d) => d.type === 'connected'),
    ]);

    // Client A mutates: create a ticket over HTTP.
    const created = await (await postJson(`${base}/api/tickets`, { title: 'sync-e2e A→B' }, secret)).json() as { id: number };
    expect(typeof created.id).toBe('number');

    // Client B receives the ticket-created event over its socket.
    const evt = await b.next((d) => d.type === 'ticket-created');
    const bSeq = evt.seq as number;
    expect(typeof bSeq).toBe('number');

    // ?since catch-up: B disconnects, another mutation happens, B reconnects
    // with its last seq and must replay the event it missed while away.
    b.ws.close();
    const second = await (await postJson(`${base}/api/tickets`, { title: 'sync-e2e missed' }, secret)).json() as { id: number };
    const b2 = openSync(hs.port, secret, bSeq);
    sockets.push(b2.ws);
    await waitOpen(b2.ws);
    const replayed = await b2.next((d) => d.type === 'ticket-created' && (d.seq as number) > bSeq);
    expect(replayed.seq as number).toBeGreaterThan(bSeq);
    expect(second.id).toBeGreaterThan(created.id);
  });
});
