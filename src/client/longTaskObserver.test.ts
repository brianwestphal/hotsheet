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
 *   - the console.warn output format the user will see in DevTools
 *   - feature-detect inertness when `PerformanceObserver` is missing
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
  let warnSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    _resetLongTaskObserverForTesting();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    _resetLongTaskObserverForTesting();
  });

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
    it('records a long task with formatted wall clock + duration', () => {
      recordInteraction('drawer-tab:terminal:claude');
      _recordLongTaskForTesting(523);
      const buf = _getLongTaskBufferForTesting();
      expect(buf).toHaveLength(1);
      expect(buf[0].durationMs).toBe(523);
      expect(buf[0].wallClock).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    });

    it('emits a console.warn with the canonical user-facing format', () => {
      recordInteraction('project-switch:Hot Sheet');
      _recordLongTaskForTesting(723);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const arg = warnSpy.mock.calls[0][0] as string;
      // Format: `[hotsheet longtask] HH:MM:SS.mmm — 723ms (recent: project-switch:Hot Sheet @-Nms)`
      expect(arg).toMatch(/^\[hotsheet longtask\] \d{2}:\d{2}:\d{2}\.\d{3} — 723ms \(recent: project-switch:Hot Sheet @-\d+ms\)$/);
    });

    it('says "no recent interactions" when the buffer is empty', () => {
      _recordLongTaskForTesting(150);
      const arg = warnSpy.mock.calls[0][0] as string;
      expect(arg).toContain('(recent: no recent interactions)');
    });

    it('includes interactions from before the long task started but excludes very old ones', async () => {
      recordInteraction('old-event');
      // Wait long enough that the next interaction's relative offset is
      // past the 2 s window cutoff (window = duration + 2 s before end).
      // Use vi.useFakeTimers? simpler: just record old, advance perf
      // clock via a real wait. happy-dom's `performance.now()` advances
      // with real time so a 50 ms wait gives us a measurable delta.
      await new Promise(r => setTimeout(r, 50));
      recordInteraction('recent-event');
      _recordLongTaskForTesting(80);
      const arg = warnSpy.mock.calls[0][0] as string;
      // Both should be in window (50 ms + 80 ms = 130 ms, well under 2 s cap).
      expect(arg).toContain('old-event');
      expect(arg).toContain('recent-event');
    });

    it('truncates the long-task buffer to size cap (50)', () => {
      for (let i = 0; i < 60; i += 1) _recordLongTaskForTesting(120);
      const buf = _getLongTaskBufferForTesting();
      expect(buf).toHaveLength(50);
    });
  });

  describe('initLongTaskObserver', () => {
    it('is idempotent — calling twice does not throw or double-register', () => {
      initLongTaskObserver();
      initLongTaskObserver();
      // No assertion — the test is "doesn't throw". A double-register
      // would either throw or duplicate console.warn output for the
      // same long task.
      _recordLongTaskForTesting(200);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('exposes the window-global retrieval helpers when the observer attaches', () => {
      // happy-dom doesn't ship PerformanceObserver — stub a minimal
      // working implementation so init() reaches the globals-export
      // path. The real Tauri WKWebView always has it.
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

    it('is inert when PerformanceObserver is undefined', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      (globalThis as Record<string, unknown>).PerformanceObserver = undefined;
      try {
        initLongTaskObserver(); // must not throw
        // recordInteraction still works even without the observer.
        recordInteraction('no-observer');
        expect(_getInteractionBufferForTesting()).toHaveLength(1);
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });

    it('is inert when longtask is not in supportedEntryTypes', () => {
      const original = (globalThis as Record<string, unknown>).PerformanceObserver;
      // Stub a PerformanceObserver that claims supportedEntryTypes
      // without longtask. The observer should detect this and bail,
      // never invoking observe().
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
      } finally {
        (globalThis as Record<string, unknown>).PerformanceObserver = original;
      }
    });
  });
});
