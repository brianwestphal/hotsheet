/**
 * HS-9694 — `PtyBroker.bind` must NOT orphan a live broker on an EADDRINUSE conflict.
 *
 * The bug: the old entry-point unconditionally unlinked + rebound the socket on
 * EADDRINUSE. When a fresh server's `connect()` spawned a competing broker (on a
 * transient first-attempt failure), that broker unlinked the LIVE broker's socket and
 * rebound — orphaning the broker holding the PTYs. The re-adopting server then talked
 * to the empty new broker → welcome empty → re-adopted 0 → `/api/terminal/list` = 0
 * while the real PTYs stayed alive but unreachable.
 *
 * The fix: on EADDRINUSE, probe liveness — DEFER to a live broker (leave its socket
 * alone); only unlink + rebind a genuinely stale socket.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PtyLike, SpawnArgs } from '../registry/types.js';
import { brokerSocketIsLive, PtyBroker } from './ptyBroker.js';

class FakePty implements PtyLike {
  readonly pid: number;
  cols: number; rows: number;
  constructor(pid: number, cols: number, rows: number) { this.pid = pid; this.cols = cols; this.rows = rows; }
  onData(): { dispose(): void } { return { dispose: () => { /* */ } }; }
  onExit(): { dispose(): void } { return { dispose: () => { /* */ } }; }
  write(): void { /* */ }
  resize(c: number, r: number): void { this.cols = c; this.rows = r; }
  kill(): void { /* */ }
}

function newBroker(): PtyBroker {
  let pid = 6000;
  return new PtyBroker({
    leaseGraceMs: 0,
    killTree: () => { /* never signal real pids */ },
    spawnPty: (a: SpawnArgs) => new FakePty(pid++, a.cols, a.rows),
  });
}

describe('PtyBroker.bind — EADDRINUSE resolution (HS-9694)', () => {
  let dir: string;
  let sock: string;
  const brokers: PtyBroker[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-brokerbind-'));
    sock = join(dir, 'pty-broker.sock');
  });

  afterEach(() => {
    for (const b of brokers.splice(0)) { try { b.shutdown(); } catch { /* */ } }
    rmSync(dir, { recursive: true, force: true });
  });

  it('binds a free socket', async () => {
    const a = newBroker(); brokers.push(a);
    expect(await a.bind(sock)).toBe(true);
    expect(existsSync(sock)).toBe(true);
  });

  it('DEFERS to a live broker (returns false, leaves its socket untouched)', async () => {
    const a = newBroker(); brokers.push(a);
    expect(await a.bind(sock)).toBe(true);
    expect(await brokerSocketIsLive(sock)).toBe(true);

    // A competing broker tries to bind the SAME socket — the real bug's trigger.
    const b = newBroker(); brokers.push(b);
    expect(await b.bind(sock)).toBe(false); // defers via the real liveness probe

    // The live broker A is untouched — still listening on the same socket (not
    // unlinked + orphaned, which was the bug).
    expect(await brokerSocketIsLive(sock)).toBe(true);
  });

  it('rebinds a genuinely STALE socket file (nothing listening) and succeeds', async () => {
    // A leftover socket file with no listener → listen() gives EADDRINUSE, the probe
    // gets ECONNREFUSED → the broker unlinks it and rebinds.
    writeFileSync(sock, '', 'utf-8');
    expect(existsSync(sock)).toBe(true);
    const a = newBroker(); brokers.push(a);
    expect(await a.bind(sock)).toBe(true);
    expect(existsSync(sock)).toBe(true); // now a real listening socket
  });

  it('with an injected liveness probe: live → defer, stale → rebind', async () => {
    const a = newBroker(); brokers.push(a);
    expect(await a.bind(sock)).toBe(true);

    const live = newBroker(); brokers.push(live);
    expect(await live.bind(sock, { socketIsLive: () => Promise.resolve(true) })).toBe(false);

    // Injected "stale" verdict → it unlinks A's socket and rebinds (A is orphaned,
    // which is exactly what the DEFAULT probe prevents — here we force the old path).
    const stale = newBroker(); brokers.push(stale);
    expect(await stale.bind(sock, { socketIsLive: () => Promise.resolve(false) })).toBe(true);
  });
});
