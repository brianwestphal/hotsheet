/**
 * HS-9479 — closing a PGLite cluster frees nothing until V8 collects, because a
 * WASM heap lives in `external` and `external` creates no heap pressure. Measured
 * in HS-9481: close 4 clusters and wait 5 s ⇒ 1197 MB still resident; force a
 * collection ⇒ 194 MB. This module is what makes the collection happen.
 */
import { describe, expect, it } from 'vitest';

import {
  forcedGcMinIntervalMs,
  forceGcNow,
  getForcedGc,
  resetForcedGcForTests,
  shouldForceGc,
} from './forceGc.js';

describe('shouldForceGc (HS-9479)', () => {
  it('always allows the first collection', () => {
    // A server that has just started and immediately evicts should not have to
    // wait out the interval before reclaiming anything.
    expect(shouldForceGc(null, 1_000, 30_000)).toBe(true);
  });

  it('throttles a second collection inside the interval', () => {
    // A forced major GC is stop-the-world; one per closed cluster would trade an
    // OOM for a stutter, which this project already treats as a defect (HS-9239).
    expect(shouldForceGc(1_000, 5_000, 30_000)).toBe(false);
  });

  it('allows one once the interval has elapsed', () => {
    expect(shouldForceGc(1_000, 31_000, 30_000)).toBe(true);
    expect(shouldForceGc(1_000, 1_000 + 30_000, 30_000)).toBe(true); // boundary
  });

  it('a zero interval disables the throttle entirely', () => {
    expect(shouldForceGc(1_000, 1_000, 0)).toBe(true);
  });
});

describe('forcedGcMinIntervalMs (HS-9479)', () => {
  it('defaults to 30s and honors a valid override', () => {
    delete process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
    expect(forcedGcMinIntervalMs()).toBe(30_000);
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '5000';
    expect(forcedGcMinIntervalMs()).toBe(5_000);
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '0'; // 0 = collect every time
    expect(forcedGcMinIntervalMs()).toBe(0);
    delete process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
  });

  it('ignores junk rather than disabling the throttle by accident', () => {
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = 'soon';
    expect(forcedGcMinIntervalMs()).toBe(30_000);
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '-1';
    expect(forcedGcMinIntervalMs()).toBe(30_000);
    delete process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
  });
});

describe('getForcedGc (HS-9479)', () => {
  it('obtains a collector without the process being launched with --expose-gc', () => {
    // The whole point of the `v8.setFlagsFromString` + `vm.runInNewContext` route:
    // adding `--expose-gc` to the npm bin, the Tauri sidecar spawn AND the dev
    // command separately would be three places to lose it.
    resetForcedGcForTests();
    expect(getForcedGc()).toBeTypeOf('function');
  });

  it('caches the lookup rather than redoing the flag dance per eviction', () => {
    resetForcedGcForTests();
    expect(getForcedGc()).toBe(getForcedGc());
  });
});

describe('forceGcNow (HS-9479)', () => {
  it('collects, then throttles, then collects again after the interval', () => {
    resetForcedGcForTests();
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '30000';
    try {
      expect(forceGcNow('/tmp/hs-gc-test', 1_000)).toBe('collected');
      expect(forceGcNow('/tmp/hs-gc-test', 2_000)).toBe('throttled');
      expect(forceGcNow('/tmp/hs-gc-test', 40_000)).toBe('collected');
    } finally {
      delete process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
    }
  });

  it('reports WHICH thing happened rather than silently doing nothing', () => {
    // 'throttled' and 'collected-but-freed-nothing' look identical from outside,
    // and that ambiguity is what made this bug survive so long (docs/128 §128.5.1).
    resetForcedGcForTests();
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '0';
    try {
      expect(['collected', 'unavailable']).toContain(forceGcNow('/tmp/hs-gc-test'));
    } finally {
      delete process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
    }
  });

  it('actually reclaims external memory — the behavior, not just the plumbing', () => {
    // The claim this whole ticket rests on. Allocate off-heap, drop it, and assert
    // a forced collection returns it. A test of the call alone would pass even if
    // the acquired function were a no-op.
    resetForcedGcForTests();
    process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS = '0';
    try {
      let bufs: (Buffer | null)[] = [];
      for (let i = 0; i < 24; i++) bufs.push(Buffer.allocUnsafeSlow(8 * 1024 * 1024)); // ~192 MB
      const peak = process.memoryUsage().external;
      bufs = [];
      expect(forceGcNow('/tmp/hs-gc-test')).toBe('collected');
      const after = process.memoryUsage().external;
      expect(after, `external should drop after a forced collection (peak ${String(peak)})`).toBeLessThan(peak);
    } finally {
      delete process.env.HOTSHEET_FORCED_GC_MIN_INTERVAL_MS;
      resetForcedGcForTests();
    }
  });
});
