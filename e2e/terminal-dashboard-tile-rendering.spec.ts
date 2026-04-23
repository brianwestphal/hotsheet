/**
 * HS-7097 — terminal dashboard tile content sizing.
 *
 * The reproducer the user demanded ("you must make e2e tests and take
 * screenshots"): configure a real PTY whose script draws a TOP marker at
 * row 1 and a BOTTOM marker at the *current* last row, and redraws on
 * SIGWINCH. Then drive the full UI through the browser:
 *
 *   1. Open the drawer at a wide-short viewport so the PTY spawns at
 *      wide-short dims (e.g. ~160 × 24), matching the real-world setup
 *      that exposed the bug (the user's drawer at ~235 × 41).
 *   2. Wait for TOP / BOTTOM markers to land in the drawer xterm.
 *   3. Open the dashboard. The grid tile attaches without going through
 *      drawer fit, so the tile sees the wide-short PTY.
 *   4. Take a screenshot of the tile and assert that BOTTOM-KEYBAR is
 *      rendered near the bottom of the tile preview — i.e. the tile
 *      shows a usable preview of the live terminal, not a top-anchored
 *      strip with a band of empty space below the keybar.
 *
 * The same assertion is run for the centered (zoom) view.
 */
import { expect, test } from './coverage-fixture.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAW_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-draw.py');

let headers: Record<string, string> = {};

test.describe('Terminal dashboard tile content rendering (HS-7097)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri stub — the dashboard + drawer terminal are Tauri-only gated.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });

    // Tear down any dynamic terminals from earlier tests so we start clean.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* fine on first run */ }

    // Configure a single eager-spawn terminal that runs the draw script.
    // `lazy: false` so the PTY exists at project boot; the drawer fit() then
    // resizes it to the drawer body's measured cols × rows.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        terminals: [
          { id: 'draw', name: 'Draw', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
        ],
      },
    });

    // Restart any pre-existing PTY for this id so a fresh PTY runs the draw
    // script (an earlier test run may have left a stale `/bin/echo` PTY around
    // before we changed the command).
    try {
      await request.post('/api/terminal/restart', { headers, data: { terminalId: 'draw' } });
    } catch { /* not yet spawned — first run */ }
  });

  /**
   * Shared setup: open the page at a wide-short viewport, open the drawer,
   * activate the `draw` terminal tab, and wait for the script's TOP / BOTTOM
   * markers to appear. Returns once the drawer xterm is fully populated so
   * the dashboard tile is guaranteed to receive a non-empty history frame
   * when it attaches.
   */
  async function openDrawerAndWaitForDraw(page: import('@playwright/test').Page): Promise<void> {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    // Click the `draw` terminal tab to activate it (its pane is `display:none`
    // until selected, and the WebSocket attach only fires once the pane is
    // visible / mounted).
    const drawTab = page.locator('.drawer-terminal-tab[data-terminal-id="draw"]');
    await expect(drawTab).toBeVisible({ timeout: 5000 });
    await drawTab.click();

    const drawerPane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:draw"]');
    await expect(drawerPane).toBeVisible({ timeout: 5000 });
    await expect(drawerPane.locator('.xterm-screen')).toContainText(/TOP-STATUS-BAR/, { timeout: 8000 });
    await expect(drawerPane.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 8000 });
  }

  test('grid tile shows BOTTOM marker near the bottom of the preview, not floating mid-tile', async ({ page }, testInfo) => {
    // Wide-short viewport so the drawer fit() lands the PTY at the wide-short
    // aspect that exposed the bug (drawer-attached terminals are typically
    // 5:1+, dashboard tile is 4:3).
    await page.setViewportSize({ width: 1600, height: 600 });
    await openDrawerAndWaitForDraw(page);

    // Open the dashboard.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="draw"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 5000 });
    await expect(tile.locator('.xterm-screen')).toContainText(/TOP-STATUS-BAR/, { timeout: 8000 });
    await expect(tile.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 8000 });

    // Give xterm a frame to settle on the final scale + the screen
    // ResizeObserver to fire.
    await page.waitForTimeout(250);

    // Capture screenshot for visual evidence (also saved to a stable path so
    // it can be eyeballed without unzipping the playwright report archive).
    const screenshot = await tile.screenshot({ path: 'test-results/hs-7097-grid-tile.png' });
    await testInfo.attach('grid-tile.png', { body: screenshot, contentType: 'image/png' });

    // Measure: the BOTTOM-KEYBAR row's bottom edge should be close to the
    // tile preview's bottom edge — i.e. the bottom marker actually sits at
    // the bottom of the visible tile content. Before the HS-7097 fix the
    // tile xterm was resized to 60 rows AFTER replaying ~32 rows of bytes,
    // leaving rows 33-60 empty white below the BOTTOM-KEYBAR row, which
    // showed up as a gap of ~40-50 % of the tile height between the marker
    // and the preview's bottom edge.
    const result = await tile.evaluate((tileEl: Element) => {
      const preview = tileEl.querySelector('.terminal-dashboard-tile-preview') as HTMLElement | null;
      const xtermRoot = tileEl.querySelector('.terminal-dashboard-tile-xterm') as HTMLElement | null;
      if (preview === null || xtermRoot === null) return { error: 'preview/xtermRoot missing' };
      const previewRect = preview.getBoundingClientRect();
      // xterm renders rows as <div> children of `.xterm-rows`. Find the
      // last row that contains visible (non-whitespace) content.
      const rows = Array.from(xtermRoot.querySelectorAll('.xterm-rows > div')) as HTMLElement[];
      let lastNonEmpty: HTMLElement | null = null;
      for (const row of rows) {
        const text = row.textContent ?? '';
        if (text.trim().length > 0) lastNonEmpty = row;
      }
      if (lastNonEmpty === null) return { error: 'no rendered rows with content' };
      const lastRect = lastNonEmpty.getBoundingClientRect();
      return {
        previewTop: previewRect.top,
        previewBottom: previewRect.bottom,
        previewHeight: previewRect.height,
        lastRowBottom: lastRect.bottom,
        lastRowText: (lastNonEmpty.textContent ?? '').trim().slice(0, 80),
        gapBelowLastRow: previewRect.bottom - lastRect.bottom,
        gapAsFraction: (previewRect.bottom - lastRect.bottom) / previewRect.height,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.lastRowText).toMatch(/BOTTOM-KEYBAR/);
    // The last-row marker should sit within ~10 % of the preview bottom.
    // The bug placed it ~40-50 % above the bottom (large band of empty
    // rows below); 10 % allows for letterboxing from minor cell-metric
    // rounding without re-introducing the regression.
    expect(result.gapAsFraction).toBeLessThan(0.1);
  });

  test('centered (zoom) tile shows BOTTOM marker near the bottom of the preview', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openDrawerAndWaitForDraw(page);

    await page.locator('#terminal-dashboard-toggle').click();
    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="draw"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 5000 });
    await expect(tile.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 8000 });

    // Center the tile (single click).
    await tile.click();
    await expect(tile).toHaveClass(/centered/);
    // Wait for the FLIP animation + a frame for the screen ResizeObserver.
    await page.waitForTimeout(450);
    await expect(tile.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 5000 });

    const screenshot = await page.screenshot({ path: 'test-results/hs-7097-centered-tile.png' });
    await testInfo.attach('centered-tile.png', { body: screenshot, contentType: 'image/png' });

    const result = await tile.evaluate((tileEl: Element) => {
      const preview = tileEl.querySelector('.terminal-dashboard-tile-preview') as HTMLElement | null;
      const xtermRoot = tileEl.querySelector('.terminal-dashboard-tile-xterm') as HTMLElement | null;
      if (preview === null || xtermRoot === null) return { error: 'preview/xtermRoot missing' };
      const previewRect = preview.getBoundingClientRect();
      const rows = Array.from(xtermRoot.querySelectorAll('.xterm-rows > div')) as HTMLElement[];
      let lastNonEmpty: HTMLElement | null = null;
      for (const row of rows) {
        if ((row.textContent ?? '').trim().length > 0) lastNonEmpty = row;
      }
      if (lastNonEmpty === null) return { error: 'no rendered rows with content' };
      const lastRect = lastNonEmpty.getBoundingClientRect();
      return {
        previewHeight: previewRect.height,
        lastRowText: (lastNonEmpty.textContent ?? '').trim().slice(0, 80),
        gapAsFraction: (previewRect.bottom - lastRect.bottom) / previewRect.height,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.lastRowText).toMatch(/BOTTOM-KEYBAR/);
    expect(result.gapAsFraction).toBeLessThan(0.1);
  });

  test('dedicated view shows BOTTOM marker near the bottom of the pane (control case)', async ({ page }, testInfo) => {
    // Sanity check: the dedicated view already passed the user's eyeball test
    // ("works in the full screen mode but not for the grid preview or
    // centered versions"). This pins that working behavior so a future
    // regression in the dedicated view's fit logic is caught alongside the
    // grid / centered ones.
    await page.setViewportSize({ width: 1600, height: 900 });
    await openDrawerAndWaitForDraw(page);

    await page.locator('#terminal-dashboard-toggle').click();
    await page.locator('.terminal-dashboard-tile[data-terminal-id="draw"]').dblclick();
    const dedicated = page.locator('.terminal-dashboard-dedicated[data-terminal-id="draw"]');
    await expect(dedicated).toBeVisible();
    await expect(dedicated.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 8000 });
    await page.waitForTimeout(300);

    const screenshot = await page.screenshot({ path: 'test-results/hs-7097-dedicated-view.png' });
    await testInfo.attach('dedicated-view.png', { body: screenshot, contentType: 'image/png' });

    const result = await dedicated.evaluate((paneEl: Element) => {
      const pane = paneEl.querySelector('.terminal-dashboard-dedicated-pane') as HTMLElement | null;
      const xtermScreen = paneEl.querySelector('.xterm-screen') as HTMLElement | null;
      if (pane === null || xtermScreen === null) return { error: 'pane/xterm-screen missing' };
      const paneRect = pane.getBoundingClientRect();
      const rows = Array.from(paneEl.querySelectorAll('.xterm-rows > div')) as HTMLElement[];
      let lastNonEmpty: HTMLElement | null = null;
      for (const row of rows) {
        if ((row.textContent ?? '').trim().length > 0) lastNonEmpty = row;
      }
      if (lastNonEmpty === null) return { error: 'no rendered rows' };
      const lastRect = lastNonEmpty.getBoundingClientRect();
      return {
        paneHeight: paneRect.height,
        lastRowText: (lastNonEmpty.textContent ?? '').trim().slice(0, 80),
        gapAsFraction: (paneRect.bottom - lastRect.bottom) / paneRect.height,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.lastRowText).toMatch(/BOTTOM-KEYBAR/);
    expect(result.gapAsFraction).toBeLessThan(0.1);
  });
});
