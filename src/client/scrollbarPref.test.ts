// @vitest-environment happy-dom
/**
 * HS-8494 — happy-path tests for `detectScrollbarsAlwaysVisible`. The
 * function is layout-dependent + happy-dom doesn't faithfully model
 * the `offsetWidth` vs `clientWidth` difference that overlay-scrollbar
 * browsers produce, so the assertions here cover the structural
 * properties: the function is callable, returns a boolean, and the
 * apply-class wrapper is idempotent.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyScrollbarPrefClass, detectScrollbarsAlwaysVisible, watchHorizontalOverflow } from './scrollbarPref.js';

describe('scrollbarPref (HS-8494)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.body.classList.remove('scrollbars-always-visible');
  });

  afterEach(() => {
    document.body.classList.remove('scrollbars-always-visible');
  });

  it('returns a boolean from detectScrollbarsAlwaysVisible', () => {
    const result = detectScrollbarsAlwaysVisible();
    expect(typeof result).toBe('boolean');
  });

  it('cleans up the probe element', () => {
    detectScrollbarsAlwaysVisible();
    // Probe should be removed regardless of detection result.
    expect(document.body.children.length).toBe(0);
  });

  it('applyScrollbarPrefClass either adds the class or leaves it absent', () => {
    applyScrollbarPrefClass();
    // Either outcome is valid depending on the test environment's
    // scrollbar layout — assert that the class state is internally
    // consistent with the detector.
    const detected = detectScrollbarsAlwaysVisible();
    expect(document.body.classList.contains('scrollbars-always-visible')).toBe(detected);
  });

  it('applyScrollbarPrefClass is safe to call repeatedly', () => {
    applyScrollbarPrefClass();
    applyScrollbarPrefClass();
    applyScrollbarPrefClass();
    // No-throw is the test; classList is a Set-like + dup-adds are
    // no-ops.
    expect(document.body).toBeDefined();
  });

  describe('watchHorizontalOverflow (HS-8494 follow-up)', () => {
    function setSize(el: HTMLElement, scroll: number, client: number): void {
      Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scroll });
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: client });
    }

    it('adds has-overflow when scrollWidth > clientWidth on initial call', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      setSize(el, 300, 100);
      const dispose = watchHorizontalOverflow(el);
      try {
        expect(el.classList.contains('has-overflow')).toBe(true);
      } finally {
        dispose();
      }
    });

    it('leaves has-overflow off when content fits', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      setSize(el, 100, 100);
      const dispose = watchHorizontalOverflow(el);
      try {
        expect(el.classList.contains('has-overflow')).toBe(false);
      } finally {
        dispose();
      }
    });

    it('treats a 1 px slack as fitting (avoids flicker on sub-pixel measurements)', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      setSize(el, 101, 100);
      const dispose = watchHorizontalOverflow(el);
      try {
        expect(el.classList.contains('has-overflow')).toBe(false);
      } finally {
        dispose();
      }
    });

    it('dispose() clears the class and stops observing', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      setSize(el, 300, 100);
      const dispose = watchHorizontalOverflow(el);
      expect(el.classList.contains('has-overflow')).toBe(true);
      dispose();
      expect(el.classList.contains('has-overflow')).toBe(false);
    });
  });
});
