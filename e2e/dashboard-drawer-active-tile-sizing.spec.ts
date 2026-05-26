/**
 * HS-8619 — dashboard tile sizing when the same terminal is ALSO open + active
 * in the footer drawer.
 *
 * The sibling `dashboard-tile-divergence-resize.spec.ts` already guards the
 * "every tile converges to ≈4:3 natural aspect" invariant — but it boots with
 * `drawer_open: 'false'`, so no drawer pane competes for the shared xterm. That
 * left a gap: the §54 terminal checkout shares ONE xterm per
 * `(projectSecret, terminalId)`, so the active project's drawer terminal and
 * its dashboard tile are two consumers of the SAME entry. When the dashboard
 * tile is on top, the bumped-down drawer pane's fit / onRender wiring kept
 * firing `fit.fit()` (which `term.resize`s the shared term directly, bypassing
 * the checkout handle) against the tile's geometry — fighting the tile's own
 * 4:3-native convergence. The user saw exactly this: tiles "resize weirdly" in
 * the dashboard, but ONLY for the most-recently-selected project tab (the only
 * project whose terminals have a live drawer-pane consumer), and worst when
 * magnified (the CSS scale amplifies the mis-sizing).
 *
 * The fix gates every drawer resize driver (panel ResizeObserver, window
 * resize, and the `term.onRender → doFit` convergence) on
 * `inst.checkout.isTopOfStack()`, plus a central `handle.resize` top-of-stack
 * guard in the checkout module. With the drawer pane bumped down it no longer
 * touches the shared term, so the tile converges cleanly.
 *
 * This is renderer-independent — the fight is over `cols/rows`, not pixels — so
 * it reproduces under the DOM renderer the e2e harness forces (WebGL just makes
 * the visual symptom worse by raster-scaling the mis-sized canvas). Asserting
 * 4:3 convergence under DOM is the reliable regression guard.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './coverage-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAW_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-draw.py');

let headers: Record<string, string> = {};

test.describe('Dashboard tile sizing with a drawer-active terminal (HS-8619)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });

    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        // Drawer OPEN — this is the difference from the sibling spec. The
        // active drawer terminal becomes a second consumer of the shared
        // xterm, which is the condition the bug needs.
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

  test('the drawer-active terminal tile still converges to ≈4:3 in the dashboard (HS-8619)', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer and activate the 'big' terminal so its xterm mounts in
    // the drawer pane — creating the competing drawer-pane checkout consumer.
    // `#command-log-btn` TOGGLES, and the shared e2e server leaves the drawer's
    // open-state nondeterministic across specs — converge it with a retrying
    // toggle (each pass clicks only when the tab is hidden).
    const bigTab = page.locator('.drawer-terminal-tab[data-terminal-id="big"]');
    await expect(async () => {
      if (!(await bigTab.isVisible())) {
        await page.locator('#command-log-btn').click();
      }
      await expect(bigTab).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await bigTab.click();
    // Confirm the drawer pane actually painted (xterm mounted + first render).
    await expect(
      page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:big"] .xterm-screen'),
    ).toContainText(/TOP-STATUS-BAR/, { timeout: 10000 });

    // Now open the dashboard. The 'big' tile borrows the same shared xterm
    // (bumping the drawer pane down); the other two tiles have no drawer
    // consumer.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    for (const id of ['small', 'medium', 'big']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`))
        .toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 8000 });
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"] .xterm-screen`))
        .toContainText(/TOP-STATUS-BAR/, { timeout: 10000 });
    }

    // Generous settle window: convergence is two `term.onRender` cycles, and
    // pre-fix the drawer's doFit would keep nudging the 'big' tile after that.
    await page.waitForTimeout(1500);

    const tileNaturals = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll<HTMLElement>('.terminal-dashboard-tile'));
      return tiles.map((tile) => {
        const id = tile.dataset.terminalId ?? '';
        const screen = tile.querySelector<HTMLElement>('.xterm-screen');
        if (screen === null) return { id, screenW: null, screenH: null, naturalAspect: null };
        const screenW = screen.offsetWidth;
        const screenH = screen.offsetHeight;
        const naturalAspect = screenW > 0 && screenH > 0 ? screenW / screenH : null;
        return { id, screenW, screenH, naturalAspect };
      });
    });

    const TARGET_ASPECT = 1280 / 960;
    const TOLERANCE = 0.05;

    for (const t of tileNaturals) {
      expect.soft(t.naturalAspect, `tile ${t.id} natural aspect (screenW=${t.screenW}, screenH=${t.screenH})`)
        .not.toBeNull();
      if (t.naturalAspect !== null) {
        const drift = Math.abs(t.naturalAspect - TARGET_ASPECT) / TARGET_ASPECT;
        expect.soft(drift, `tile ${t.id} drift from 4:3 (got aspect ${t.naturalAspect.toFixed(3)}, screen=${t.screenW}×${t.screenH})`)
          .toBeLessThan(TOLERANCE);
      }
    }
  });
});
