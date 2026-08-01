// HS-9555 — the ceiling the cluster budget is measured against.
//
// The bug this closes is a *denominator* bug, so the tests are about which number
// gets used, not about eviction behavior (that lives in clusterEviction.test.ts).

import { afterEach, describe, expect, it } from 'vitest';

import {
  EXTERNAL_CEILING_ENV,
  externalCeilingBytes,
  MAX_EXTERNAL_CEILING_BYTES,
  resetExternalCeilingForTests,
  resolveExternalCeilingBytes,
} from './memoryCeiling.js';

const GB = 1024 * 1024 * 1024;
/** V8's default old-space limit on a 16 GB+ machine — the number that was
 *  silently acting as the ceiling before this module. */
const DEFAULT_HEAP_LIMIT = 4144 * 1024 * 1024;

afterEach(() => {
  Reflect.deleteProperty(process.env, EXTERNAL_CEILING_ENV);
  resetExternalCeilingForTests();
});

describe('resolveExternalCeilingBytes', () => {
  it('gives a 32 GB machine far more than V8s default old-space limit', () => {
    // The whole incident: 32 GB of RAM, kernel pressure `normal`, and Hot Sheet
    // budgeting against 4144 MB because that happened to be `heap_size_limit`.
    const ceiling = resolveExternalCeilingBytes({
      totalMemBytes: 32 * GB,
      heapLimitBytes: DEFAULT_HEAP_LIMIT,
    });
    expect(ceiling).toBe(8 * GB);
    expect(ceiling).toBeGreaterThan(DEFAULT_HEAP_LIMIT);
  });

  it('leaves room between a full cache and the headroom guard', () => {
    // This is the property that actually stops the spiral, so assert it directly
    // rather than trusting the fraction. A full cache is maxOpen 10 +
    // maxTelemetryOpen 6 = 16 clusters x ~180 MB; the guard fires at
    // `ceiling - headroomFloorBytes` (768 MB). Under the old 4144 MB ceiling the
    // gap was ~480 MB — under three clusters, and less than the uncollected heaps
    // that always exist between forced GCs, so the guard fired during NORMAL
    // operation with a full cache.
    const fullCache = 16 * 180 * 1024 * 1024;
    const headroomFloor = 768 * 1024 * 1024;

    const oldGap = DEFAULT_HEAP_LIMIT - headroomFloor - fullCache;
    const newGap = resolveExternalCeilingBytes({
      totalMemBytes: 32 * GB, heapLimitBytes: DEFAULT_HEAP_LIMIT,
    }) - headroomFloor - fullCache;

    expect(oldGap).toBeLessThan(3 * 180 * 1024 * 1024); // the bug
    expect(newGap).toBeGreaterThan(4 * GB); // the fix
  });

  it('never gives a machine LESS than it had before — the heap limit is a floor', () => {
    // A fraction-of-RAM rule alone would TIGHTEN small machines: 8 GB x 25% = 2 GB,
    // below the old-space limit such a machine already had. Flooring makes the
    // change monotonic, so no install can regress.
    const ceiling = resolveExternalCeilingBytes({
      totalMemBytes: 8 * GB,
      heapLimitBytes: DEFAULT_HEAP_LIMIT,
    });
    expect(ceiling).toBe(DEFAULT_HEAP_LIMIT);
  });

  it('caps a very large machine', () => {
    expect(resolveExternalCeilingBytes({
      totalMemBytes: 512 * GB,
      heapLimitBytes: DEFAULT_HEAP_LIMIT,
    })).toBe(MAX_EXTERNAL_CEILING_BYTES);
  });

  it('honors an explicit override, including one BELOW the floor', () => {
    // Someone setting this is tuning deliberately (a constrained container, a
    // repro). Silently raising it to the floor would make the knob look broken.
    expect(resolveExternalCeilingBytes({
      totalMemBytes: 32 * GB, heapLimitBytes: DEFAULT_HEAP_LIMIT, override: String(2 * GB),
    })).toBe(2 * GB);
  });

  it('ignores a blank or unparseable override rather than producing NaN', () => {
    // A NaN ceiling would make every headroom comparison false and silently
    // disable the guard entirely.
    for (const override of ['', '   ', 'lots', '-1', '0']) {
      const ceiling = resolveExternalCeilingBytes({
        totalMemBytes: 32 * GB, heapLimitBytes: DEFAULT_HEAP_LIMIT, override,
      });
      expect(Number.isFinite(ceiling), override).toBe(true);
      expect(ceiling, override).toBe(8 * GB);
    }
  });

  it('falls back to the heap limit when machine RAM is unreadable', () => {
    for (const totalMemBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveExternalCeilingBytes({
        totalMemBytes, heapLimitBytes: DEFAULT_HEAP_LIMIT,
      }), String(totalMemBytes)).toBe(DEFAULT_HEAP_LIMIT);
    }
  });

  it('still returns something usable when BOTH inputs are unreadable', () => {
    const ceiling = resolveExternalCeilingBytes({ totalMemBytes: Number.NaN, heapLimitBytes: 0 });
    expect(Number.isFinite(ceiling)).toBe(true);
    expect(ceiling).toBeGreaterThan(0);
  });
});

describe('externalCeilingBytes', () => {
  it('memoizes, and re-reads the env after a reset', () => {
    process.env[EXTERNAL_CEILING_ENV] = String(3 * GB);
    expect(externalCeilingBytes()).toBe(3 * GB);

    // Changing the env without a reset must NOT change the answer — an eviction
    // decision mid-process should not shift under a caller's feet.
    process.env[EXTERNAL_CEILING_ENV] = String(9 * GB);
    expect(externalCeilingBytes()).toBe(3 * GB);

    resetExternalCeilingForTests();
    expect(externalCeilingBytes()).toBe(9 * GB);
  });

  it('reports a positive ceiling on the real machine', () => {
    expect(externalCeilingBytes()).toBeGreaterThan(0);
  });
});
