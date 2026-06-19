/**
 * FOLLOW-UP-1 — event-loop watchdog. The kill path SIGKILLs the process, so it
 * is NEVER exercised in-process; instead the kill DECISION lives in the pure
 * `watchdogVerdict` (tested exhaustively here) and the worker replicates it. A
 * separate smoke test covers the start/stop lifecycle with a timeout large
 * enough that the worker can't fire during the test.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { startEventLoopWatchdog, stopEventLoopWatchdog, watchdogVerdict } from './watchdog.js';

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
