// HS-8962 — worker-pool manager tests (docs/91 §91.2-91.4). Pure in-memory state:
// registration, graceful drain via the claim-next gate, and teardown.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetPoolsForTesting, cancelDrain, getPoolState, isQueueOnly, isSlotStale,
  onClaimNext, registerWorker, removeWorker, requestDrain, requestDrainAll,
  setQueueOnly, setTarget, STALE_AFTER_MS, touch,
} from './poolManager.js';

const DIR = '/proj/.hotsheet';
const reg = (worker: string, label = worker) =>
  registerWorker(DIR, { label, worker, worktreePath: `/wt/${worker}`, branch: `b/${worker}`, terminalId: `t-${worker}` });

beforeEach(() => _resetPoolsForTesting());
afterEach(() => _resetPoolsForTesting());

describe('worker-pool manager (HS-8962)', () => {
  it('registers workers in order and exposes them per project', () => {
    reg('w1'); reg('w2');
    const { workers } = getPoolState(DIR);
    expect(workers.map(w => w.worker)).toEqual(['w1', 'w2']);
    expect(workers[0]).toMatchObject({ label: 'w1', worktreePath: '/wt/w1', branch: 'b/w1', terminalId: 't-w1', drain: false, stopped: false });
    // Pools are isolated by data dir.
    expect(getPoolState('/other/.hotsheet').workers).toEqual([]);
  });

  it('re-registering the same worker keeps its slot order and resets flags', () => {
    reg('w1'); reg('w2');
    requestDrain(DIR, 'w1');
    onClaimNext(DIR, 'w1'); // flips w1 to stopped
    reg('w1'); // a fresh worker on the same identity
    const w1 = getPoolState(DIR).workers.find(w => w.worker === 'w1')!;
    expect(w1.seq).toBe(1);          // original order preserved
    expect(w1.drain).toBe(false);
    expect(w1.stopped).toBe(false);
  });

  it('drain → the worker is told to stop at its next claim-next, then is marked stopped', () => {
    reg('w1');
    // Before drain, claim-next proceeds normally.
    expect(onClaimNext(DIR, 'w1')).toEqual({ drain: false });
    expect(requestDrain(DIR, 'w1')).toBe(true);
    // The draining worker's next pull returns drain and flips it to stopped.
    expect(onClaimNext(DIR, 'w1')).toEqual({ drain: true });
    expect(getPoolState(DIR).workers[0].stopped).toBe(true);
  });

  it('a worker NOT in the pool is never told to drain (manual /hotsheet-worker unaffected)', () => {
    expect(onClaimNext(DIR, 'manual-worker')).toEqual({ drain: false });
  });

  it('cancelDrain reverts a pending drain but not an already-stopped worker', () => {
    reg('w1');
    requestDrain(DIR, 'w1');
    expect(cancelDrain(DIR, 'w1')).toBe(true);
    expect(onClaimNext(DIR, 'w1')).toEqual({ drain: false }); // claims again
    // Once stopped, it can't be revived.
    requestDrain(DIR, 'w1');
    onClaimNext(DIR, 'w1');
    expect(cancelDrain(DIR, 'w1')).toBe(false);
  });

  it('requestDrainAll drains every active worker and zeroes the target', () => {
    reg('w1'); reg('w2'); reg('w3');
    expect(requestDrainAll(DIR)).toBe(3);
    expect(getPoolState(DIR).workers.every(w => w.drain)).toBe(true);
    expect(getPoolState(DIR).targetN).toBe(0);
    // Idempotent — already-draining workers aren't recounted.
    expect(requestDrainAll(DIR)).toBe(0);
  });

  it('requestDrain / removeWorker report missing workers', () => {
    expect(requestDrain(DIR, 'nope')).toBe(false);
    reg('w1');
    expect(removeWorker(DIR, 'w1')).toBe(true);
    expect(removeWorker(DIR, 'w1')).toBe(false);
    expect(getPoolState(DIR).workers).toEqual([]);
  });

  it('setTarget clamps to a non-negative integer', () => {
    setTarget(DIR, 4);
    expect(getPoolState(DIR).targetN).toBe(4);
    setTarget(DIR, -2);
    expect(getPoolState(DIR).targetN).toBe(0);
  });

  describe('liveness / zombie detection (HS-8972)', () => {
    it('a slot goes stale past STALE_AFTER_MS, and touch refreshes it', () => {
      reg('w1');
      const t0 = getPoolState(DIR).workers[0].lastSeenAt;
      const slot = getPoolState(DIR).workers[0];
      expect(isSlotStale(slot, t0 + 1000)).toBe(false);
      expect(isSlotStale(slot, t0 + STALE_AFTER_MS + 1)).toBe(true);
      // A later sign of life clears staleness.
      touch(DIR, 'w1', t0 + STALE_AFTER_MS + 5000);
      const fresh = getPoolState(DIR).workers[0];
      expect(isSlotStale(fresh, t0 + STALE_AFTER_MS + 5000)).toBe(false);
    });

    it('a draining or stopped slot is never "stale" (it has its own cleanup path)', () => {
      reg('w1');
      requestDrain(DIR, 'w1');
      const draining = getPoolState(DIR).workers[0];
      expect(isSlotStale(draining, draining.lastSeenAt + STALE_AFTER_MS + 1)).toBe(false);
    });

    it('onClaimNext records liveness, and touch reports unknown workers', () => {
      reg('w1');
      touch(DIR, 'w1', 1); // backdate
      onClaimNext(DIR, 'w1');
      expect(getPoolState(DIR).workers[0].lastSeenAt).toBeGreaterThan(1);
      expect(touch(DIR, 'ghost')).toBe(false);
    });
  });

  describe('queue-only mode (HS-8975)', () => {
    it('defaults off, toggles on/off, and survives re-register', () => {
      reg('w1');
      expect(isQueueOnly(DIR, 'w1')).toBe(false);
      expect(setQueueOnly(DIR, 'w1', true)).toBe(true);
      expect(isQueueOnly(DIR, 'w1')).toBe(true);
      reg('w1'); // re-register (fresh worker, same identity) preserves the toggle
      expect(isQueueOnly(DIR, 'w1')).toBe(true);
      expect(getPoolState(DIR).workers[0].queueOnly).toBe(true);
      setQueueOnly(DIR, 'w1', false);
      expect(isQueueOnly(DIR, 'w1')).toBe(false);
    });

    it('reports false / returns false for an unknown worker', () => {
      expect(isQueueOnly(DIR, 'ghost')).toBe(false);
      expect(setQueueOnly(DIR, 'ghost', true)).toBe(false);
    });
  });
});
