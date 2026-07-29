/**
 * HS-9486 — double-clicking a COLD dashboard tile must run one spawn and land
 * in one view.
 *
 * `spawnAndEnlarge` sets `tile.state = 'alive'` only AFTER awaiting
 * `restartTerminal`, and both enlarge entry points gate on `state !== 'alive'`.
 * macOS's double-click threshold (~500 ms) is well past the 220 ms
 * `SINGLE_CLICK_DELAY_MS`, so the single-click timer fires first and starts a
 * spawn asking for `center`; the `dblclick` then arrives mid-flight, still sees
 * a non-alive tile, and starts a second spawn asking for `dedicated`. The user
 * ends up with a centered overlay and a dedicated view both up (or a centered
 * tile stranded underneath), and two restarts against one PTY.
 *
 * The restart route is stubbed with a deliberate delay: the in-flight window is
 * normally however long the HTTP call takes, and a test that raced it would be
 * flaky in exactly the direction that hides the bug.
 */
import { expect, test } from './coverage-fixture.js';

/** Comfortably past `SINGLE_CLICK_DELAY_MS` (220 ms) — the real single-click
 *  timer must fire and start its spawn BEFORE the dblclick lands, which is the
 *  ordering that produces the bug. Chromium has no OS double-click threshold to
 *  respect, so the two events are dispatched explicitly. */
const PAST_SINGLE_CLICK_DELAY_MS = 300;
/** How long the stubbed restart hangs — long enough that the dblclick is
 *  guaranteed to arrive while the spawn is still in flight. */
const RESTART_DELAY_MS = 1200;

test.describe('Cold dashboard tile double-click (HS-9486)', () => {
  test('runs one restart and opens only the dedicated view', async ({ page }) => {
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
      await new Promise(r => setTimeout(r, RESTART_DELAY_MS));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="dead"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-exited/);

    // Single click, wait past the debounce so its timer fires a spawn, then
    // double-click into the still-running restart.
    await tile.click();
    await page.waitForTimeout(PAST_SINGLE_CLICK_DELAY_MS);
    await tile.dblclick();

    const dedicated = page.locator('.terminal-dashboard-dedicated');
    await expect(dedicated).toBeVisible({ timeout: 10000 });

    // The latest request wins, and nothing else is left open underneath.
    await expect(page.locator('.terminal-dashboard-center-backdrop')).toHaveCount(0);
    expect(restartCount).toBe(1);
  });
});
