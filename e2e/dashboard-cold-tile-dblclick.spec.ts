/**
 * HS-9625 — double-clicking a dashboard tile navigates to that terminal in its
 * project's footer drawer instead of opening the in-dashboard dedicated view.
 *
 * A COLD (exited) tile is a deliberate case: the OLD dedicated path RESTARTED it
 * on double-click (HS-9486's spawn-race lived here). The new behavior is
 * "show me it", not "start it" — so a double-click on a cold tile navigates to its
 * drawer tab WITHOUT restarting the PTY and WITHOUT opening a dedicated view. The
 * drawer tab surfaces the terminal's exited state.
 *
 * (HS-9486's cold-tile spawn race still applies to the §36 drawer-embedded grid,
 * which keeps the double-click → dedicated behavior; its mechanics are unit-tested
 * in `src/client/terminalTileGridSpawnRace.test.ts`.)
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Cold dashboard tile double-click navigates to the drawer (HS-9625)', () => {
  test('opens the drawer without a dedicated view or a restart', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          home: '/home/user',
          configured: [{ id: 'dead', name: 'Dead', command: 'echo', lazy: false, bellPending: false, state: 'exited', exitCode: 1 }],
          dynamic: [],
        }),
      });
    });

    let restartCount = 0;
    await page.route('**/api/terminal/restart*', async route => {
      restartCount++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="dead"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-exited/);

    await tile.dblclick();

    // Navigated OUT of the dashboard into the project drawer — no in-dashboard
    // dedicated view ever appears, the drawer maximizes, and the cold tile is NOT
    // restarted (navigation shows the terminal, it does not start it).
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0, { timeout: 8000 });
    await expect(page.locator('.terminal-dashboard-dedicated')).toHaveCount(0);
    await expect(page.locator('.app.drawer-expanded')).toHaveCount(1, { timeout: 8000 });
    expect(restartCount).toBe(0);
  });
});
