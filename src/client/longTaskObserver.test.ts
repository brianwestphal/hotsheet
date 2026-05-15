// @vitest-environment happy-dom
/**
 * HS-8054 — long-task observer unit tests.
 *
 * The real `PerformanceObserver` callback is hard to fire from
 * happy-dom (the browser only invokes it from the rendering pipeline,
 * which the JSDOM-style environment doesn't run). So these tests cover:
 *   - the interaction-buffer ring + truncation at the size cap
 *   - the long-task buffer ring + truncation at the size cap
 *   - the interaction-window correlation (a long task includes the
 *     interactions that fired in the window leading up to it; older
 *     ones are excluded)
 *   - the console output format the user will see in DevTools
 *   - feature-detect inertness when `PerformanceObserver` is missing
 *   - HS-8054 follow-up — heartbeat-based detector init, init-log
 *     output, source-tagged long tasks, and the toast-on-long-tasks
 *     rate limiter
 */
import { afterEach, beforeEach,describe, expect, it, type MockInstance, vi } from 'vitest';

import {
  _getInteractionBufferForTesting,
  _getLongTaskBufferForTesting,
  _recordLongTaskForTesting,
  _resetLongTaskObserverForTesting,
  computeHeartbeatTick,
  initLongTaskObserver,
  recordInteraction,
  shouldEmitFreezeToast,
} from './longTaskObserver.js';

describe('longTaskObserver (HS-8054)', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;
  let logSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    _resetLongTaskObserverForTesting();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // HS-8164 — init line moved from `console.error` to `console.log`,
    // so freeze events still hit `errorSpy` but the init startup tick
    // now lands on `logSpy`. Both spies live for the whole describe so
    // each test can assert against the right surface.
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    _resetLongTaskObserverForTesting();
  });

  /** Pull only the long-task console lines (NOT the init log). HS-8054
   *  follow-up — init originally emitted its own startup line on
   *  `console.error`; HS-8164 (2026-05-15) demoted it to `console.log`,
   *  so init no longer hits the errorSpy at all. The filter is kept
   *  for defense-in-depth (timestamp prefix only matches recorded
   *  freezes), but in practice every error call is now a freeze. */
  function longTaskCalls(): string[] {
    return errorSpy.mock.calls
      .map(c => String(c[0]))
      .filter(s => /\[hotsheet longtask\] \d{2}:/.test(s));
  }

  describe('recordInteraction', () => {
    it('appends to the interaction buffer with a timestamp', () => {
      recordInteraction('drawer-tab:terminal:default');
      const buf = _getInteractionBufferForTesting();
      expect(buf).toHaveLength(1);
      expect(buf[0].label).toBe('drawer-tab:terminal:default');
      expect(typeof buf[0].ts).toBe('number');
      expect(buf[0].ts).toBeGreaterThanOrEqual(0);
    });

    it('truncates to the buffer size cap (30) when more interactions are recorded', () => {
      for (let i = 0; i < 50; i += 1) recordInteraction(`event-${i}`);
      const buf = _getInteractionBufferForTesting();
      expect(buf).toHaveLength(30);
      // Oldest dropped, newest kept.
      expect(buf[0].label).toBe('event-20');
      expect(buf[29].label).toBe('event-49');
    });
  });

  describe('long task recording', () => {
    it('records a long task with formatted wall clock + duration + source', () => {
      recordInteraction('drawer-tab:terminal:claude');
      _recordLongTaskForTesting(523);
      const buf = _getLongTaskBufferForTesting();
      expect(buf).toHaveLength(1);
      expect(buf[0].durationMs).toBe(523);
      expect(buf[0].source).toBe('observer');
      expect(buf[0].wallClock).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('emits a console.error with the canonical user-facing format', () => {
      recordInteraction('project-switch:Hot Sheet');
      _recordLongTaskForTesting(723);
      const lines = longTaskCalls();
      expect(lines).toHaveLength(1);
      // Format: `[hotsheet longtask] HH:MM:SS.mmm — 723ms [observer] (recent: project-switch:Hot Sheet @-Nms)`
      expect(lines[0]).toMatch(/^\[hotsheet longtask\] \d{2}:\d{2}:\d{2}\.\d{3} — 723ms \[observer\] \(recent: project-switch:Hot Sheet @-\d+ms\)$/);
    });

    it('source tag is `heartbeat` when caught by the heartbeat detector (HS-8054 follow-up)', () => {
      _recordLongTaskForTesting(180, 'heartbeat');
      const buf = _getLongTaskBufferForTesting();
      expect(buf[0].source).toBe('heartbeat');
      const lines = longTaskCalls();
      expect(lines[0]).toContain('[heartbeat]');
    });

    it('says "no recent interactions" when the buffer is empty', () => {
      _recordLongTaskForTesting(150);
      const lines = longTaskCalls();
      expect(lines[0]).toContain('(recent: no recent interactions)');
    });

    it('includes interactions from before the long task started but excludes very old ones', async () => {
      recordInteraction('old-event');
      // Wait long enough that the next interaction's relative offset is
      // measurable. happy-dom's `performance.now()` advances with real
      // time so a 50 ms wait gives us a delta.
      await new Promise(r => setTimeout(r, 50));
      recordInteraction('recent-event');
      _recordLongTaskForTesting(80);
      const lines = longTaskCalls();
      // Both should be in window (50 ms + 80 ms = 130 ms, well under 2 s cap).
      expect(lines[0]).toContain('old-event');
      expect(lines[0]).toContain('recent-event');
    });

    it('truncates the long-task buffer to size cap (50)', () => {
      for (let i = 0; i < 60; i += 1) _recordLongTaskForTesting(120);
      const buf = _getLongTaskBufferForTesting();
      expect(buf).toHaveLength(50);
    });
  });

  describe('initLongTaskObserver', () => {
    it('emits a startup line so the user can verify wiring (HS-8054 follow-up — HS-8164 demoted to console.log)', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      class FakePO {
        static supportedEntryTypes = ['longtask'];
        observe = vi.fn();
        disconnect = vi.fn();
      }
      (globalThis as Record<string, unknown>).PerformanceObserver = FakePO;
      try {
        initLongTaskObserver();
        // HS-8164 — init line now lands on console.log, not console.error.
        // The startup line is a benign per-page-load tick; leaving it on
        // console.error coloured every reload red in DevTools.
        const initLines = logSpy.mock.calls
          .map(c => String(c[0]))
          .filter(s => /\[hotsheet longtask\] init —/.test(s));
        expect(initLines).toHaveLength(1);
        expect(initLines[0]).toContain('observer:on');
        expect(initLines[0]).toContain('heartbeat:on');
        expect(initLines[0]).toContain('threshold:100ms');
        // And explicitly NOT on console.error — that surface is reserved
        // for actual freeze events.
        expect(
          errorSpy.mock.calls.some(c => /\[hotsheet longtask\] init —/.test(String(c[0]))),
        ).toBe(false);
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });

    it('startup line says `observer:off` when PerformanceObserver is undefined (HS-8054 follow-up — HS-8164 demoted to console.log)', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      (globalThis as Record<string, unknown>).PerformanceObserver = undefined;
      try {
        initLongTaskObserver();
        const initLines = logSpy.mock.calls
          .map(c => String(c[0]))
          .filter(s => /\[hotsheet longtask\] init —/.test(s));
        expect(initLines).toHaveLength(1);
        expect(initLines[0]).toContain('observer:off');
        // Heartbeat path is independent of PerformanceObserver and
        // continues to run.
        expect(initLines[0]).toContain('heartbeat:on');
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });

    it('is idempotent — calling twice does not double-register', () => {
      initLongTaskObserver();
      initLongTaskObserver();
      // After init, clear the spy and verify a single recorded long-task
      // produces a single console.error call.
      errorSpy.mockClear();
      _recordLongTaskForTesting(200);
      expect(longTaskCalls()).toHaveLength(1);
    });

    it('exposes the window-global retrieval helpers when the observer attaches', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      class FakePO {
        static supportedEntryTypes = ['longtask', 'paint'];
        observe = vi.fn();
        disconnect = vi.fn();
      }
      (globalThis as Record<string, unknown>).PerformanceObserver = FakePO;
      try {
        initLongTaskObserver();
        const w = window as unknown as {
          __hotsheetGetLongTasks?: () => unknown[];
          __hotsheetGetInteractions?: () => unknown[];
          __hotsheetClearLongTasks?: () => void;
        };
        expect(typeof w.__hotsheetGetLongTasks).toBe('function');
        expect(typeof w.__hotsheetGetInteractions).toBe('function');
        expect(typeof w.__hotsheetClearLongTasks).toBe('function');
        _recordLongTaskForTesting(180);
        const tasks = w.__hotsheetGetLongTasks?.() ?? [];
        expect(tasks).toHaveLength(1);
        w.__hotsheetClearLongTasks?.();
        expect(w.__hotsheetGetLongTasks?.()).toHaveLength(0);
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });

    it('window globals + recordInteraction still work even when PerformanceObserver is undefined (heartbeat-only path, HS-8054 follow-up)', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      (globalThis as Record<string, unknown>).PerformanceObserver = undefined;
      try {
        initLongTaskObserver();
        // recordInteraction still works even without the observer.
        recordInteraction('no-observer');
        expect(_getInteractionBufferForTesting()).toHaveLength(1);
        // Window globals are still wired (the heartbeat path enables
        // them too, since the diagnostic surface should always exist).
        const w = window as unknown as { __hotsheetGetLongTasks?: () => unknown[] };
        expect(typeof w.__hotsheetGetLongTasks).toBe('function');
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });

    describe('computeHeartbeatTick — visibility gating (HS-8173)', () => {
      it('returns reportBlockMs = null when the tab is hidden, regardless of elapsed', () => {
        // Even a 1000 ms gap (matches the throttled-tab cadence that
        // produced the user\'s 24 s false-positive cluster) must not
        // report when isVisible is false.
        const result = computeHeartbeatTick(11000, 10000, false);
        expect(result.reportBlockMs).toBeNull();
        // newLastTs still advances so the next visible fire isn\'t
        // measured against a stale timestamp.
        expect(result.newLastTs).toBe(11000);
      });

      it('returns reportBlockMs = null when visible but block is below the threshold', () => {
        // Elapsed 100 ms, expected 50 ms → block of 50 ms (under 100 ms threshold).
        const result = computeHeartbeatTick(10100, 10000, true);
        expect(result.reportBlockMs).toBeNull();
        expect(result.newLastTs).toBe(10100);
      });

      it('returns the block duration when visible AND above the threshold', () => {
        // Elapsed 200 ms, expected 50 ms → 150 ms block (≥ 100 ms threshold).
        const result = computeHeartbeatTick(10200, 10000, true);
        expect(result.reportBlockMs).toBe(150);
        expect(result.newLastTs).toBe(10200);
      });

      it('subtracts the expected 50 ms heartbeat interval so the report matches PerformanceObserver semantics', () => {
        // Elapsed 1000 ms (a real 1 s freeze) → reported as 950 ms block,
        // not 1000 ms. The user\'s freeze.log entries showed durationMs
        // values consistent with this subtraction (e.g. throttled ticks
        // at 1000 ms elapsed reported as ~950 ms).
        const result = computeHeartbeatTick(11000, 10000, true);
        expect(result.reportBlockMs).toBe(950);
      });

      it('exactly at the 100 ms threshold reports (>=, not >)', () => {
        // Elapsed 150 ms → 100 ms block.
        const result = computeHeartbeatTick(10150, 10000, true);
        expect(result.reportBlockMs).toBe(100);
      });
    });

    it('does NOT call observe() when longtask is not in supportedEntryTypes (PerformanceObserver path bails, heartbeat still runs)', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      const observeSpy = vi.fn();
      class FakePO {
        static supportedEntryTypes = ['paint', 'measure'];
        observe = observeSpy;
        disconnect = vi.fn();
      }
      (globalThis as Record<string, unknown>).PerformanceObserver = FakePO;
      try {
        initLongTaskObserver();
        expect(observeSpy).not.toHaveBeenCalled();
        // The init line says observer:off because longtask wasn't in
        // supportedEntryTypes. HS-8164 — init lines land on console.log.
        const initLines = logSpy.mock.calls
          .map(c => String(c[0]))
          .filter(s => /\[hotsheet longtask\] init —/.test(s));
        expect(initLines[0]).toContain('observer:off');
        expect(initLines[0]).toContain('heartbeat:on');
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });
  });

  /**
   * HS-8162 — pure helper tests for the toast-gate decision. The
   * gate combines three conditions; this describe pins every
   * combination so a future refactor can't drop one of them silently.
   * Integration with the live `state.settings.diagnostics_freeze_toast_enabled`
   * flag is covered by `recordLongTask` reading the same flag —
   * tested via manual UI flow + the gated freeze.log POST keeps firing.
   */
  describe('shouldEmitFreezeToast (HS-8162)', () => {
    it('returns false when the gate is off, regardless of duration', () => {
      expect(shouldEmitFreezeToast(800, 100_000, 0, false)).toBe(false);
      expect(shouldEmitFreezeToast(5000, 100_000, 0, false)).toBe(false);
    });

    it('returns false when duration is under the 500 ms toast threshold', () => {
      expect(shouldEmitFreezeToast(200, 100_000, 0, true)).toBe(false);
      expect(shouldEmitFreezeToast(499, 100_000, 0, true)).toBe(false);
    });

    it('returns true when gate is on, duration is over the threshold, and the rate-limit window has elapsed', () => {
      expect(shouldEmitFreezeToast(500, 100_000, 0, true)).toBe(true);
      expect(shouldEmitFreezeToast(800, 100_000, 50_000, true)).toBe(true);
    });

    it('returns false when the rate-limit window (10 s) has NOT elapsed since the last toast', () => {
      // nowTs - lastToastTs = 5000 ms < 10_000 ms rate-limit.
      expect(shouldEmitFreezeToast(800, 105_000, 100_000, true)).toBe(false);
    });

    it('returns true when the rate-limit window has elapsed exactly to the boundary', () => {
      // nowTs - lastToastTs = 10_000 ms exactly — `>=` passes.
      expect(shouldEmitFreezeToast(800, 110_000, 100_000, true)).toBe(true);
    });
  });
});
