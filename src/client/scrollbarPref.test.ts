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

import { applyScrollbarPrefClass, detectScrollbarsAlwaysVisible } from './scrollbarPref.js';

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
});
