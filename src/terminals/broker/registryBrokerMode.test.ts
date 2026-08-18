/**
 * HS-9662 / docs/136 phase 2 — end-to-end test of the REGISTRY ↔ broker path in
 * broker mode, headless-safe: an in-process `PtyBroker` with a FAKE pty factory
 * and a NO-OP process-tree killer (so no real process is spawned or signalled —
 * the src/terminals kill hazard is fully avoided). Proves: spawn-through-registry,
 * data → subscriber, survival + re-adoption across a simulated server restart, and
 * explicit close removing the broker session.
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type * as RegistryNs from '../registry.js';
import type * as BrokerModeNs from '../registry/brokerMode.js';
import type { PtyLike, SpawnArgs } from '../registry/types.js';
import { PtyBroker } from './ptyBroker.js';

class FakePty implements PtyLike {
  readonly pid: number;
  cols: number; rows: number;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  constructor(pid: number, cols: number, rows: number) { this.pid = pid; this.cols = cols; this.rows = rows; }
  onData(cb: (d: string) => void): { dispose(): void } { this.dataCbs.push(cb); return { dispose: () => { this.dataCbs = this.dataCbs.filter(c => c !== cb); } }; }
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void } { this.exitCbs.push(cb); return { dispose: () => { this.exitCbs = this.exitCbs.filter(c => c !== cb); } }; }
  write(): void { /* ignore */ }
  resize(c: number, r: number): void { this.cols = c; this.rows = r; }
  kill(): void { for (const cb of this.exitCbs) cb({ exitCode: 0 }); }
  emit(d: string): void { for (const cb of this.dataCbs) cb(d); }
}

const home = mkdtempSync(join(tmpdir(), 'hs-broker-home-'));
const dataDir = mkdtempSync(join(tmpdir(), 'hs-broker-data-'));
let broker: PtyBroker;
let prevHome: string | undefined;
let prevGate: string | undefined;

let reg: typeof RegistryNs;
let brokerMode: typeof BrokerModeNs;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error('waitFor timed out'); await new Promise(r => setTimeout(r, 10)); }
}
function fake(sessionId: string): FakePty {
  const p = broker.ptyForTest(sessionId);
  if (!p) throw new Error(`no live broker pty for ${sessionId}`);
  return p as FakePty;
}
const CFG = { id: 'claude', name: 'AI', command: 'echo hi' };

beforeAll(async () => {
  prevHome = process.env.HOTSHEET_HOME;
  prevGate = process.env.HOTSHEET_PTY_BROKER;
  process.env.HOTSHEET_HOME = home;
  process.env.HOTSHEET_PTY_BROKER = '1';
  brokerMode = await import('../registry/brokerMode.js');
  reg = await import('../registry.js');
  let nextPid = 5000;
  broker = new PtyBroker({
    leaseGraceMs: 0,
    killTree: () => { /* no-op: never signal real pids */ },
    spawnPty: (args: SpawnArgs) => new FakePty(nextPid++, args.cols, args.rows),
  });
  await broker.listen(brokerMode.brokerSocketPath());
});

afterAll(() => {
  reg.destroyAllTerminals(); // broker mode → disconnects, no kill
  broker.shutdown();
  if (prevHome === undefined) delete process.env.HOTSHEET_HOME; else process.env.HOTSHEET_HOME = prevHome;
  if (prevGate === undefined) delete process.env.HOTSHEET_PTY_BROKER; else process.env.HOTSHEET_PTY_BROKER = prevGate;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
});

describe('registry ↔ broker (broker mode, fake pty)', () => {
  it('gate is ON', () => { expect(reg.isBrokerMode()).toBe(true); });

  it('spawn-through-registry creates a broker session and streams data to a subscriber', async () => {
    await brokerMode.initBrokerMode();
    reg.ensureSpawned('secA', dataDir, 'claude', CFG);
    await waitFor(() => broker.ptyForTest('secA::claude') !== null);

    const received: Buffer[] = [];
    const res = reg.attach('secA', dataDir, { onData: (c) => received.push(c), onExit: () => { /* */ } }, { configOverride: CFG }, 'claude');
    expect(res.alive).toBe(true);
    fake('secA::claude').emit('hello-from-pty');
    await waitFor(() => Buffer.concat(received).toString().includes('hello-from-pty'));
  });

  it('survives a simulated server restart and re-adopts with scrollback', async () => {
    fake('secA::claude').emit('SCROLLBACK-MARKER\n');
    await new Promise(r => setTimeout(r, 40));
    // Simulate an accidental node-server death: `destroyAllTerminals` in broker
    // mode clears the LOCAL registry + disconnects but does NOT kill the broker's
    // PTYs (exactly what a fresh process sees — empty registry, live broker).
    reg.destroyAllTerminals();
    expect(broker.ptyForTest('secA::claude')).not.toBeNull(); // pty survived in the broker

    // Fresh server: re-init + re-adopt via the PER-PROJECT path (the one
    // eager-spawn uses as each project registers — covers lazy terminals, unlike a
    // post-restore sweep that races async restore).
    await brokerMode.initBrokerMode();
    const n = reg.readoptProjectBrokerSessions('secA', dataDir);
    expect(n).toBe(1);
    // A new attach replays the survived scrollback as history.
    const res = reg.attach('secA', dataDir, { onData: () => { /* */ }, onExit: () => { /* */ } }, { configOverride: CFG }, 'claude');
    expect(res.history.toString()).toContain('SCROLLBACK-MARKER');
    expect(res.alive).toBe(true);
  });

  it('explicit close removes the broker session', async () => {
    reg.destroyTerminal('secA', 'claude');
    await waitFor(() => broker.sessionInfos().every(s => s.sessionId !== 'secA::claude'));
    expect(broker.sessionInfos().some(s => s.sessionId === 'secA::claude')).toBe(false);
  });

  // HS-9694 — the re-adoption pool must be refreshable from the broker's CURRENT live
  // sessions (authoritative), not just the connect-time `welcome` snapshot. Closes the
  // idempotency gap where a second `initBrokerMode` (client already set) returns
  // `list()` WITHOUT repopulating the pool, which would leave a live PTY un-adopted.
  it('refreshSurvivedFromBroker re-enumerates live broker sessions into the pool', async () => {
    await brokerMode.initBrokerMode();
    reg.ensureSpawned('secR', dataDir, 'claude', CFG);
    await waitFor(() => broker.ptyForTest('secR::claude') !== null);

    // Already-adopted (isAdopted=true) → NOT re-added to the pool.
    await brokerMode.refreshSurvivedFromBroker((id) => id === 'secR::claude');
    expect(brokerMode.remainingSurvivedSessions().some(s => s.sessionId === 'secR::claude')).toBe(false);

    // A fresh server that hasn't adopted it (isAdopted=false) → the authoritative
    // re-query pulls the live session into the pool so the sweep can re-adopt it.
    await brokerMode.refreshSurvivedFromBroker(() => false);
    expect(brokerMode.remainingSurvivedSessions().some(s => s.sessionId === 'secR::claude' && s.alive)).toBe(true);

    reg.destroyTerminal('secR', 'claude');
  });
});
