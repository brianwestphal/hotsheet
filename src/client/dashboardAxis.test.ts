import { describe, expect, it } from 'vitest';

import { integerAxis } from './dashboardAxis.js';

describe('integerAxis (HS-9724)', () => {
  // The bug: small integer maxes used to yield duplicate rounded labels.
  it.each([1, 2, 3, 4, 5, 7, 10, 13, 100, 250])('produces distinct integer ticks for max=%i', (max) => {
    const { niceMax, ticks } = integerAxis(max);
    // all ticks are integers
    for (const t of ticks) expect(Number.isInteger(t)).toBe(true);
    // all ticks are DISTINCT (the regression this guards)
    expect(new Set(ticks).size).toBe(ticks.length);
    // ascending from 0
    expect(ticks[0]).toBe(0);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
    // niceMax is the last tick and covers the data max
    expect(ticks[ticks.length - 1]).toBe(niceMax);
    expect(niceMax).toBeGreaterThanOrEqual(max);
    // never more than ~6 labels
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it('handles the exact cases from the bug report', () => {
    // max=1 used to render 0,0,1,1,1
    expect(integerAxis(1).ticks).toEqual([0, 1]);
    // max=3 used to render 0,1,2,2,3
    expect(integerAxis(3).ticks).toEqual([0, 1, 2, 3]);
  });

  it('uses a coarser step for larger ranges (still distinct)', () => {
    expect(integerAxis(10).ticks).toEqual([0, 2, 4, 6, 8, 10]);
    expect(integerAxis(100).ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('clamps a zero/negative max to a usable axis', () => {
    expect(integerAxis(0).ticks).toEqual([0, 1]);
    expect(integerAxis(-5).ticks).toEqual([0, 1]);
  });
});
