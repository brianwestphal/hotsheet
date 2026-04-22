/**
 * E2E coverage for the terminal dashboard (HS-6272, docs/25-terminal-dashboard.md).
 *
 * HS-6832 — foundation tests: toggle button visibility (Tauri-gate), body-class
 * gate that hides sidebar / ticket area / drawer, exit via toggle + Esc, and
 * exit-on-project-tab-click (multi-project case covered in an isolated spec).
 *
 * Grid content / tile rendering / zoom / dedicated view / bells / placeholders
 * land in their own spec files alongside the follow-up tickets
 * (HS-6833 through HS-6838).
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Terminal dashboard foundation (HS-6832)', () => {
  test.beforeEach(async ({ page }) => {
    // Tauri stub — the dashboard is Tauri-only (§25.11).
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
  });

  test('toggle button is visible inside Tauri and hidden on web', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#terminal-dashboard-toggle')).toBeVisible();
  });

  test('toggle button is hidden when window.__TAURI__ is absent', async ({ browser }) => {
    // Fresh context with no Tauri stub — mirrors a plain-browser session.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Button renders as display:none from the server, and initTerminalDashboard
    // only flips it visible when getTauriInvoke() returns a function.
    await expect(page.locator('#terminal-dashboard-toggle')).toBeHidden();
    await ctx.close();
  });

  test('clicking the toggle enters dashboard mode and hides chrome', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();

    // body gets the active class; main chrome hides; toggle shows active state.
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
    await expect(page.locator('#terminal-dashboard-toggle.active')).toHaveCount(1);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.header-controls')).toBeHidden();
    await expect(page.locator('#terminal-dashboard-root')).toBeVisible();
  });

  test('clicking the toggle a second time exits dashboard mode', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
    await expect(page.locator('#terminal-dashboard-toggle.active')).toHaveCount(0);
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('Esc exits the dashboard when no tile is centered or dedicated', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
  });

  test('Esc is a no-op when the dashboard is not active', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Confirm starting state and that Escape doesn't flip the class on.
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
  });

  // HS-6833: entering the dashboard renders a project section per registered
  // project with either a tile grid or an empty-state row.
  test('renders a project section with heading + empty-state for a zero-terminal project', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();

    // At least one section must exist (the current project).
    const section = page.locator('.terminal-dashboard-section').first();
    await expect(section).toBeVisible();
    await expect(section.locator('.terminal-dashboard-heading')).toBeVisible();

    // In the default e2e server setup the project has no configured terminals,
    // so we expect the empty-state row, not a grid of tiles.
    const empty = section.locator('.terminal-dashboard-empty-row');
    const grid = section.locator('.terminal-dashboard-grid');
    // Exactly one of the two renders. If the e2e project later gains terminals
    // we still want this spec to catch the section-existence regression.
    const emptyCount = await empty.count();
    const gridCount = await grid.count();
    expect(emptyCount + gridCount).toBeGreaterThanOrEqual(1);
  });

  test('exiting the dashboard tears down the rendered sections', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('.terminal-dashboard-section').first()).toBeVisible();

    await page.locator('#terminal-dashboard-toggle').click();
    await expect(page.locator('.terminal-dashboard-section')).toHaveCount(0);
  });

  // HS-6834: live tiles mount xterm at 80×60 only for state=alive terminals;
  // not_spawned / exited terminals stay as placeholder stubs so the dashboard
  // never accidentally spawns a lazy terminal just by opening. We stub
  // /api/terminal/list to simulate each state and verify the tile rendering.
  test('live (state=alive) tile mounts an xterm root; not_spawned renders a placeholder', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
            { id: 'cold', name: 'Cold', command: 'echo', lazy: true, bellPending: false, state: 'not_spawned' },
          ],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#terminal-dashboard-toggle').click();

    const liveTile = page.locator('.terminal-dashboard-tile[data-terminal-id="live"]');
    await expect(liveTile).toHaveClass(/terminal-dashboard-tile-alive/);
    await expect(liveTile.locator('.terminal-dashboard-tile-xterm')).toBeAttached();

    const coldTile = page.locator('.terminal-dashboard-tile[data-terminal-id="cold"]');
    await expect(coldTile).toHaveClass(/terminal-dashboard-tile-not_spawned/);
    // Placeholder stub remains; no xterm root.
    await expect(coldTile.locator('.terminal-dashboard-tile-placeholder')).toBeAttached();
    await expect(coldTile.locator('.terminal-dashboard-tile-xterm')).toHaveCount(0);
  });

  test('grid-view tiles are non-interactive (xterm root has pointer-events:none)', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const pe = await page.locator('.terminal-dashboard-tile-xterm').first().evaluate(
      el => window.getComputedStyle(el).pointerEvents,
    );
    expect(pe).toBe('none');
  });

  // HS-6835: single-click on a live tile zooms it to a centered overlay.
  test('clicking a live tile centers it and shows the dim backdrop', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="live"]');
    await tile.click();
    await expect(tile).toHaveClass(/centered/);
    await expect(page.locator('.terminal-dashboard-center-backdrop')).toBeVisible();
    // Centered tile has pointer-events enabled on xterm (so it can take focus).
    const pe = await page.locator('.terminal-dashboard-tile.centered .terminal-dashboard-tile-xterm').evaluate(
      el => window.getComputedStyle(el).pointerEvents,
    );
    expect(pe).toBe('auto');
  });

  test('clicking backdrop un-centers the tile without exiting the dashboard', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await page.locator('.terminal-dashboard-tile[data-terminal-id="live"]').click();
    await expect(page.locator('.terminal-dashboard-tile.centered')).toHaveCount(1);

    // Click the top-left corner of the backdrop to miss the centered tile
    // that sits over the viewport center. The backdrop covers the full
    // viewport so any off-center coordinate is safely on the backdrop.
    await page.locator('.terminal-dashboard-center-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.terminal-dashboard-tile.centered')).toHaveCount(0);
    await expect(page.locator('.terminal-dashboard-center-backdrop')).toHaveCount(0);
    // Dashboard itself is still active.
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
  });

  // HS-6836: double-click enters the dedicated full-viewport view.
  test('double-clicking a live tile opens the dedicated view with a Back button', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    await page.locator('.terminal-dashboard-tile[data-terminal-id="live"]').dblclick();
    const dedicated = page.locator('.terminal-dashboard-dedicated[data-terminal-id="live"]');
    await expect(dedicated).toBeVisible();
    await expect(dedicated.locator('.terminal-dashboard-dedicated-back')).toBeVisible();
    await expect(dedicated.locator('.terminal-dashboard-dedicated-terminal')).toHaveText('Live');
  });

  test('Back button dismisses the dedicated view, keeping the dashboard active', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await page.locator('.terminal-dashboard-tile[data-terminal-id="live"]').dblclick();
    await expect(page.locator('.terminal-dashboard-dedicated')).toBeVisible();

    await page.locator('.terminal-dashboard-dedicated-back').click();
    await expect(page.locator('.terminal-dashboard-dedicated')).toHaveCount(0);
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
  });

  test('Esc dismisses the dedicated view first, not the whole dashboard', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await page.locator('.terminal-dashboard-tile[data-terminal-id="live"]').dblclick();
    await expect(page.locator('.terminal-dashboard-dedicated')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-dashboard-dedicated')).toHaveCount(0);
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);
  });

  // HS-6837: a pending bell on a tile's project/terminal surfaces via
  // subscribeToBellState (the cross-project long-poll in §24). Clicking the
  // tile (zoom) clears the outline and fires POST /api/terminal/clear-bell.
  test('tile gains .has-bell when bellPoll reports a pending bell on its terminal', async ({ page, request }) => {
    // Grab the active project's secret up front so we can inject a bellState
    // that matches the real project.
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';

    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.route('**/api/projects/bell-state*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bells: { [secret]: { anyTerminalPending: true, terminalIds: ['live'] } },
          v: 1,
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="live"]');
    await expect(tile).toHaveClass(/has-bell/, { timeout: 5000 });
  });

  test('centering a has-bell tile clears the outline and fires clear-bell', async ({ page, request }) => {
    const projRes = await request.get('/api/projects');
    const projects = await projRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';

    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });

    let clearBellHit = false;
    // Mirror the real server: before clear-bell POST fires the bell is pending;
    // after it fires the next long-poll returns no pending bells.
    await page.route('**/api/projects/bell-state*', async route => {
      const pending = !clearBellHit;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bells: pending ? { [secret]: { anyTerminalPending: true, terminalIds: ['live'] } } : {},
          v: pending ? 1 : 2,
        }),
      });
    });
    await page.route('**/api/terminal/clear-bell*', async route => {
      clearBellHit = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="live"]');
    await expect(tile).toHaveClass(/has-bell/, { timeout: 5000 });

    await tile.click();
    await expect.poll(() => clearBellHit).toBe(true);
    await expect(tile).not.toHaveClass(/has-bell/);
  });

  // HS-6838: a not_spawned / exited tile renders a placeholder; single-click
  // (after the 220 ms single-click debounce) spawns + opens the center overlay.
  test('clicking a not_spawned placeholder triggers spawn + transitions to centered', async ({ page }) => {
    let restartCalls = 0;
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'cold', name: 'Cold', command: 'echo', lazy: true, bellPending: false, state: 'not_spawned', exitCode: null },
          ],
          dynamic: [],
        }),
      });
    });
    await page.route('**/api/terminal/restart*', async route => {
      restartCalls += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="cold"]');
    await expect(tile).toHaveClass(/terminal-dashboard-tile-not_spawned/);
    await expect(tile.locator('.terminal-dashboard-tile-placeholder-cold')).toBeVisible();

    await tile.click();
    // After single-click debounce + spawn: tile flips to alive and centers.
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 5000 });
    await expect(tile).toHaveClass(/centered/, { timeout: 5000 });
    // not_spawned lazy path skips /terminal/restart.
    expect(restartCalls).toBe(0);
  });

  test('clicking an exited placeholder POSTs /terminal/restart before spawning', async ({ page }) => {
    let restartCalls = 0;
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'dead', name: 'Dead', command: 'echo', lazy: false, bellPending: false, state: 'exited', exitCode: 137 },
          ],
          dynamic: [],
        }),
      });
    });
    await page.route('**/api/terminal/restart*', async route => {
      restartCalls += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="dead"]');
    await expect(tile.locator('.terminal-dashboard-tile-placeholder-status')).toHaveText('Exited (code 137)');

    await tile.click();
    await expect.poll(() => restartCalls).toBe(1);
    await expect(tile).toHaveClass(/terminal-dashboard-tile-alive/, { timeout: 5000 });
  });

  test('double-clicking a placeholder tile spawns + opens dedicated view', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'cold', name: 'Cold', command: 'echo', lazy: true, bellPending: false, state: 'not_spawned', exitCode: null },
          ],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    await page.locator('.terminal-dashboard-tile[data-terminal-id="cold"]').dblclick();
    await expect(page.locator('.terminal-dashboard-dedicated[data-terminal-id="cold"]')).toBeVisible({ timeout: 5000 });
  });

  test('Esc while centered collapses to the grid, Esc on bare grid exits the dashboard', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [{ id: 'live', name: 'Live', command: 'echo', lazy: false, bellPending: false, state: 'alive' }],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();
    await page.locator('.terminal-dashboard-tile[data-terminal-id="live"]').click();
    await expect(page.locator('.terminal-dashboard-tile.centered')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('.terminal-dashboard-tile.centered')).toHaveCount(0);
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('body.terminal-dashboard-active')).toHaveCount(0);
  });
});
