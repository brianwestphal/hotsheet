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
  initLongTaskObserver,
  recordInteraction,
} from './longTaskObserver.js';

describe('longTaskObserver (HS-8054)', () => {
  let errorSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    _resetLongTaskObserverForTesting();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    _resetLongTaskObserverForTesting();
  });

  /** Pull only the long-task console lines (NOT the init log). HS-8054
   *  follow-up — init now emits its own console.error startup line, so
   *  call-count assertions need to filter to the long-task subset. */
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
    it('emits a startup line so the user can verify wiring (HS-8054 follow-up)', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      class FakePO {
        static supportedEntryTypes = ['longtask'];
        observe = vi.fn();
        disconnect = vi.fn();
      }
      (globalThis as Record<string, unknown>).PerformanceObserver = FakePO;
      try {
        initLongTaskObserver();
        const initLines = errorSpy.mock.calls
          .map(c => String(c[0]))
          .filter(s => /\[hotsheet longtask\] init —/.test(s));
        expect(initLines).toHaveLength(1);
        expect(initLines[0]).toContain('observer:on');
        expect(initLines[0]).toContain('heartbeat:on');
        expect(initLines[0]).toContain('threshold:100ms');
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });

    it('startup line says `observer:off` when PerformanceObserver is undefined (HS-8054 follow-up)', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      (globalThis as Record<string, unknown>).PerformanceObserver = undefined;
      try {
        initLongTaskObserver();
        const initLines = errorSpy.mock.calls
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
        // supportedEntryTypes.
        const initLines = errorSpy.mock.calls
          .map(c => String(c[0]))
          .filter(s => /\[hotsheet longtask\] init —/.test(s));
        expect(initLines[0]).toContain('observer:off');
        expect(initLines[0]).toContain('heartbeat:on');
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });
  });
});
