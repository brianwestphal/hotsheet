/**
 * §78 Announcer (HS-8756) — the transcript PIP's pure positioning geometry:
 * clamp-on-screen + anchor-under-the-button.
 */
import { describe, expect, it } from 'vitest';

import { anchoredPosition, clampPosition } from './announcerPipPosition.js';

const VIEWPORT = { width: 1200, height: 800 };
const PANEL = { width: 340, height: 200 };

describe('clampPosition (HS-8756)', () => {
  it('leaves an on-screen position untouched', () => {
    expect(clampPosition({ left: 400, top: 300 }, PANEL, VIEWPORT)).toEqual({ left: 400, top: 300 });
  });

  it('pulls a position off the left/top edge back to the margin', () => {
    expect(clampPosition({ left: -50, top: -20 }, PANEL, VIEWPORT)).toEqual({ left: 10, top: 10 });
  });

  it('pulls a position off the right/bottom edge so the panel stays fully visible', () => {
    // maxLeft = 1200 - 340 - 10 = 850; maxTop = 800 - 200 - 10 = 590.
    expect(clampPosition({ left: 5000, top: 5000 }, PANEL, VIEWPORT)).toEqual({ left: 850, top: 590 });
  });

  it('never produces a negative position even when the panel is larger than the viewport', () => {
    const tiny = { width: 200, height: 200 };
    const big = { width: 400, height: 400 };
    const pos = clampPosition({ left: 9999, top: 9999 }, big, tiny);
    expect(pos.left).toBeGreaterThanOrEqual(10);
    expect(pos.top).toBeGreaterThanOrEqual(10);
  });
});

describe('anchoredPosition (HS-8756)', () => {
  it('places the panel just below the button with right edges aligned', () => {
    // Button top-right at x=900, bottom at y=40. left = 900 - 340 = 560; top = 50.
    const anchor = { left: 860, top: 20, right: 900, bottom: 40 };
    expect(anchoredPosition(anchor, PANEL, VIEWPORT)).toEqual({ left: 560, top: 50 });
  });

  it('clamps when the button sits near the right edge so the panel stays on screen', () => {
    const anchor = { left: 1180, top: 20, right: 1200, bottom: 40 };
    // raw left = 1200 - 340 = 860 → clamped to maxLeft 850.
    expect(anchoredPosition(anchor, PANEL, VIEWPORT).left).toBe(850);
  });
});
