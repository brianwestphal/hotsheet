/**
 * HS-8612 — demo mode forces the DOM terminal renderer, even for a full-size
 * (non-scaled) consumer that would otherwise use WebGL.
 *
 * Demo mode must render terminals via the DOM renderer so domotion-svg can
 * capture the live `<span>`-per-cell tree (a WebGL `<canvas>` can't be captured
 * that way — see §22.21). In production the server stamps
 * `window.__HOTSHEET_DEMO__` in the page `<head>` when launched with `--demo:N`;
 * `shouldUseWebglRenderer()` reads that synchronously and returns false. This
 * spec sets the same window flag via `addInitScript` (the exact seam the server
 * stamps), so it needs no demo server.
 *
 * The distinguishing assertion vs HS-8619 (`dashboard-tile-webgl-dom-renderer`):
 * there, the NON-scaled drawer pane stays on WebGL (only scaled tiles go DOM).
 * Here — under demo mode — even the non-scaled drawer pane is DOM. That isolates
 * the demo-mode gate from the scaled-consumer gate.
 *
 * Like HS-8619's spec, this RE-ENABLES WebGL (the coverage fixture force-disables
 * it). Headless Chromium ships SwiftShader WebGL2, so WebGL genuinely loads —
 * meaning without the demo gate the drawer pane WOULD render a `<canvas>`. The
 * premise is guarded below so the test can't vacuously pass.
 *
 * Verified to fail pre-fix: remove the `isDemoMode()` check in
 * `shouldUseWebglRenderer` → the drawer pane renders a WebGL `<canvas>` and the
 * `canvasCount === 0` assertion fails.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from './coverage-fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRAW_SCRIPT = path.join(__dirname, 'fixtures', 'terminal-draw.py');

let headers: Record<string, string> = {};

test.describe('Demo mode forces the DOM terminal renderer (HS-8612)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = { core: { invoke: async () => undefined } };
      // RE-ENABLE WebGL (later init script wins over the fixture's) so the
      // demo gate is the ONLY thing that can route to the DOM renderer.
      try { (window as unknown as Record<string, unknown>).__HOTSHEET_DISABLE_WEBGL__ = false; } catch { /* */ }
      // Stamp the demo flag exactly as the server's page <head> does.
      try { (window as unknown as Record<string, unknown>).__HOTSHEET_DEMO__ = true; } catch { /* */ }
    });

    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        terminals: [
          { id: 'demo-term', name: 'Demo', command: `/usr/bin/env python3 ${DRAW_SCRIPT}`, lazy: false },
        ],
      },
    });

    try { await request.post('/api/terminal/restart', { headers, data: { terminalId: 'demo-term' } }); }
    catch { /* not yet spawned — first run */ }
  });

  test('non-scaled drawer pane uses the DOM renderer under demo mode while WebGL is on', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Guard the premise: WebGL2 must actually be available + enabled and demo
    // mode on, else the test would vacuously pass.
    const env = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const w = window as unknown as Record<string, unknown>;
      return { available: gl !== null, disabled: w.__HOTSHEET_DISABLE_WEBGL__, demo: w.__HOTSHEET_DEMO__ };
    });
    expect(env.available, 'headless Chromium should provide SwiftShader WebGL2').toBe(true);
    expect(env.disabled, 'this spec must run with WebGL enabled').toBe(false);
    expect(env.demo, 'this spec must run with the demo flag set').toBe(true);

    // Open the drawer + activate the terminal so its xterm mounts as a
    // non-scaled (would-be WebGL) consumer. `#command-log-btn` TOGGLES and the
    // shared e2e server leaves drawer open-state nondeterministic across specs,
    // so converge it with a retrying toggle.
    const tab = page.locator('.drawer-terminal-tab[data-terminal-id="demo-term"]');
    await expect(async () => {
      if (!(await tab.isVisible())) {
        await page.locator('#command-log-btn').click();
      }
      await expect(tab).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await tab.click();
    await expect(page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:demo-term"] .xterm'))
      .toBeVisible({ timeout: 10000 });
    // Settle the reconcileRenderer addon decision on checkout.
    await page.waitForTimeout(1000);

    const pane = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.drawer-terminal-pane[data-drawer-panel="terminal:demo-term"]');
      return {
        canvasCount: el?.querySelectorAll('canvas').length ?? -1,
        domRowsLen: (el?.querySelector('.xterm-rows')?.textContent ?? '').length,
      };
    });
    // The non-scaled drawer pane — which WOULD use WebGL if not for demo mode —
    // must be on the DOM renderer: no `<canvas>`, populated `.xterm-rows`.
    expect(pane.canvasCount, 'demo-mode drawer pane must use the DOM renderer (no WebGL canvas)').toBe(0);
    expect(pane.domRowsLen, 'demo-mode drawer pane must have populated .xterm-rows (DOM renderer)').toBeGreaterThan(0);
  });
});
