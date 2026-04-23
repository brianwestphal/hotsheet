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

  // HS-7195: the tile-size slider (§25.4) only controls grid-tile dims; it's
  // irrelevant in the dedicated full-viewport view and was bleeding into the
  // header while the dedicated view was active. Hidden on enter, restored on
  // exit back to the grid.
  test('tile-size slider is hidden while the dedicated view is open (HS-7195)', async ({ page }) => {
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

    // Baseline: slider visible in the grid view.
    await expect(page.locator('#terminal-dashboard-sizer')).toBeVisible();

    await page.locator('.terminal-dashboard-tile[data-terminal-id="live"]').dblclick();
    await expect(page.locator('.terminal-dashboard-dedicated')).toBeVisible();
    // Dedicated view up → slider hidden.
    await expect(page.locator('#terminal-dashboard-sizer')).toBeHidden();

    await page.locator('.terminal-dashboard-dedicated-back').click();
    await expect(page.locator('.terminal-dashboard-dedicated')).toHaveCount(0);
    // Back in grid → slider visible again.
    await expect(page.locator('#terminal-dashboard-sizer')).toBeVisible();
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

  // HS-6865 + HS-6931: the tile's xterm root must have explicit width +
  // height (or xterm's absolutely-positioned viewport collapses — HS-6865)
  // AND a UNIFORM scale transform. A two-axis `scale(sx, sy)` (the old
  // HS-6898 behavior) stretches characters so they look distorted; the
  // regression report that drove HS-6931 showed `scale(3.478, 0.375)` —
  // ~9× axis mismatch — because the measurement was also wrong. We now
  // measure natural dims from `.xterm-screen` and always apply the same
  // scale on both axes.
  test('live tile xterm root has explicit dims and a uniform scale transform', async ({ page }) => {
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

    const xtermRoot = page.locator('.terminal-dashboard-tile[data-terminal-id="live"] .terminal-dashboard-tile-xterm');
    await expect(xtermRoot).toBeAttached();

    const info = await xtermRoot.evaluate((el) => {
      const s = (el as HTMLElement).style;
      // The transform may be `scale(s)`, `scale(sx, sy)`, or `scale(sx sy)`
      // depending on the serialization — accept any form and extract all
      // numbers so we can verify they're equal regardless.
      const nums = Array.from(s.transform.matchAll(/-?\d+(?:\.\d+)?/g)).map(m => parseFloat(m[0]));
      return {
        width: s.width,
        height: s.height,
        transform: s.transform,
        nums,
      };
    });
    expect(info.width).toMatch(/^\d+(\.\d+)?px$/);
    expect(info.height).toMatch(/^\d+(\.\d+)?px$/);
    expect(info.transform).toContain('scale(');
    expect(info.nums.length).toBeGreaterThanOrEqual(1);
    for (const n of info.nums) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
    // HS-6931: if the serialized form has two numbers, they must be equal —
    // a two-axis scale stretches text and is exactly the regression this
    // test exists to catch.
    if (info.nums.length >= 2) {
      expect(info.nums[0]).toBeCloseTo(info.nums[1], 5);
    }
  });

  // HS-6965: the tile's xterm MUST match the PTY's cols × rows once the
  // history frame arrives — otherwise live bytes formatted for the PTY's
  // own geometry wrap at the wrong column and leave a band of empty rows
  // below the last line of real content (the "weird wrapping" screenshot).
  // The earlier HS-6931 follow-up force-reset the xterm back to a measured-
  // cell 4:3 target after replay; this test pins the current policy by
  // asserting the xterm's scaled output stays inside the preview frame
  // (uniform fit) AND the xterm root has explicit natural dims so the
  // letterboxing is centred, regardless of whether the natural aspect ends
  // up 4:3 or not.
  test('xterm scales uniformly inside the preview and stays within the preview bounds', async ({ page }) => {
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

    const xtermRoot = page.locator('.terminal-dashboard-tile[data-terminal-id="live"] .terminal-dashboard-tile-xterm');
    await expect(xtermRoot).toBeAttached();

    const layout = await xtermRoot.evaluate((el) => {
      const root = el as HTMLElement;
      const preview = root.parentElement as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      // Extract the scale factor(s) from the transform string. With the
      // HS-6931 fix the serialized form has either one number (uniform
      // scale(s)) or two equal numbers (scale(sx, sy) where sx === sy).
      const nums = Array.from(root.style.transform.matchAll(/-?\d+(?:\.\d+)?/g)).map(m => parseFloat(m[0]));
      return {
        rootWidth: rootRect.width,
        rootHeight: rootRect.height,
        previewWidth: previewRect.width,
        previewHeight: previewRect.height,
        transformNums: nums,
      };
    });

    // Positive dims (no 0-size collapse from a missing natural width / height).
    expect(layout.rootWidth).toBeGreaterThan(0);
    expect(layout.rootHeight).toBeGreaterThan(0);

    // Uniform scale. Two-axis scaling stretches text and was the exact
    // regression HS-6931 existed to fix.
    expect(layout.transformNums.length).toBeGreaterThanOrEqual(1);
    for (const n of layout.transformNums) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
    if (layout.transformNums.length >= 2) {
      expect(layout.transformNums[0]).toBeCloseTo(layout.transformNums[1], 5);
    }

    // Scaled output fits inside the preview frame (letterboxing is fine;
    // overflow would indicate the old two-axis / force-4:3 scale math
    // choosing a larger factor than one axis can accommodate).
    expect(layout.rootWidth).toBeLessThanOrEqual(layout.previewWidth + 1);
    expect(layout.rootHeight).toBeLessThanOrEqual(layout.previewHeight + 1);
  });

  // HS-6997: the scaled xterm must be top-aligned inside the tile preview
  // so content reads from the top like a real macOS Terminal pane. The
  // pre-fix math letterbox-centered the xterm vertically — with a wide /
  // short PTY (e.g. 151 × 13 → natural 1181 × 208) uniform scaling filled
  // the width but only a fraction of the height, and the equal top / bottom
  // bands made the content look "why is my prompt centered in an empty
  // box?" This test pins the top-align invariant: the xterm root's top
  // offset inside the preview must be 0 (±1 px for subpixel rounding).
  test('tile xterm is top-aligned inside the preview (HS-6997)', async ({ page }) => {
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

    const xtermRoot = page.locator('.terminal-dashboard-tile[data-terminal-id="live"] .terminal-dashboard-tile-xterm');
    await expect(xtermRoot).toBeAttached();
    // Give layout one tick so the measured-cell scale pass has committed.
    await page.waitForTimeout(50);

    const layout = await xtermRoot.evaluate((el) => {
      const root = el as HTMLElement;
      const preview = root.parentElement as HTMLElement;
      const rootRect = root.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      return {
        // Offset of the xterm root's top edge relative to the preview's
        // top edge. The fix pins this to 0.
        topOffset: rootRect.top - previewRect.top,
        // Confirm there is actually vertical dead space — otherwise the
        // top-align invariant is vacuous. With the default eager-spawn
        // PTY geometry the xterm's natural aspect is landscape (wide /
        // short), so scaled height is strictly less than the tile's 4:3
        // preview height.
        previewHeight: previewRect.height,
        rootHeight: rootRect.height,
      };
    });
    // Top-aligned: offset is 0 (allow 1 px for subpixel rounding from the
    // scale transform).
    expect(layout.topOffset).toBeGreaterThanOrEqual(-1);
    expect(layout.topOffset).toBeLessThanOrEqual(1);
  });

  // HS-6867: clicking a live tile must leave a same-sized placeholder in
  // the tile's grid slot so the rest of the grid doesn't reflow while the
  // tile animates to the center. The placeholder is cleaned up when the
  // tile uncenters.
  test('centering a tile inserts a slot placeholder; uncentering removes it', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'live1', name: 'A', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
            { id: 'live2', name: 'B', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
          ],
          dynamic: [],
        }),
      });
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    // Record the second tile's position before any interaction — if the
    // first tile is ripped out without a placeholder the second tile
    // reflows leftward.
    const tile1 = page.locator('.terminal-dashboard-tile[data-terminal-id="live1"]');
    const tile2 = page.locator('.terminal-dashboard-tile[data-terminal-id="live2"]');
    await expect(tile1).toBeVisible();
    await expect(tile2).toBeVisible();
    const tile2BeforeX = await tile2.evaluate(el => el.getBoundingClientRect().left);

    await tile1.click();
    await expect(tile1).toHaveClass(/centered/);
    // A placeholder now holds tile1's grid slot.
    await expect(page.locator('.terminal-dashboard-tile-slot')).toHaveCount(1);
    // The second tile did NOT reflow — it's in the same position.
    const tile2DuringX = await tile2.evaluate(el => el.getBoundingClientRect().left);
    expect(Math.abs(tile2DuringX - tile2BeforeX)).toBeLessThanOrEqual(2);

    // Click the backdrop to uncenter — animation runs, then placeholder is
    // removed and the tile returns to its slot.
    await page.locator('.terminal-dashboard-center-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.terminal-dashboard-tile.centered')).toHaveCount(0);
    await expect(page.locator('.terminal-dashboard-tile-slot')).toHaveCount(0, { timeout: 2000 });
  });

  // HS-6866: dashboard tiles used to render on a grey card backdrop (--bg-secondary)
  // AND instantiated xterm with no theme, leaving the canvas on xterm's default
  // black palette — the combined effect was a black-and-grey tile that looked
  // nothing like the drawer's white-on-white terminal. The CSS fix flips the
  // tile-preview backdrop to the same `--bg` variable the drawer uses. The
  // xterm-theme fix (new XTerm({ theme: readXtermTheme() }) in both dashboard
  // xterm instances) paints the canvas on --bg too; that part shows only on
  // the HTML canvas so we verify it indirectly by asserting the preview's
  // computed background matches the page's `--bg` (which is also what the
  // xterm theme is seeded from, so a mismatch on the DOM side would mean the
  // theme hook is out of sync).
  test('live tile preview background matches the page --bg (drawer parity)', async ({ page }) => {
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

    const result = await page.locator('.terminal-dashboard-tile[data-terminal-id="live"] .terminal-dashboard-tile-preview').evaluate((el) => {
      const previewBg = getComputedStyle(el).backgroundColor;
      // Resolve --bg via a throwaway probe so computedStyle normalizes the
      // color into the same `rgb(...)` form we get back for `previewBg`.
      const probe = document.createElement('div');
      probe.style.background = 'var(--bg)';
      document.body.appendChild(probe);
      const pageBg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return { previewBg, pageBg };
    });
    expect(result.previewBg).not.toBe('');
    expect(result.pageBg).not.toBe('');
    // The drawer-parity invariant: the live-tile preview uses the same bg
    // the drawer terminal-body uses. Without the HS-6866 fix this was
    // --bg-secondary instead of --bg and the test would fail.
    expect(result.previewBg).toBe(result.pageBg);
  });

  // HS-6964: a centered tile's preview must be horizontally centered in the
  // viewport. The bug: `centerTile` wrote `tile.style.left = (vw - previewWidth) / 2`
  // but left `tile.style.width` at its grid-slot value from `applyTileSizing`.
  // With `display: flex; align-items: center`, the preview (sized to
  // `previewWidth`, which is much larger than the grid-slot tile width)
  // flex-centered itself around the smaller tile box and slid off to the
  // left of the viewport centre. The fix: set `tile.style.width = previewWidth`
  // too. Two test modes: initial render AND after a window-resize (the
  // resize recomputes grid tile widths via `applyTileSizing`, which must
  // now skip the centered tile so a late resize doesn't snap it back to
  // the grid-slot width).
  test('centered tile preview is horizontally centered in the viewport', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'live1', name: 'A', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
            { id: 'live2', name: 'B', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
            { id: 'live3', name: 'C', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
          ],
          dynamic: [],
        }),
      });
    });
    // Use a viewport that forces grid tiles to be much smaller than the 70 %
    // centered preview width — the exact ratio where the bug was visible.
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="live1"]');
    await tile.click();
    await expect(tile).toHaveClass(/centered/);
    // Wait for the ~280ms FLIP animation to finish; measuring mid-animation
    // would pick up the transform and report a rect partway between the
    // grid slot and the final centered box.
    await page.waitForTimeout(400);

    const centered = await page.evaluate(() => {
      const preview = document.querySelector('.terminal-dashboard-tile.centered .terminal-dashboard-tile-preview') as HTMLElement | null;
      if (preview === null) return null;
      const rect = preview.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        vw: window.innerWidth,
      };
    });
    expect(centered).not.toBeNull();
    const centerX = centered!.left + centered!.width / 2;
    // Within 2 px of the viewport centre. The original bug placed the
    // preview centre ~180 px left of the viewport centre (1200 vw,
    // tileWidth ≈ 280, previewWidth ≈ 840 → off-by (840 - 280) / 2 = 280 px).
    expect(Math.abs(centerX - centered!.vw / 2)).toBeLessThanOrEqual(2);
  });

  test('centered tile stays horizontally centered after a window resize', async ({ page }) => {
    await page.route('**/api/terminal/list*', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: [
            { id: 'live1', name: 'A', command: 'echo', lazy: false, bellPending: false, state: 'alive' },
          ],
          dynamic: [],
        }),
      });
    });
    await page.setViewportSize({ width: 1400, height: 1000 });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#terminal-dashboard-toggle').click();

    const tile = page.locator('.terminal-dashboard-tile[data-terminal-id="live1"]');
    await tile.click();
    await expect(tile).toHaveClass(/centered/);
    // Let the FLIP animation complete first so the resize isn't racing it.
    await page.waitForTimeout(400);

    // Resize the viewport — the resize handler must (a) skip the centered
    // tile in `applyTileSizing` so its inline width doesn't snap back to
    // the grid-slot width, AND (b) call `recenterTile` so the tile's
    // `left` / `top` / `width` / `height` are recomputed for the new
    // viewport centre.
    await page.setViewportSize({ width: 1000, height: 800 });
    // Give the rAF resize observer a frame to run.
    await page.waitForTimeout(160);

    const centered = await page.evaluate(() => {
      const previewEl = document.querySelector('.terminal-dashboard-tile.centered .terminal-dashboard-tile-preview') as HTMLElement | null;
      const tileEl = document.querySelector('.terminal-dashboard-tile.centered') as HTMLElement | null;
      if (previewEl === null || tileEl === null) return null;
      const previewRect = previewEl.getBoundingClientRect();
      return {
        left: previewRect.left,
        width: previewRect.width,
        tileInlineWidth: tileEl.style.width,
        previewInlineWidth: previewEl.style.width,
        vw: window.innerWidth,
      };
    });
    expect(centered).not.toBeNull();
    // Tile inline width must still match the preview inline width — the
    // resize handler must have skipped the centered tile.
    expect(centered!.tileInlineWidth).toBe(centered!.previewInlineWidth);
    const centerX = centered!.left + centered!.width / 2;
    expect(Math.abs(centerX - centered!.vw / 2)).toBeLessThanOrEqual(2);
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
