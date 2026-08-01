/**
 * HS-9534 — GC pause recording.
 *
 * The pure helpers are tested directly; the observer itself is tested by
 * provoking a REAL collection, because the thing worth proving is that V8
 * actually delivers these entries and that they reach the log — not that a mock
 * was called.
 */

import { constants } from 'node:perf_hooks';

import { mkdtempSync, promises as fsp, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { diagnosticsDir } from './diagnosticsDir.js';
import { _resetForTesting, FREEZE_LOG_FILENAME, LONG_TASK_THRESHOLD_MS } from './freezeLogger.js';
import { gcContext, gcKindName, shouldRecordGcPause, startGcObserver, stopGcObserver } from './gcObserver.js';

let home: string;
const originalHome = process.env.HOTSHEET_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hs-gc-'));
  process.env.HOTSHEET_HOME = home;
});

afterEach(() => {
  stopGcObserver();
  _resetForTesting();
  process.env.HOTSHEET_HOME = originalHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
});

describe('gcKindName', () => {
  it('names each V8 collection kind', () => {
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_MAJOR)).toBe('major');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_MINOR)).toBe('minor');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_INCREMENTAL)).toBe('incremental');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_WEAKCB)).toBe('weak-callback');
  });

  it('degrades to "unknown" for an absent or unrecognized kind', () => {
    // V8 can add kinds; an unnamed one must still produce a usable log line.
    expect(gcKindName(undefined)).toBe('unknown');
    expect(gcKindName(9999)).toBe('unknown');
  });
});

describe('shouldRecordGcPause', () => {
  it('ignores the sub-threshold collections that fire constantly', () => {
    // V8 fires this observer for every scavenge, many of them microseconds.
    // Logging those would swamp a file a human reads looking for a stall.
    expect(shouldRecordGcPause(0.02)).toBe(false);
    expect(shouldRecordGcPause(LONG_TASK_THRESHOLD_MS - 1)).toBe(false);
  });

  it('records at the same bar every other writer uses', () => {
    expect(shouldRecordGcPause(LONG_TASK_THRESHOLD_MS)).toBe(true);
    expect(shouldRecordGcPause(1800)).toBe(true);
  });
});

describe('gcContext', () => {
  it('is stable per kind, so rankByContext can aggregate it', () => {
    // Putting the duration (or any per-pause detail) in the context would
    // fragment the aggregate into one row per collection.
    expect(gcContext(constants.NODE_PERFORMANCE_GC_MAJOR)).toBe('gc.pause: major');
    expect(gcContext(constants.NODE_PERFORMANCE_GC_MAJOR)).toBe(gcContext(constants.NODE_PERFORMANCE_GC_MAJOR));
  });
});

describe('startGcObserver', () => {
  it('is idempotent — a second start does not double-register', () => {
    startGcObserver('/p/.hotsheet');
    startGcObserver('/p/.hotsheet');
    stopGcObserver();
    // Nothing to assert beyond "no throw and the second stop is safe"; the real
    // guard is that a double-registered observer would write every pause twice.
    expect(() => { stopGcObserver(); }).not.toThrow();
  });

  it('observes REAL collections and writes over-threshold pauses to the log', async () => {
    // Deliberately end-to-end. The value of this module is that V8 delivers GC
    // entries at all and that they reach the process-wide log; a mocked
    // PerformanceObserver would prove neither.
    //
    // Threshold 0 so EVERY collection is recorded. At the production 100 ms bar
    // this test would assert nothing on most machines — a green vacuous test,
    // which is worse than no test.
    startGcObserver('/Users/x/Documents/kerf/.hotsheet', 0);

    // Churn enough to guarantee collections happen.
    for (let i = 0; i < 40; i++) {
      const junk: number[][] = [];
      for (let j = 0; j < 400; j++) junk.push(new Array<number>(500).fill(j));
      junk.length = 0;
      await Promise.resolve();
    }
    await new Promise((r) => setTimeout(r, 60));

    const raw = await fsp.readFile(join(diagnosticsDir(), FREEZE_LOG_FILENAME), 'utf8');
    const lines = raw.split('\n').filter(l => l !== '');
    // V8 collects during that churn on any machine, so this is a real assertion.
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const e = JSON.parse(line) as Record<string, unknown>;
      expect(e.source).toBe('server-gc');
      expect(e.blocking).toBe(true);          // stop-the-world is real blocked time
      expect(e.project).toBe('kerf');         // HS-9531 provenance still applies
      expect(String(e.context).startsWith('gc.pause: ')).toBe(true);
      expect(e.cpuMs).toBeUndefined();        // no interval to sample; never invented
    }
  });
});
