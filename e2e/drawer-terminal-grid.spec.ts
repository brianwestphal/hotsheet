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

  // HS-7659 / HS-7660 — when a tile is enlarged (centered or in dedicated
  // view) inside the drawer grid, the user expects the maximized terminal to
  // use the whole app surface rather than the narrow drawer band. The fix
  // auto-expands the drawer to full height and hides the expand button +
  // size slider while a tile is enlarged; on shrink, the drawer's pre-
  // enlarge expanded state is restored.
  test('enlarging a tile auto-expands the drawer + hides expand button + slider; shrinking restores prior state (HS-7659/HS-7660)', async ({ page, request }) => {
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

    // Baseline: drawer NOT expanded; expand button + grid sizer visible
    // (sizer becomes visible on grid toggle below).
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

    // Single-click a tile to center it. Targeting `[data-terminal-id="a"]`
    // — the lazy fixture leaves both as `not_spawned` placeholders, so a
    // single click triggers `spawnAndEnlarge(tile, 'center')`.
    await page.locator('.drawer-terminal-grid-tile[data-terminal-id="a"]').click();
    // Drawer should auto-expand to full height; the body class is the gate.
    await expect(page.locator('body.drawer-grid-tile-enlarged')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('.app.drawer-expanded')).toHaveCount(1);
    // Expand button + sizer hidden by the body-class CSS rule.
    await expect(expandBtn).toBeHidden();
    await expect(sizer).toBeHidden();

    // Press Esc to uncenter the tile. The drawer should restore its
    // pre-enlarge expanded state (false) and the chrome should reappear.
    await page.keyboard.press('Escape');
    await expect(page.locator('body.drawer-grid-tile-enlarged')).toHaveCount(0, { timeout: 5000 });
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
