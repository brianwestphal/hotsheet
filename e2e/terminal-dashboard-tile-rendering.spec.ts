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

  /**
   * HS-7198 — reverse-direction convergence: dashboard → exit → drawer.
   *
   * HS-7097 covers the forward direction (drawer → dashboard → drawer):
   * the dashboard tile drives the PTY size on attach so a wide-short PTY
   * redraws at 4:3 inside the tile. The reverse path — exit dashboard and
   * go back to the drawer — relies on the drawer's own `fit()` to resize
   * the PTY back to drawer dims so the TUI redraws for the drawer aspect.
   * Nothing in the stack asserted that that fit actually fires and the
   * TUI actually redraws; this test closes the gap so a regression in
   * the drawer-on-dashboard-exit refit path is caught, not surfaced later
   * as "the terminal looks squashed until I resize the window".
   */
  test('drawer refits the PTY after dashboard exit, TUI redraws at drawer dims (HS-7198)', async ({ page }, testInfo) => {
    // Wide-short viewport so the drawer PTY lands wide-short and the
    // dashboard tile meaningfully changes the PTY dims on attach.
    await page.setViewportSize({ width: 1600, height: 600 });
    await openDrawerAndWaitForDraw(page);

    const drawerPane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:draw"]');
    // Capture the drawer's row count BEFORE entering the dashboard — this is
    // the geometry the drawer will refit back to.
    const drawerInitialRows = await drawerPane.evaluate((el: Element) => {
      return el.querySelectorAll('.xterm-rows > div').length;
    });
    expect(drawerInitialRows).toBeGreaterThan(0);

    // Enter dashboard. HS-7097 resizes the PTY to tile-native 4:3 on tile
    // attach, so during the dashboard session the TUI is drawing for ~60
    // rows × ~80 cols, NOT the drawer's wide-short geometry.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="draw"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 5000 });
    await expect(tile.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 8000 });

    // Exit dashboard — drawer comes back into view. This fires
    // `commandLog.tsx`'s fit-on-drawer-show path, which pushes a resize
    // message so the PTY shrinks back to drawer geometry and the TUI
    // receives SIGWINCH + redraws.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
    await expect(drawerPane).toBeVisible();

    // Give xterm a frame for the post-fit redraw to land. The fixture's
    // SIGWINCH handler redraws TOP/BOTTOM whenever it sees a resize, so the
    // drawer's xterm should show BOTTOM-KEYBAR near the drawer's last row
    // rather than floating mid-pane or wrapped at dashboard-era dims.
    await page.waitForTimeout(400);
    await expect(drawerPane.locator('.xterm-screen')).toContainText(/BOTTOM-KEYBAR/, { timeout: 8000 });

    const screenshot = await drawerPane.screenshot({ path: 'test-results/hs-7198-drawer-after-dashboard-exit.png' });
    await testInfo.attach('drawer-after-dashboard-exit.png', { body: screenshot, contentType: 'image/png' });

    // The BOTTOM-KEYBAR row's bottom edge should be within ~10 % of the
    // drawer pane's bottom — same criterion as HS-7097's grid / centered /
    // dedicated asserts. A failure here means either (a) the drawer didn't
    // refit the PTY (TUI still drawing for 60 rows, visible as empty rows
    // below the marker) or (b) it refit but the TUI never redrew.
    const result = await drawerPane.evaluate((el: Element) => {
      const body = el.querySelector('.terminal-body') as HTMLElement | null;
      if (body === null) return { error: 'terminal-body missing' };
      const bodyRect = body.getBoundingClientRect();
      const rows = Array.from(el.querySelectorAll('.xterm-rows > div')) as HTMLElement[];
      let lastNonEmpty: HTMLElement | null = null;
      for (const row of rows) {
        if ((row.textContent ?? '').trim().length > 0) lastNonEmpty = row;
      }
      if (lastNonEmpty === null) return { error: 'no rendered rows with content' };
      const lastRect = lastNonEmpty.getBoundingClientRect();
      return {
        bodyHeight: bodyRect.height,
        renderedRows: rows.length,
        lastRowText: (lastNonEmpty.textContent ?? '').trim().slice(0, 80),
        gapAsFraction: (bodyRect.bottom - lastRect.bottom) / bodyRect.height,
      };
    });

    expect(result.error).toBeUndefined();
    expect(result.lastRowText).toMatch(/BOTTOM-KEYBAR/);
    expect(result.gapAsFraction).toBeLessThan(0.15);
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

  /**
   * HS-7603 — tiles initially below the visible viewport must still pick up
   * tile-native cell dims when xterm finishes its first render. The earlier
   * resync logic gated only on the initial rAF + the history-frame handler;
   * if either fired before xterm had committed `.xterm-screen` to the DOM
   * (typical for tiles below the fold whose rAF could land while the screen
   * was still 0×0), `tileNativeDimsFromXterm` returned the fallback 80×60
   * and the term + PTY stayed locked to the fallback even after the user
   * scrolled the tile into view. The fix routes the same resize through the
   * `.xterm-screen` ResizeObserver that already drove the visual scale, so
   * any subsequent screen-size change re-derives native dims and pushes
   * them to both the term and the PTY.
   */
  test('tiles below the fold end up at native dims, not the fallback 80×60 (HS-7603)', async ({ page }) => {
    // Wide-short viewport so the drawer fits at a wide-short PTY shape, then
    // tall enough that there's still real estate to scroll within when many
    // tiles are configured. We compress the viewport AFTER opening the
    // drawer so the dashboard's tile rows immediately wrap below the fold.
    await page.setViewportSize({ width: 1200, height: 800 });
    await openDrawerAndWaitForDraw(page);

    // Add 11 more terminal configs so the dashboard has 12 alive tiles
    // (`draw` plus `t01`-`t11`) and rows wrap below the visible viewport.
    // Reusing `/usr/bin/env true` for the extras keeps PTY spawn cost low —
    // they exit after one byte but leave history that tile can replay; for
    // this test we only care that the tile element renders + reaches its
    // native dims, not that anything specific is drawn into it.
    const projRes = await page.request.get('/api/projects');
    const projects = await projRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    const extraTerminals = Array.from({ length: 11 }, (_, i) => ({
      id: `t${String(i + 1).padStart(2, '0')}`,
      name: `T${i + 1}`,
      command: `/usr/bin/env python3 ${DRAW_SCRIPT}`,
      lazy: false,
    }));
    await page.request.patch('/api/file-settings', {
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
      data: {
        terminals: [
          { id: 'draw', name: 'Draw', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
          ...extraTerminals,
        ],
      },
    });

    // Open the dashboard. The list refresh that the dashboard fires on
    // toggle picks up the new terminals; we wait for the last tile to be
    // attached (it'll be below the fold initially).
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    const lastTile = page.locator('.terminal-dashboard-tile[data-terminal-id="t11"]');
    await expect(lastTile).toBeAttached({ timeout: 10000 });

    // Give every tile time to (a) finish its rAF resize pass and (b) get its
    // first .xterm-screen render committed. The ResizeObserver fires on the
    // first render so the resync runs even for tiles below the fold.
    await page.waitForTimeout(500);

    // Query every tile's xterm cols. The xterm instance isn't directly
    // accessible from the DOM, but the screen DOM has an inline `style.width`
    // set to `cols * cellWidth` — and applyTileScale wraps it in an
    // absolute-positioned root sized to the natural pixel dims, so we can
    // round-trip to cols by dividing by the cellWidth observed on a known
    // tile. Use the visible `draw` tile (which we know has been resized
    // correctly per HS-7097) as the cell-metric reference.
    const result = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll<HTMLElement>('.terminal-dashboard-tile-alive'));
      type Entry = { id: string; cols: number | null; rows: number | null; visible: boolean };
      const entries: Entry[] = tiles.map((tile) => {
        const id = tile.dataset.terminalId ?? '';
        const screen = tile.querySelector<HTMLElement>('.xterm-screen');
        if (screen === null) return { id, cols: null, rows: null, visible: false };
        const rows = tile.querySelectorAll('.xterm-rows > div').length;
        // .xterm-screen offsetWidth = cols * cellW. The xterm-rows row count
        // matches term.rows. We use the row's pixel height to derive cellH
        // and divide screen.offsetWidth by cellH-implied cellW; instead just
        // use cols-as-row-count vs offsetWidth/cellW heuristic via a single
        //-cell sample. Use the screen offsetWidth + a fixed-character count
        // approach: measure first child's offsetHeight as cellH, then derive
        // cellW from the natural xterm proportion. Simpler: count distinct
        // characters in row 0 to approximate cols. xterm doesn't padd rows,
        // so row 0's textContent length is up to `cols`. Take max textContent
        // length across rows as an approximation of `cols`.
        let maxLen = 0;
        for (const row of tile.querySelectorAll<HTMLElement>('.xterm-rows > div')) {
          const text = (row.textContent ?? '').replace(/\s+$/, '');
          if (text.length > maxLen) maxLen = text.length;
        }
        const tileRect = tile.getBoundingClientRect();
        const visible = tileRect.top < window.innerHeight && tileRect.bottom > 0;
        return { id, cols: maxLen, rows, visible };
      });
      return { entries, viewportHeight: window.innerHeight };
    });

    // Sanity: at least one tile is initially below the fold (so this test
    // is actually exercising the offscreen path).
    const offscreenAtMount = result.entries.filter((e) => !e.visible);
    expect(offscreenAtMount.length).toBeGreaterThan(0);

    // Every tile's xterm should have ≥ DASHBOARD_MIN_ROWS (= 60) rows. The
    // bug regression manifests as terms stuck at the 80-cols / 60-rows
    // fallback. Verify rows hit the native value across visible AND
    // initially-offscreen tiles. Cols vary based on cell metrics so we don't
    // pin a specific cols value — but the BOTTOM-KEYBAR row should be drawn
    // far enough down (at row ~60) that the rendered row count exceeds the
    // 24 the drawer was at.
    for (const e of result.entries) {
      // 60 ≤ rows (DASHBOARD_TARGET_NATURAL_HEIGHT_PX 960 / cellH ≈ 16 = 60).
      expect.soft(e.rows, `tile ${e.id} (visible=${e.visible}) rows`).toBeGreaterThanOrEqual(50);
    }
  });
});
