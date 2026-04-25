/**
 * E2E coverage for the drawer terminal grid view (docs/36-drawer-terminal-grid.md).
 *
 * HS-6311. The drawer gains a toggle button that swaps the drawer body from the
 * normal per-terminal tab stack to a grid of scaled-down tiles covering every
 * terminal in the CURRENT project. Behaviour mirrors the global Terminal
 * Dashboard (§25) but scoped to one project. These tests exercise the full
 * enter/exit lifecycle, the ≤1-terminal disabled state, and the slider/tile
 * rendering.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Drawer terminal grid view (HS-6311)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // Tauri-only UI gate: stub __TAURI__ before the bundle loads so the
    // drawer grid toggle button becomes visible. Without this the toggle
    // isn't rendered at all (§36.8 / §22.11).
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });
    // Clear any lingering dynamic terminals so the toggle-enable count is
    // driven entirely by the configured fixture below.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* first-time */ }
  });

  test('toggle disabled with ≤1 terminal; enabled + toggles grid mode with ≥2', async ({ page, request }) => {
    // First fixture: single configured terminal so the toggle is disabled.
    // Open the drawer via the saved setting so we don't have to rely on a
    // click (the #command-log-btn toggle semantics can interact with prior
    // test state).
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'only', name: 'Only', command: '/bin/echo only', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const toggle = page.locator('#drawer-grid-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();

    // Now add a second configured terminal. The server /terminal/list response
    // drives the toggle's enabled state — terminal.tsx's loadAndRenderTerminalTabs
    // calls onTerminalListUpdated() on every refresh. Keep drawer_open=true on
    // the PATCH so the reload below restores the drawer without us needing a
    // second click (which would toggle the already-open drawer CLOSED).
    await request.patch('/api/file-settings', {
      headers,
      data: {
        drawer_open: 'true',
        terminals: [
          { id: 'only', name: 'Only', command: '/bin/echo only', lazy: true },
          { id: 'other', name: 'Other', command: '/bin/echo other', lazy: true },
        ],
      },
    });
    // Refresh the drawer (which refreshes the terminal list) — simplest via
    // re-goto since Playwright stubs persist via addInitScript.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });
    await expect(toggle).toBeEnabled({ timeout: 5000 });

    // Click the toggle — grid container should become visible + slider too.
    await toggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();
    await expect(page.locator('#drawer-grid-sizer')).toBeVisible();
    await expect(toggle).toHaveClass(/active/);

    // Two tiles render, one per configured terminal.
    await expect(page.locator('.drawer-terminal-grid-tile')).toHaveCount(2);
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="only"]')).toBeVisible();
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="other"]')).toBeVisible();

    // Clicking the toggle again exits grid mode — grid hides, slider hides,
    // the previously-active drawer tab (commands-log by default) is revealed.
    await toggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeHidden();
    await expect(page.locator('#drawer-grid-sizer')).toBeHidden();
    await expect(toggle).not.toHaveClass(/active/);
    await expect(page.locator('#drawer-panel-commands-log')).toBeVisible();
  });

  test('slider value persists per project (in-session only)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'a', name: 'A', command: '/bin/echo a', lazy: true },
          { id: 'b', name: 'B', command: '/bin/echo b', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const toggle = page.locator('#drawer-grid-toggle');
    await expect(toggle).toBeEnabled({ timeout: 5000 });
    await toggle.click();

    // Set a non-default slider value and verify it sticks after exit+re-enter
    // within the same session.
    const slider = page.locator('#drawer-grid-size-slider');
    await slider.fill('60');
    await slider.dispatchEvent('input');
    await toggle.click(); // exit
    await expect(page.locator('#drawer-terminal-grid')).toBeHidden();
    await toggle.click(); // re-enter
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();
    // Slider should reflect the saved-per-project value (may snap to a nearby
    // N-tiles-per-row position, but should be close to 60). We check the
    // value is in range rather than exact to allow for snap-point snapping.
    const val = Number(await slider.inputValue());
    expect(val).toBeGreaterThan(30);
    expect(val).toBeLessThan(100);
  });

  // HS-7659 — when a tile is enlarged (centered or in dedicated view) inside
  // the drawer grid, the maximized terminal should render at an app-level
  // overlay (full viewport), NOT by expanding the drawer panel. Earlier
  // implementations (the original HS-7659/HS-7660 fix) auto-expanded the
  // drawer + hid the expand button, which broke the chrome on exit. The
  // current fix uses centerScope: 'viewport' + position-fixed CSS so the
  // overlay covers the whole window without touching the drawer's expanded
  // state — the expand button + slider stay visible and untouched.
  test('enlarging a tile renders at viewport scope and leaves drawer chrome untouched (HS-7659)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        drawer_expanded: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'a', name: 'A', command: '/bin/echo a', lazy: true },
          { id: 'b', name: 'B', command: '/bin/echo b', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    // Baseline: drawer NOT expanded; expand button + grid sizer become
    // visible once we enter grid mode. The drawer-expanded class on .app
    // should stay absent throughout.
    const expandBtn = page.locator('#drawer-expand-btn');
    const sizer = page.locator('#drawer-grid-sizer');
    await expect(page.locator('.app.drawer-expanded')).toHaveCount(0);

    // Enter grid mode.
    const toggle = page.locator('#drawer-grid-toggle');
    await expect(toggle).toBeEnabled({ timeout: 5000 });
    await toggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();
    await expect(expandBtn).toBeVisible();
    await expect(sizer).toBeVisible();

    // Single-click a tile — spawns + centers since both tiles are lazy and
    // start as `not_spawned` placeholders.
    await page.locator('.drawer-terminal-grid-tile[data-terminal-id="a"]').click();

    // The centered tile should be at viewport scope: position-fixed with
    // dimensions that exceed the drawer's height (the drawer is short by
    // default, so any tile larger than ~200px tall is breaking out of it).
    const centered = page.locator('.drawer-terminal-grid-tile.centered');
    await expect(centered).toBeVisible({ timeout: 5000 });
    const tileBox = await centered.boundingBox();
    if (tileBox === null) throw new Error('centered tile has no bounding box');
    // Default test viewport is around 1280x720; centerSizeFrac is 0.7 so the
    // tile should be at least ~400 px tall — much larger than the drawer
    // band ever is.
    expect(tileBox.height).toBeGreaterThan(300);

    // Drawer expanded state is unchanged: no `.app.drawer-expanded`, expand
    // button + sizer still visible.
    await expect(page.locator('.app.drawer-expanded')).toHaveCount(0);
    await expect(expandBtn).toBeVisible();
    await expect(sizer).toBeVisible();
    // The legacy body class from the prior fix should NOT be present.
    await expect(page.locator('body.drawer-grid-tile-enlarged')).toHaveCount(0);

    // Press Esc to uncenter. Chrome remains visible and untouched.
    await page.keyboard.press('Escape');
    await expect(centered).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.app.drawer-expanded')).toHaveCount(0);
    await expect(expandBtn).toBeVisible();
    await expect(sizer).toBeVisible();
  });

  // HS-7658 — the drawer-grid toggle button used to render top-aligned in
  // the toolbar row because `.drawer-tabs-end` is `align-items: stretch` and
  // the toggle has a fixed 26 × 26 px size. align-self: center pins it to
  // the row's vertical centre, matching the expand button on the right.
  test('drawer-grid toggle button is vertically centered in the toolbar (HS-7658)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        terminals: [
          { id: 'a', name: 'A', command: '/bin/echo a', lazy: true },
          { id: 'b', name: 'B', command: '/bin/echo b', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const toggle = page.locator('#drawer-grid-toggle');
    const expandBtn = page.locator('#drawer-expand-btn');
    await expect(toggle).toBeVisible({ timeout: 5000 });
    await expect(expandBtn).toBeVisible();

    // Compare vertical centers — should match within 1 px (anti-aliasing).
    const toggleBox = await toggle.boundingBox();
    const expandBox = await expandBtn.boundingBox();
    expect(toggleBox).not.toBeNull();
    expect(expandBox).not.toBeNull();
    const toggleMid = toggleBox!.y + toggleBox!.height / 2;
    const expandMid = expandBox!.y + expandBox!.height / 2;
    expect(Math.abs(toggleMid - expandMid)).toBeLessThan(1.5);
  });

  // HS-7661 — eye-icon dialog opens with the active project's terminals,
  // toggling a row hides the tile, "Show all" restores it. Session-only
  // state so the dialog reflects each click immediately.
  test('drawer-grid eye icon hides + shows tiles via the dialog (HS-7661)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        terminals: [
          { id: 'a', name: 'A', command: '/bin/echo a', lazy: true },
          { id: 'b', name: 'B', command: '/bin/echo b', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const toggle = page.locator('#drawer-grid-toggle');
    await expect(toggle).toBeEnabled({ timeout: 5000 });
    await toggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();

    // Both tiles visible.
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="a"]')).toHaveCount(1);
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="b"]')).toHaveCount(1);

    // Open the eye-icon dialog.
    const eyeBtn = page.locator('#drawer-grid-hide-btn');
    await expect(eyeBtn).toBeVisible();
    await eyeBtn.click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await expect(dialog).toBeVisible();
    // Both terminals listed.
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="a"]')).toHaveCount(1);
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="b"]')).toHaveCount(1);

    // Click the "B" row to hide it. The grid rebuilds via the
    // hidden-state subscription.
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="b"].is-hidden')).toHaveCount(1);
    // Grid now only has tile A.
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="a"]')).toHaveCount(1);
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="b"]')).toHaveCount(0);

    // "Show all" restores B.
    await dialog.locator('.hide-terminal-show-all').click();
    await expect(dialog.locator('.hide-terminal-row[data-terminal-id="b"].is-hidden')).toHaveCount(0);
    await expect(page.locator('.drawer-terminal-grid-tile[data-terminal-id="b"]')).toHaveCount(1);

    // Esc closes the dialog.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  // HS-7661 — when ALL terminals in the project are hidden, the grid shows
  // an "All Terminals Hidden" placeholder rather than an empty white space.
  test('drawer-grid shows "All Terminals Hidden" when every terminal is hidden (HS-7661)', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        terminals: [
          { id: 'a', name: 'A', command: '/bin/echo a', lazy: true },
          { id: 'b', name: 'B', command: '/bin/echo b', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    await page.locator('#drawer-grid-toggle').click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();
    // Hide both via the dialog.
    await page.locator('#drawer-grid-hide-btn').click();
    const dialog = page.locator('.hide-terminal-dialog-overlay');
    await dialog.locator('.hide-terminal-row[data-terminal-id="a"]').click();
    await dialog.locator('.hide-terminal-row[data-terminal-id="b"]').click();
    await page.keyboard.press('Escape');
    // Placeholder visible, no tiles.
    await expect(page.locator('.drawer-terminal-grid-all-hidden')).toBeVisible();
    await expect(page.locator('.drawer-terminal-grid-tile')).toHaveCount(0);
  });

  test('clicking a drawer tab while in grid mode exits grid mode and activates that tab', async ({ page, request }) => {
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'a', name: 'A', command: '/bin/echo a', lazy: true },
          { id: 'b', name: 'B', command: '/bin/echo b', lazy: true },
        ],
      },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 5000 });

    const toggle = page.locator('#drawer-grid-toggle');
    await expect(toggle).toBeEnabled({ timeout: 5000 });
    await toggle.click();
    await expect(page.locator('#drawer-terminal-grid')).toBeVisible();

    // Click the "A" terminal tab — should exit grid mode and activate that tab.
    await page.locator('.drawer-terminal-tab[data-terminal-id="a"]').click();
    await expect(page.locator('#drawer-terminal-grid')).toBeHidden();
    await expect(toggle).not.toHaveClass(/active/);
    // The matching terminal pane should now be visible.
    await expect(page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:a"]')).toBeVisible();
  });
});
