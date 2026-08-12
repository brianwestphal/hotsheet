// @vitest-environment happy-dom
//
// HS-9627 — the terminal dashboard remembers its scroll position across a
// switch-away / switch-back. These tests pin the "best effort" clamp: the
// remembered offset must survive an unchanged grid exactly, and degrade
// gracefully when the terminal count shrinks or the viewport changes rather
// than overscrolling past the new content.
import { describe, expect, it } from 'vitest';

import { clampScrollTop, restoreScrollTop } from './terminalDashboardScroll.js';

describe('clampScrollTop (HS-9627)', () => {
  it('returns the remembered offset unchanged when it still fits', () => {
    // 400 remembered, content 2000 tall in an 800 viewport → max scroll 1200.
    expect(clampScrollTop(400, 2000, 800)).toBe(400);
  });

  it('clamps to the new bottom when the content shrank (fewer terminals)', () => {
    // Was scrolled to 1200; now only 1000 tall in an 800 viewport → max 200.
    expect(clampScrollTop(1200, 1000, 800)).toBe(200);
  });

  it('clamps to the new bottom when the viewport grew (window resized taller)', () => {
    // Same 2000-tall content, but a 1900 viewport → max scroll 100.
    expect(clampScrollTop(1500, 2000, 1900)).toBe(100);
  });

  it('collapses to 0 when the content no longer overflows', () => {
    expect(clampScrollTop(500, 600, 800)).toBe(0);
    // Exact fit is also non-scrollable.
    expect(clampScrollTop(500, 800, 800)).toBe(0);
  });

  it('collapses non-positive / non-finite remembered values to 0', () => {
    expect(clampScrollTop(0, 2000, 800)).toBe(0);
    expect(clampScrollTop(-50, 2000, 800)).toBe(0);
    expect(clampScrollTop(Number.NaN, 2000, 800)).toBe(0);
    // +Infinity is garbage, not "scroll to max" — the finite check rejects it.
    expect(clampScrollTop(Number.POSITIVE_INFINITY, 2000, 800)).toBe(0);
  });
});

/** happy-dom reports 0 for `scrollHeight`/`clientHeight` (no layout engine), so
 *  define them on the instance to simulate a laid-out, overflowing container. */
function makeScrollEl(scrollHeight: number, clientHeight: number): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  return el;
}

describe('restoreScrollTop (HS-9627)', () => {
  it('applies a remembered offset that still fits and returns it', () => {
    const el = makeScrollEl(2000, 800);
    expect(restoreScrollTop(el, 400)).toBe(400);
    expect(el.scrollTop).toBe(400);
  });

  it('applies the clamped offset when content shrank', () => {
    const el = makeScrollEl(1000, 800); // max scroll 200
    expect(restoreScrollTop(el, 1200)).toBe(200);
    expect(el.scrollTop).toBe(200);
  });

  it('is a no-op when nothing was captured (null) — leaves scrollTop alone', () => {
    const el = makeScrollEl(2000, 800);
    el.scrollTop = 123;
    expect(restoreScrollTop(el, null)).toBe(123);
    expect(el.scrollTop).toBe(123);
  });

  it('resets to top when the grid no longer overflows', () => {
    const el = makeScrollEl(600, 800); // no overflow
    el.scrollTop = 0;
    expect(restoreScrollTop(el, 500)).toBe(0);
    expect(el.scrollTop).toBe(0);
  });
});
