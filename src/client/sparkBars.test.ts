/**
 * HS-9463 — the sidebar sparkline read as "missing data": it was a fixed 98px wide
 * inside a wider sidebar (so it stopped two-thirds across) and a day with no
 * completions rendered as a zero-height, invisible rect (so the week had holes).
 */
import { describe, expect, it } from 'vitest';

import { sparkBarGeometry } from './sparkBars.js';

const W = 100;
const H = 20;

describe('sparkBarGeometry (HS-9463)', () => {
  it('spans the full width — first bar at the left edge, last at the right', () => {
    const bars = sparkBarGeometry([1, 2, 3, 4, 5, 6, 7], { viewWidth: W, viewHeight: H });
    expect(bars).toHaveLength(7);
    expect(bars[0].x).toBe(0);
    // The defect was a fixed 98px row of bars leaving the rest of the sidebar blank.
    const last = bars[6];
    expect(last.x + last.width).toBeCloseTo(W, 6);
  });

  it('keeps a uniform gutter between bars', () => {
    const gap = 4;
    const bars = sparkBarGeometry([1, 2, 3, 4, 5, 6, 7], { viewWidth: W, viewHeight: H, gap });
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i].x - (bars[i - 1].x + bars[i - 1].width)).toBeCloseTo(gap, 6);
    }
  });

  it('fills the width whatever the number of days', () => {
    // Fewer than 7 days of history must still reach the right edge, not leave a gap.
    for (const n of [1, 2, 3, 5, 7, 14]) {
      const bars = sparkBarGeometry(Array.from({ length: n }, () => 1), { viewWidth: W, viewHeight: H });
      expect(bars).toHaveLength(n);
      expect(bars[0].x).toBe(0);
      expect(bars[n - 1].x + bars[n - 1].width).toBeCloseTo(W, 6);
    }
  });

  it('draws a flat baseline for a day with no completions, not a hole', () => {
    const bars = sparkBarGeometry([5, 0, 5], { viewWidth: W, viewHeight: H, minHeight: 1.5 });
    expect(bars[1].empty).toBe(true);
    expect(bars[1].height).toBe(1.5);
    // Sat on the bottom, which is what makes it read as a baseline.
    expect(bars[1].y).toBe(H - 1.5);
    expect(bars[0].empty).toBe(false);
    expect(bars[2].empty).toBe(false);
  });

  it('never renders a real value shorter than an empty day', () => {
    // 1 of a 21 max scales to 0.95 units — below the 1.5-unit empty baseline. Without
    // a floor on non-empty bars the chart inverts at the bottom of its scale and a
    // day with work would look emptier than a day without.
    const bars = sparkBarGeometry([21, 1, 0], { viewWidth: W, viewHeight: H, minHeight: 1.5 });
    expect(bars[1].empty).toBe(false);
    expect(bars[1].height).toBeGreaterThanOrEqual(bars[2].height);
  });

  it('scales the tallest bar to the full height', () => {
    const bars = sparkBarGeometry([21, 10], { viewWidth: W, viewHeight: H });
    expect(bars[0].height).toBeCloseTo(H, 6);
    expect(bars[0].y).toBeCloseTo(0, 6);
    expect(bars[1].height).toBeCloseTo(H * (10 / 21), 6);
  });

  it('handles an all-zero week without dividing by zero', () => {
    const bars = sparkBarGeometry([0, 0, 0], { viewWidth: W, viewHeight: H, minHeight: 1.5 });
    expect(bars.every((b) => b.empty)).toBe(true);
    expect(bars.every((b) => b.height === 1.5)).toBe(true);
    expect(bars.every((b) => Number.isFinite(b.y))).toBe(true);
  });

  it('treats a negative value as empty rather than inverting the bar', () => {
    const bars = sparkBarGeometry([-3, 5], { viewWidth: W, viewHeight: H });
    expect(bars[0].empty).toBe(true);
    expect(bars[0].height).toBeGreaterThan(0);
    expect(bars[0].y).toBeLessThan(H);
  });

  it('returns nothing for no data', () => {
    expect(sparkBarGeometry([])).toEqual([]);
  });

  it('never produces a negative width when the gap crowds out the bars', () => {
    const bars = sparkBarGeometry([1, 2, 3], { viewWidth: 4, viewHeight: H, gap: 10 });
    expect(bars.every((b) => b.width >= 0)).toBe(true);
  });
});
