/**
 * HS-8619 — WebGL-enabled regression guard for the §54 "scaled consumers use
 * the DOM renderer" rule (HS-8488 / `webglWantedForConsumer`).
 *
 * The user reported that WebGL terminals "resize weirdly" in the Terminal
 * Dashboard, worst when magnified, and only for the most-recently-selected
 * project tab. The mechanism (confirmed by reproducing pre-fix in this harness):
 * a §25 dashboard tile CSS-`transform: scale(...)`s its xterm. A WebGL `<canvas>`
 * is a fixed-resolution raster, so scaling it down via a CSS transform produces
 * a blurry / mis-rendered tile — whereas the DOM renderer's `<span>`-per-cell
 * tree scales crisply. (The cols/rows sizing is correct under BOTH renderers;
 * the bug is purely rasterization.) So the fix forces scaled consumers onto the
 * DOM renderer via `reconcileRenderer` following the top-of-stack consumer's
 * `scaled` flag.
 *
 * EVERY OTHER terminal spec force-disables WebGL (coverage-fixture's
 * `__HOTSHEET_DISABLE_WEBGL__`) because the WebGL renderer leaves `.xterm-rows`
 * unpopulated, breaking text-scraping assertions. This spec deliberately
 * RE-ENABLES WebGL (a later `addInitScript` wins over the fixture's) so it can
 * assert the renderer-selection seam under the regime where the bug actually
 * lives. Headless Chromium ships SwiftShader WebGL2, so the renderer really
 * loads here.
 *
 * The invariant asserted:
 *   - the non-scaled drawer pane DOES use WebGL (a `<canvas>` is present) — so
 *     we know WebGL is genuinely on, not silently disabled;
 *   - every scaled dashboard tile — including the drawer-active project's
 *     terminal, the exact "most recently selected project tab" case — uses the
 *     DOM renderer (NO `<canvas>`, `.xterm-rows` populated), in the grid AND
 *     when magnified (centered).
 *
 * Verified to fail pre-fix: with `webglWantedForConsumer` ignoring `scaled`,
 * the tiles render `<canvas>` elements (`domRows` empty).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './coverage-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAW_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-draw.py');

let headers: Record<string, string> = {};

test.describe('Dashboard tiles use the DOM renderer under WebGL (HS-8619)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: async () => undefined } };
      // RE-ENABLE WebGL — the coverage fixture's earlier init script set this
      // to true; init scripts run in insertion order, so this later one wins.
      try { (window as unknown as Record<string, unknown>).__HOTSHEET_DISABLE_WEBGL__ = false; } catch { /* */ }
    });

    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        // Drawer open + a terminal active → that terminal gets BOTH a drawer
        // (non-scaled → WebGL) and a dashboard tile (scaled → DOM) consumer,
        // reproducing the "most recently selected project tab" condition.
        drawer_open: 'true',
        terminals: [
          { id: 'small', name: 'Small', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
          { id: 'medium', name: 'Medium', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
          { id: 'big', name: 'Big', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false, fontSize: 22 },
        ],
      },
    });

    for (const id of ['small', 'medium', 'big']) {
      try { await request.post('/api/terminal/restart', { headers, data: { terminalId: id } }); }
      catch { /* not yet spawned — first run */ }
    }
  });

  test('scaled tiles render DOM (no canvas) while WebGL is on; magnified too (HS-8619)', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Guard the premise: WebGL2 must actually be available + enabled, else this
    // test would vacuously pass.
    const webgl = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      return { available: gl !== null, disabled: (window as unknown as Record<string, unknown>).__HOTSHEET_DISABLE_WEBGL__ };
    });
    expect(webgl.available, 'headless Chromium should provide SwiftShader WebGL2').toBe(true);
    expect(webgl.disabled, 'this spec must run with WebGL enabled').toBe(false);

    // Open the drawer + activate 'big' so its xterm mounts as a non-scaled
    // (WebGL) consumer. `#command-log-btn` TOGGLES, and the shared e2e server
    // leaves the drawer's open-state nondeterministic across specs — converge
    // it with a retrying toggle (each pass clicks only when the tab is hidden).
    const bigTab = page.locator('.drawer-terminal-tab[data-terminal-id="big"]');
    await expect(async () => {
      if (!(await bigTab.isVisible())) {
        await page.locator('#command-log-btn').click();
      }
      await expect(bigTab).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await bigTab.click();
    await expect(page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:big"] .xterm'))
      .toBeVisible({ timeout: 10000 });

    // The non-scaled drawer pane MUST be on WebGL (a `<canvas>` is present).
    // Proves the renderer genuinely loaded (the disabled-flag check above only
    // proves it wasn't suppressed) so the tile assertions below are meaningful.
    // Poll the count rather than asserting `toBeVisible` on the canvas — a
    // WebGL canvas's visibility is layout-timing-sensitive across the shared
    // e2e server's specs, but its presence in the DOM is the real signal.
    await expect.poll(
      async () => page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:big"] canvas').count(),
      { message: 'drawer pane (non-scaled) should use the WebGL renderer (canvas present)', timeout: 10000 },
    ).toBeGreaterThan(0);

    // Open the dashboard.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    for (const id of ['small', 'medium', 'big']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`))
        .toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 8000 });
    }
    // Settle: convergence + the reconcileRenderer addon swap on checkout.
    await page.waitForTimeout(1200);

    const gridRenderers = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll<HTMLElement>('.terminal-dashboard-tile'));
      return tiles.map((tile) => ({
        id: tile.dataset.terminalId ?? '',
        canvasCount: tile.querySelectorAll('canvas').length,
        domRowsLen: (tile.querySelector('.xterm-rows')?.textContent ?? '').length,
      }));
    });
    for (const t of gridRenderers) {
      expect.soft(t.canvasCount, `grid tile ${t.id} must use DOM renderer (no WebGL canvas)`).toBe(0);
      expect.soft(t.domRowsLen, `grid tile ${t.id} must have populated .xterm-rows (DOM renderer)`).toBeGreaterThan(0);
    }

    // Magnify the drawer-active 'big' tile (single click → centered overlay,
    // still a scaled consumer). The renderer must stay DOM.
    await page.locator('.terminal-dashboard-tile[data-terminal-id="big"]').click();
    await expect(page.locator('.terminal-dashboard-tile.centered[data-terminal-id="big"]')).toHaveCount(1, { timeout: 5000 });
    await page.waitForTimeout(1000);

    const centered = await page.evaluate(() => {
      const tile = document.querySelector<HTMLElement>('.terminal-dashboard-tile[data-terminal-id="big"]');
      return {
        canvasCount: tile?.querySelectorAll('canvas').length ?? -1,
        domRowsLen: (tile?.querySelector('.xterm-rows')?.textContent ?? '').length,
      };
    });
    expect(centered.canvasCount, 'magnified tile must stay on the DOM renderer (no WebGL canvas)').toBe(0);
    expect(centered.domRowsLen, 'magnified tile must have populated .xterm-rows (DOM renderer)').toBeGreaterThan(0);
  });
});
