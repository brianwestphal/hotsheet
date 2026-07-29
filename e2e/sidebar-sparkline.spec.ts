/**
 * HS-9463 — the sidebar dashboard sparkline read as "missing data".
 *
 * It was a fixed 98px-wide SVG inside a wider sidebar, so the bars stopped
 * two-thirds of the way across; and a day with no completions produced a
 * zero-height (invisible) rect, leaving holes in the middle of the week.
 *
 * These assert the two user-visible facts: the chart reaches the edges of its
 * padding, and every day in the window is represented by something you can see.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Sidebar sparkline (HS-9463)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('spans the full widget width, minus the widget padding', async ({ page }) => {
    const svg = page.locator('.sidebar-widget-spark svg');
    await expect(svg).toBeVisible({ timeout: 10000 });

    const svgBox = (await svg.boundingBox())!;
    const widgetBox = (await page.locator('#sidebar-dashboard-widget').boundingBox())!;
    // `.sidebar-dashboard-widget` has 16px horizontal padding; the chart should
    // consume everything inside it. Pre-fix this was a hardcoded 98px.
    const padding = await page.locator('#sidebar-dashboard-widget')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    expect(svgBox.width).toBeCloseTo(widgetBox.width - padding * 2, 0);
  });

  test('every day is visible — no zero-height holes', async ({ page }) => {
    const rects = page.locator('.sidebar-widget-spark svg rect');
    await expect(rects.first()).toBeVisible({ timeout: 10000 });

    const bars = await rects.evaluateAll((els) => els.map((e) => ({
      height: parseFloat(e.getAttribute('height') ?? '0'),
      fill: e.getAttribute('fill'),
      x: parseFloat(e.getAttribute('x') ?? '-1'),
      width: parseFloat(e.getAttribute('width') ?? '0'),
    })));

    expect(bars.length).toBeGreaterThan(0);
    // The defect: a day with no completions rendered height="0" and vanished.
    for (const b of bars) expect(b.height).toBeGreaterThan(0);
    // An empty day is drawn in the theme's text color at low opacity, so it
    // reads as a baseline rather than as a value.
    for (const b of bars) expect(['currentColor', '#3b82f6']).toContain(b.fill);

    // Edge to edge within the viewBox: first bar at 0, last ending at 100.
    expect(bars[0].x).toBe(0);
    const last = bars[bars.length - 1];
    expect(last.x + last.width).toBeCloseTo(100, 3);
  });
});
