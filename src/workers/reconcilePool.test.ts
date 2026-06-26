// HS-9076 — the server worker-pool reconciler. Drives the orchestration with
// INJECTED prepare/spawn/reap stubs, so no real git worktrees, PTYs, or DB are
// touched (the pool registry is in-memory).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerLaunchSpec } from './launchWorker.js';
import { _resetPoolsForTesting, getPoolState, registerWorker, removeWorker, setTarget } from './poolManager.js';
import { type ReconcileDeps,reconcilePool } from './reconcilePool.js';
import { poolMax } from './suggestN.js';

const DD = '/proj/.hotsheet';
const REPO = '/proj';
const SECRET = 'sek';

/** prepare stub: derive a spec from the requested branch/label (no real worktree). */
const prepare: ReconcileDeps['prepare'] = (_repo, _dataDir, opts) => {
  const name = opts.label ?? 'w';
  return Promise.resolve<WorkerLaunchSpec>({
    worker: name, label: name, cwd: `/wt/${name}`,
    command: 'claude "/hotsheet-worker"', worktreeCreated: true,
  });
};
/** spawn stub: a fake server-tracked terminal id (no real PTY). */
const spawn: ReconcileDeps['spawn'] = (_secret, _dataDir, spec) => `term-${spec.worker}`;

beforeEach(() => { _resetPoolsForTesting(); });
afterEach(() => { _resetPoolsForTesting(); });

function reg(worker: string): void {
  registerWorker(DD, { worker, label: worker, worktreePath: `/wt/${worker}`, terminalId: `term-${worker}` });
}

describe('reconcilePool (HS-9076)', () => {
  it('scales UP toward the target (prepare → spawn → register)', async () => {
    setTarget(DD, 1);
    const prep = vi.fn(prepare); const spw = vi.fn(spawn);
    const res = await reconcilePool(SECRET, DD, REPO, { prepare: prep, spawn: spw, reap: vi.fn() });
    expect(res.spawned).toBe(1);
    expect(prep).toHaveBeenCalledTimes(1);
    expect(spw).toHaveBeenCalledTimes(1);
    // A slot was registered with the server-spawned terminal id.
    const w = getPoolState(DD).workers;
    expect(w).toHaveLength(1);
    expect(w[0].label).toBe('worker-1');
    expect(w[0].terminalId).toBe('term-worker-1');
  });

  it('is a no-op when already at target', async () => {
    reg('worker-1');
    setTarget(DD, 1);
    const prep = vi.fn(prepare);
    const res = await reconcilePool(SECRET, DD, REPO, { prepare: prep, spawn: vi.fn(spawn), reap: vi.fn() });
    expect(res).toMatchObject({ spawned: 0, drained: 0 });
    expect(prep).not.toHaveBeenCalled();
  });

  it('scales DOWN by draining the surplus (newest-first), gracefully', async () => {
    reg('worker-1'); reg('worker-2');
    setTarget(DD, 1);
    const res = await reconcilePool(SECRET, DD, REPO, { prepare: vi.fn(prepare), spawn: vi.fn(spawn), reap: vi.fn() });
    expect(res.drained).toBe(1);
    // The newest (higher seq) worker was drained, the older one kept.
    const drained = getPoolState(DD).workers.filter(w => w.drain);
    expect(drained.map(w => w.worker)).toEqual(['worker-2']);
  });

  it('reaps a stopped slot, then re-spawns to stay at target', async () => {
    reg('worker-1');
    getPoolState(DD).workers[0].stopped = true; // simulate a drained worker that acknowledged
    setTarget(DD, 1);
    // The reap stub mirrors the real reapWorker's effect: it drops the slot.
    const reap = vi.fn((_s: string, dataDir: string, _r: string, slot: { worker: string }) => {
      removeWorker(dataDir, slot.worker);
      return Promise.resolve();
    });
    const res = await reconcilePool(SECRET, DD, REPO, { prepare: vi.fn(prepare), spawn: vi.fn(spawn), reap });
    expect(res.reaped).toBe(1);
    expect(res.spawned).toBe(1); // replacement spawned after the reap
    expect(getPoolState(DD).workers.map(w => w.worker)).toEqual(['worker-1']); // fresh slot
  });

  it('clamps the scale-up to poolMax()', async () => {
    const max = poolMax();
    setTarget(DD, max + 5); // ask for more than allowed
    const spw = vi.fn(spawn);
    const res = await reconcilePool(SECRET, DD, REPO, { prepare: vi.fn(prepare), spawn: spw, reap: vi.fn() });
    expect(res.spawned).toBe(max);
    expect(spw).toHaveBeenCalledTimes(max);
    expect(getPoolState(DD).workers).toHaveLength(max);
  });

  it('a failing launch stops the up-loop without throwing', async () => {
    setTarget(DD, Math.min(2, poolMax()));
    const prep = vi.fn(() => Promise.reject(new Error('worktree boom')));
    const res = await reconcilePool(SECRET, DD, REPO, { prepare: prep, spawn: vi.fn(spawn), reap: vi.fn() });
    expect(res.spawned).toBe(0);
    expect(getPoolState(DD).workers).toHaveLength(0);
  });
});
