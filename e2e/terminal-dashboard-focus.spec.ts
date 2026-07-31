/**
 * HS-9484 — enlarging a dashboard tile must not cost keyboard focus.
 *
 * Reported as "after clicking to zoom a terminal or double-clicking to maximize
 * a terminal, the terminal often loses keyboard focus". Two independent causes:
 *
 *   - Zoom: a centered tile renders its xterm `pointer-events: none` (HS-8010),
 *     so a click in the terminal area lands on the tile root, which cannot hold
 *     focus. The browser blurs the helper textarea and — since HS-8157 made that
 *     click a deliberate no-op — nothing puts focus back.
 *   - Maximize: double-clicking an already-centered tile uncenters it (deferring
 *     the HS-9200 `term.blur()` behind a 280 ms transition) and then opens the
 *     dedicated view, which focuses. Both share ONE xterm per terminal, so the
 *     blur landed a third of a second AFTER the maximized terminal took focus.
 *
 * The unit tests in `src/client/terminalTileGrid.test.ts` pin the call ordering;
 * these drive the real thing and assert on `document.activeElement`, which is
 * what actually decides where the user's keystrokes go.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

/** Where do keystrokes go right now? */
async function activeElementInfo(page: Page): Promise<{
  tag: string; className: string; inCentered: boolean; inDedicated: boolean;
}> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el === null ? 'none' : el.tagName.toLowerCase(),
      className: el === null ? '' : el.className,
      inCentered: el?.closest('.terminal-dashboard-tile.centered') !== null && el?.closest('.terminal-dashboard-tile.centered') !== undefined,
      inDedicated: el?.closest('.terminal-dashboard-dedicated') !== null && el?.closest('.terminal-dashboard-dedicated') !== undefined,
    };
  });
}

test.describe('Terminal dashboard — focus survives zoom + maximize (HS-9484)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // The dashboard is Tauri-gated.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: () => Promise.resolve(undefined) },
      };
    });
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        terminals: [{ id: 'focus', name: 'Focus', command: '/bin/cat', lazy: false }],
      },
    });
    try {
      await request.post('/api/terminal/restart', { headers, data: { terminalId: 'focus' } });
    } catch { /* not yet spawned — first run */ }
  });

  /** Open the dashboard and return the live tile locator. */
  async function openDashboard(page: Page) {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="focus"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 8000 });
    return tile;
  }

  test('clicking inside a zoomed tile keeps keyboard focus on the terminal', async ({ page }) => {
    const tile = await openDashboard(page);

    // Single click zooms (the handler is debounced 220 ms to let dblclick win).
    await tile.click();
    await expect(tile).toHaveClass(/centered/, { timeout: 5000 });
    await page.waitForTimeout(350); // let the FLIP animation + focus microtask settle

    const afterZoom = await activeElementInfo(page);
    expect(afterZoom.className, 'zooming should focus the terminal').toContain('xterm-helper-textarea');

    // Now click INSIDE the zoomed terminal, the way a user does before typing.
    // Pre-fix this dropped focus to <body> with no way back short of Esc.
    await tile.locator('.terminal-dashboard-tile-preview').click({ position: { x: 40, y: 40 } });
    await page.waitForTimeout(150);

    const afterClick = await activeElementInfo(page);
    expect(afterClick.tag, 'focus must not fall back to the document body').not.toBe('body');
    expect(afterClick.className).toContain('xterm-helper-textarea');
    expect(afterClick.inCentered, 'and it must be the zoomed tile that holds it').toBe(true);
  });

  test('double-clicking a zoomed tile leaves the maximized terminal focused', async ({ page }) => {
    const tile = await openDashboard(page);

    await tile.click();
    await expect(tile).toHaveClass(/centered/, { timeout: 5000 });
    await page.waitForTimeout(350);

    await tile.dblclick();
    await expect(page.locator('.terminal-dashboard-dedicated')).toBeVisible({ timeout: 5000 });

    // Wait past the uncenter transition AND its `CENTER_ANIMATION_MS + 80`
    // fallback: pre-fix, focus worked for ~300 ms and THEN died, which is
    // exactly what made this read as "often" loses focus.
    await page.waitForTimeout(600);

    const info = await activeElementInfo(page);
    expect(info.tag, 'focus must not have fallen back to the document body').not.toBe('body');
    expect(info.className).toContain('xterm-helper-textarea');
    expect(info.inDedicated, 'the maximized terminal should hold focus').toBe(true);

    // And the behavior underneath the assertion: keystrokes actually land. The
    // terminal runs `cat`, so the tty echoes what the PTY received — text on
    // screen is proof the focus above is the useful kind. `.xterm-rows`, not
    // `.xterm-screen`, whose textContent leads with an injected <style> block.
    await page.keyboard.type('hs9484-typed');
    await expect(page.locator('.terminal-dashboard-dedicated .xterm-rows'))
      .toContainText('hs9484-typed', { timeout: 8000 });
  });
});
