/**
 * FOLLOW-UP-1 — event-loop watchdog. The kill path SIGKILLs the process, so it
 * is NEVER exercised in-process; instead the kill DECISION lives in the pure
 * `watchdogVerdict` (tested exhaustively here) and the worker replicates it. A
 * separate smoke test covers the start/stop lifecycle with a timeout large
 * enough that the worker can't fire during the test.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { externalCeilingBytes } from '../db/memoryCeiling.js';
import { _MAIN_SLOT_INDICES, _readMemorySlotsForTesting, _resetOpenClusterCounterForTesting, _WORKER_SLOT_INDICES, setOpenClusterCounter, startEventLoopWatchdog, stopEventLoopWatchdog, watchdogVerdict } from './watchdog.js';

describe('watchdogVerdict', () => {
  const base = { timeoutMs: 60_000, wakeGapMs: 10_000, armed: true };

  it('healthy loop with a fresh heartbeat → armed-ok', () => {
    expect(watchdogVerdict({ ...base, ownGapMs: 2000, heartbeatAgeMs: 1500 })).toBe('armed-ok');
  });

  it('heartbeat stale past the timeout → kill', () => {
    expect(watchdogVerdict({ ...base, ownGapMs: 2000, heartbeatAgeMs: 61_000 })).toBe('kill');
  });

  it('does NOT kill at exactly the timeout (strict >)', () => {
    expect(watchdogVerdict({ ...base, ownGapMs: 2000, heartbeatAgeMs: 60_000 })).toBe('armed-ok');
  });

  it('suspend/resume (huge self-gap) is skipped, never a kill', () => {
    // Both the heartbeat AND the checker were frozen by a sleep — the stale
    // heartbeat must NOT be read as a wedge.
    expect(watchdogVerdict({ ...base, ownGapMs: 300_000, heartbeatAgeMs: 300_000 })).toBe('suspend-skip');
  });

  it('suspend guard takes precedence over the kill threshold', () => {
    // Self-gap at the wake threshold wins even though the heartbeat age alone
    // would kill — the checker just resumed, so we can't trust the staleness.
    expect(watchdogVerdict({ ...base, ownGapMs: 10_000, heartbeatAgeMs: 999_999 })).toBe('suspend-skip');
  });

  it('unarmed heartbeat (0) → not-armed (no kill)', () => {
    expect(watchdogVerdict({ ...base, ownGapMs: 2000, heartbeatAgeMs: 0, armed: false })).toBe('not-armed');
  });
});

describe('start/stop lifecycle', () => {
  afterEach(() => { stopEventLoopWatchdog(); });

  it('starts and stops cleanly and is idempotent', () => {
    // 10-minute timeout so the worker can never fire while the test runs.
    expect(() => startEventLoopWatchdog({ timeoutMs: 600_000 })).not.toThrow();
    expect(() => startEventLoopWatchdog({ timeoutMs: 600_000 })).not.toThrow(); // second call is a no-op
    expect(() => stopEventLoopWatchdog()).not.toThrow();
    expect(() => stopEventLoopWatchdog()).not.toThrow(); // idempotent
  });

  it('honors HOTSHEET_DISABLE_WATCHDOG=1 (no worker spawned)', () => {
    const prev = process.env.HOTSHEET_DISABLE_WATCHDOG;
    process.env.HOTSHEET_DISABLE_WATCHDOG = '1';
    try {
      expect(() => startEventLoopWatchdog({ timeoutMs: 600_000 })).not.toThrow();
      expect(() => stopEventLoopWatchdog()).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.HOTSHEET_DISABLE_WATCHDOG;
      else process.env.HOTSHEET_DISABLE_WATCHDOG = prev;
    }
  });
});

/**
 * HS-9421 — the watchdog lives in a WORKER THREAD, where `process.memoryUsage()`
 * reports the worker's own V8 isolate, not the wedged main thread's. So the main
 * thread publishes its memory through the same SharedArrayBuffer the heartbeat
 * uses — the one channel that still works once the loop is pinned.
 */
describe('memory publishing (HS-9421)', () => {
  afterEach(() => {
    stopEventLoopWatchdog();
    _resetOpenClusterCounterForTesting();
    delete process.env.HOTSHEET_DISABLE_WATCHDOG;
  });

  it('publishes the main thread\'s memory into the shared slots on start', () => {
    setOpenClusterCounter(() => 7);
    startEventLoopWatchdog({});
    const slots = _readMemorySlotsForTesting();
    expect(slots, 'watchdog did not start / no view').not.toBeNull();
    // Real numbers, not placeholders — a test process still has an rss + a limit.
    expect(slots!.rssMb).toBeGreaterThan(0);
    expect(slots!.heapLimitMb).toBeGreaterThan(0);
    expect(slots!.openClusters).toBe(7);
    // HS-9478 — the discriminator. `arrayBuffers` counts Buffer/ArrayBuffer bytes
    // but NOT WASM heaps, so it is what separates "a Buffer/file-read allocator"
    // from "cluster WASM heaps" at the moment of a wedge. Published from the same
    // sample as the rest; a slot that is never written reads 0 forever and would
    // silently make every future crash look like the WASM case.
    expect(slots!.arrayBuffersMb).toBeTypeOf('number');
    expect(slots!.arrayBuffersMb).toBeGreaterThanOrEqual(0);
  });

  it('reports zero clusters when no counter is registered', () => {
    startEventLoopWatchdog({});
    expect(_readMemorySlotsForTesting()!.openClusters).toBe(0);
  });

  // HS-9559 — the FATAL line's denominator. It used to divide by V8's
  // heap_size_limit and call the result "% of the V8 limit", which for `external`
  // is meaningless (a WASM heap is malloc'd outside the old space, so that limit
  // neither bounds it nor aborts on it). The 2026-08-01 wedge was read as GC
  // thrash off exactly that line; the capture showed a WASM trap storm.
  it('publishes the cluster budget ceiling alongside — not instead of — the V8 limit', () => {
    startEventLoopWatchdog({});
    const slots = _readMemorySlotsForTesting()!;
    expect(slots.ceilingMb).toBe(Math.round(externalCeilingBytes() / (1024 * 1024)));
    // BOTH, because they answer different questions: the V8 limit bounds
    // heapUsed, the ceiling bounds external. A slot that is never written reads 0
    // forever, which would make the FATAL line divide by zero and report 0%.
    expect(slots.ceilingMb).toBeGreaterThan(0);
    expect(slots.heapLimitMb).toBeGreaterThan(0);
  });

  // The load-bearing one: the worker's source is a STRING, so it reads these
  // slots by numeric literal and cannot import the constants. If the two sides
  // drift, the FATAL line silently reports zeros — losing exactly the diagnostic
  // this feature exists to provide, at the only moment it matters.
  it('worker slot literals match the main-thread constants', () => {
    expect(_WORKER_SLOT_INDICES).toEqual(_MAIN_SLOT_INDICES);
  });
});
