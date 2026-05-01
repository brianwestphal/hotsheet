/**
 * HS-8051 (final fix, 2026-05-01) — `applyResizeIfChanged` regression test.
 *
 * The fourth-iteration root cause: the history-frame handler in
 * `terminalCheckout::attachWebSocketToEntry` mutates `entry.term.cols/rows`
 * directly (to the dims at which server-side scrollback was captured) and
 * deliberately does NOT update `entry.lastAppliedCols/Rows`. Pre-fix
 * `applyResizeIfChanged` compared `cols === lastApplied` to decide whether
 * to skip — so when a tile's `term.onRender` convergence loop had already
 * driven `lastApplied = (61, 48)` AND a later history-frame replay set
 * `term.cols = 80`, the next consumer-driven `handle.resize(61, 48)` was
 * spuriously skipped, leaving term stuck at the wrong size. The user's
 * Domotion → Claude tile manifested this as `screenW: 841, screenH: 1200`
 * (cols=40, rows=60 with the project's larger font giving cellW≈21.025).
 *
 * Fix: `applyResizeIfChanged` uses `entry.term.cols/rows` as the source of
 * truth for the term-resize gate, so external mutations don't fool it.
 *
 * This test exercises a different angle than the existing
 * `terminal-dashboard-tile-rendering.spec.ts` "every tile converges to ≈4:3
 * natural aspect" case — that one relies on the test harness adding a
 * fresh terminal id at runtime, which has separate setup flakiness. This
 * test bakes the larger-font terminal into the project config at boot
 * (avoiding the runtime-reconfig path) and asserts the same convergence
 * invariant: every tile's natural aspect lands within 5 % of 4:3.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './coverage-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAW_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-draw.py');

let headers: Record<string, string> = {};

test.describe('Dashboard tile resize divergence (HS-8051)', () => {
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

    // Bake the terminal config in BEFORE the page loads so the project
    // boots with all 3 terminals already known to the server (lazy=false
    // means the PTYs are spawned at project boot, not lazily on attach).
    // The 'big' terminal carries `fontSize: 22` which produces cellW≈21
    // — the regime where the user's Domotion bug manifested.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        terminals: [
          { id: 'small', name: 'Small', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
          { id: 'medium', name: 'Medium', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
          { id: 'big', name: 'Big', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false, fontSize: 22 },
        ],
      },
    });

    // Force-restart any stale PTYs so each test starts with fresh server
    // state (a previous run may have left a /bin/echo PTY around).
    for (const id of ['small', 'medium', 'big']) {
      try { await request.post('/api/terminal/restart', { headers, data: { terminalId: id } }); }
      catch { /* not yet spawned — first run */ }
    }
  });

  test('every tile converges to ≈4:3 natural aspect even when one has a larger font (HS-8051)', async ({ page }) => {
    await page.setViewportSize({ width: 1800, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the dashboard. Tiles mount in the order the project config
    // declares them.
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    // Wait for every tile to attach + render at least one xterm row.
    for (const id of ['small', 'medium', 'big']) {
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"]`))
        .toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 8000 });
      await expect(page.locator(`.terminal-dashboard-tile[data-terminal-id="${id}"] .xterm-screen`))
        .toContainText(/TOP-STATUS-BAR/, { timeout: 10000 });
    }

    // Convergence runs across two `term.onRender` cycles + the
    // history-frame replay that happens shortly after WS attach. Allow
    // generous headroom (the larger-font tile is the slow one).
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

    // Expected aspect = 1280/960 = 1.333. Allow ±5 % for cell-rounding
    // variance — the algorithm rounds `cols = round(1280 / cellW)` so
    // worst-case error is one cell wide. For cellW ≈ 8 that's ~0.6 %;
    // for cellW ≈ 22 that's ~1.7 %. 5 % gives margin without hiding
    // a real regression.
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
