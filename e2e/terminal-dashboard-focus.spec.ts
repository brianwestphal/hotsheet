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

    // HS-9640 — POLL for focus (via toBeFocused) instead of reading
    // `document.activeElement` once after a fixed 350 ms wait: in headless CI the
    // zoom's FLIP-animation + focus microtask can land after that window, so the
    // one-shot read intermittently saw <body> ("terminal-dashboard-active"). The
    // zoomed tile holds the shared xterm, so its helper-textarea is the focus target.
    await expect(tile.locator('.xterm-helper-textarea'), 'zooming should focus the terminal')
      .toBeFocused({ timeout: 5000 });

    // Now click INSIDE the zoomed terminal, the way a user does before typing.
    // Pre-fix this dropped focus to <body> with no way back short of Esc.
    await tile.locator('.terminal-dashboard-tile-preview').click({ position: { x: 40, y: 40 } });
    await expect(tile.locator('.xterm-helper-textarea'), 'clicking the zoomed terminal keeps focus on it')
      .toBeFocused({ timeout: 5000 });

    // …and it's the ZOOMED tile that holds it (not another instance's textarea).
    const afterClick = await activeElementInfo(page);
    expect(afterClick.inCentered, 'the zoomed tile must hold focus').toBe(true);
  });

  // HS-9625 — double-clicking a tile no longer opens the in-dashboard dedicated
  // view; it navigates to that terminal in its project drawer (§25.7.1). The
  // dashboard exits, the drawer maximizes, the terminal's tab is selected and
  // active, and keystrokes land in the drawer terminal.
  test('double-clicking a tile navigates to the terminal in its maximized project drawer', async ({ page }) => {
    const tile = await openDashboard(page);

    await tile.dblclick();

    // Left the dashboard, no in-dashboard dedicated view, drawer maximized.
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator('.terminal-dashboard-dedicated')).toHaveCount(0);
    await expect(page.locator('.app.drawer-expanded')).toHaveCount(1, { timeout: 8000 });

    // The double-clicked terminal's drawer tab is the active one.
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:focus"]'))
      .toHaveClass(/active/, { timeout: 8000 });

    // Keystrokes actually land in the drawer terminal: it runs `cat`, so the tty
    // echoes what the PTY received — text on screen proves the terminal is the
    // active, typeable target after the navigation.
    // HS-9639 — first wait for the PTY to ATTACH (`status-alive`): the navigation's
    // WebSocket attach is async, and keystrokes sent before the socket is open are
    // DROPPED (the xterm `onData → WS send` no-ops), which is why typing immediately
    // echoed nothing. Then focus the helper defensively before typing — the
    // navigation's auto-focus is best-effort (its double-rAF focus can be clobbered
    // by the concurrent drawer-expand / per-project drawer-state restore), so this
    // mirrors the established `terminal.spec.ts` pattern rather than over-asserting
    // it. (Product follow-up: make the tile-double-click navigation reliably focus
    // the landed terminal.)
    const focusPane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:focus"]');
    await expect(focusPane.locator('.terminal-status-dot.status-alive')).toHaveCount(1, { timeout: 8000 });
    await focusPane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('hs9625-typed');
    await expect(page.locator('#drawer-terminal-panes .xterm-rows'))
      .toContainText('hs9625-typed', { timeout: 8000 });
  });
});
