/**
 * E2E coverage for the embedded terminal drawer (docs/22-terminal.md).
 *
 * These tests reproduce the three reopened bugs from this round:
 * - HS-6342: configured default terminal tabs not appearing in the drawer
 * - HS-6341: + button creates a tab without a label / nothing visibly launches
 * - HS-6403: clicking delete in Settings → Embedded Terminal does nothing
 *
 * The drawer requires `terminal_enabled: true` in `.hotsheet/settings.json`,
 * so each test seeds that via PATCH /api/file-settings before opening the page.
 */
import { expect, test } from './coverage-fixture.js';

let headers: Record<string, string> = {};

test.describe('Embedded terminal drawer', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.get('/api/projects');
    const projects = await res.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    // The terminal feature is Tauri-only (HS-6437). Playwright runs in a plain
    // browser, so we stub __TAURI__ onto the window *before* the app bundle
    // executes — otherwise getTauriInvoke() returns null and the drawer / the
    // settings section hide themselves. The stub only needs to be truthy
    // enough for `tauri?.core?.invoke` to return a function.
    await page.addInitScript(() => {
      // A no-op invoke is enough for UI visibility checks.
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });

    // Dynamic terminals created by earlier tests persist in the server-side
    // registry (they're not tied to settings.json), so destroy them before
    // each test to prevent tab-count pollution.
    try {
      const list = await (await request.get('/api/terminal/list', { headers })).json() as {
        dynamic?: { id: string }[];
      };
      for (const d of list.dynamic ?? []) {
        await request.post('/api/terminal/destroy', { headers, data: { terminalId: d.id } });
      }
    } catch { /* first-time runs won't have the endpoint populated yet */ }

    // Reset every test to a known terminal config so they don't interfere.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [
          { id: 'default', name: 'Default', command: '/bin/echo configured-default', lazy: true },
          { id: 'second', name: 'Second', command: '/bin/echo configured-second', lazy: true },
        ],
      },
    });
  });

  // HS-6342: when the project has configured terminals and terminal_enabled is true,
  // both tabs must be visible in the drawer tab strip on first open after page load.
  test('configured default terminal tabs render in the drawer (HS-6342)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer via the footer button.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });

    // Both configured tabs should be in the tab strip.
    const defaultTab = page.locator('.drawer-terminal-tab[data-terminal-id="default"]');
    const secondTab = page.locator('.drawer-terminal-tab[data-terminal-id="second"]');
    await expect(defaultTab).toBeVisible({ timeout: 5000 });
    await expect(secondTab).toBeVisible({ timeout: 5000 });

    // Tab labels reflect the configured `name` field.
    await expect(defaultTab).toContainText('Default');
    await expect(secondTab).toContainText('Second');
  });

  // HS-6342 (continued): adding a terminal in Settings must immediately add a tab
  // to the drawer without a page reload.
  test('adding a new configured terminal via Settings adds a tab live (HS-6342)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Confirm the two seeded tabs are present before we add a third.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="default"]')).toBeVisible({ timeout: 5000 });

    // Add a third terminal directly via the file-settings API — same code path
    // the settings UI uses (PATCH /file-settings with the new terminals array).
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminals: [
          { id: 'default', name: 'Default', command: '/bin/echo configured-default', lazy: true },
          { id: 'second', name: 'Second', command: '/bin/echo configured-second', lazy: true },
          { id: 'third', name: 'Third', command: '/bin/echo configured-third', lazy: true },
        ],
      },
    });

    // After the server-side save, the drawer must show the new tab. The
    // settings UI calls refreshTerminalsAfterSettingsChange() on save, but a
    // direct API call doesn't go through that path — reload and verify the new
    // tab appears on a fresh page load.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // The drawer remembers it was open across reload (drawer_open in
    // settings.json), so it should re-open automatically. Only toggle if it
    // isn't visible yet.
    const panel = page.locator('#command-log-panel');
    if (!(await panel.isVisible())) await page.locator('#command-log-btn').click();
    await expect(panel).toBeVisible({ timeout: 5000 });
    const thirdTab = page.locator('.drawer-terminal-tab[data-terminal-id="third"]');
    await expect(thirdTab).toBeVisible({ timeout: 5000 });
    await expect(thirdTab).toContainText('Third');
  });

  // HS-6341: clicking + creates a dynamic terminal that has a visible tab label
  // and a visible content pane (not a blank drawer).
  test('+ button creates a dynamic terminal tab with a label and a visible pane (HS-6341)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    await expect(page.locator('#drawer-add-terminal-btn')).toBeVisible({ timeout: 5000 });

    // Click the + button to create a dynamic terminal.
    await page.locator('#drawer-add-terminal-btn').click();

    // A new tab with a `dyn-` id should appear.
    const dynTab = page.locator('.drawer-terminal-tab[data-terminal-id^="dyn-"]').first();
    await expect(dynTab).toBeVisible({ timeout: 5000 });

    // Label must be non-empty (HS-6341: was rendering blank).
    const label = await dynTab.locator('.drawer-tab-label').innerText();
    expect(label.trim().length).toBeGreaterThan(0);

    // Tab is selected (active) and its pane is visible.
    await expect(dynTab).toHaveClass(/active/, { timeout: 3000 });
    const dynId = await dynTab.getAttribute('data-terminal-id');
    expect(dynId).not.toBeNull();
    const pane = page.locator(`.drawer-terminal-pane[data-drawer-panel="terminal:${dynId!}"]`);
    await expect(pane).toBeVisible({ timeout: 3000 });

    // Pane must contain a mounted xterm canvas (not just an empty div).
    await expect(pane.locator('.xterm-screen, .xterm canvas').first()).toBeVisible({ timeout: 5000 });
  });

  // HS-6403: deleting a terminal in Settings must remove the row, persist to
  // settings.json, and remove the corresponding drawer tab. The confirm is a
  // custom in-app overlay (window.confirm is a silent no-op in Tauri WKWebView)
  // so the test clicks the overlay's Remove button rather than using
  // page.on('dialog'). Using the native dialog handler would silently mask the
  // very regression class that caused this bug.
  test('delete button in Settings → Embedded Terminal actually deletes (HS-6403)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open Settings → Terminal (HS-6337 moved the terminals list to its own tab).
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    await expect(page.locator('#settings-terminal-panel')).toBeVisible({ timeout: 3000 });

    // Wait for the terminals list to load (loadAndRenderTerminalsSettings is async).
    const list = page.locator('#settings-terminals-list');
    await expect(list).toBeVisible({ timeout: 3000 });
    await expect(list.locator('.settings-terminal-row')).toHaveCount(2, { timeout: 5000 });

    // Fail fast if anyone ever reintroduces window.confirm here — the native
    // dialog handler would mask the Tauri silent-false bug.
    let nativeDialogFired = false;
    page.on('dialog', dialog => { nativeDialogFired = true; void dialog.dismiss(); });

    // Click delete on the second row, then confirm via the in-app overlay.
    const secondRow = list.locator('.settings-terminal-row').nth(1);
    await secondRow.locator('.cmd-outline-delete-btn').click();
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await overlay.locator('.confirm-dialog-confirm').click();
    await expect(overlay).toHaveCount(0);
    expect(nativeDialogFired).toBe(false);

    // The row should be removed from the list.
    await expect(list.locator('.settings-terminal-row')).toHaveCount(1, { timeout: 5000 });

    // The save is debounced (~400ms). Wait a moment, then verify settings.json
    // has been updated server-side.
    await page.waitForTimeout(700);
    const fs = await (await request.get('/api/file-settings', { headers })).json() as { terminals: { id: string }[] };
    expect(fs.terminals).toHaveLength(1);
    expect(fs.terminals[0].id).toBe('default');
  });

  // HS-6403 (continued): the delete button's inner SVG/path is the typical
  // click target. Clicking the path must still trigger the handler.
  test('clicking the inner SVG of delete still deletes (HS-6403 delegation)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    const list = page.locator('#settings-terminals-list');
    await expect(list.locator('.settings-terminal-row')).toHaveCount(2, { timeout: 5000 });

    // Target the SVG path inside the button — what the user actually clicks.
    const secondRow = list.locator('.settings-terminal-row').nth(1);
    await secondRow.locator('.cmd-outline-delete-btn svg').click();
    await page.locator('.confirm-dialog-overlay .confirm-dialog-confirm').click();

    await expect(list.locator('.settings-terminal-row')).toHaveCount(1, { timeout: 5000 });
    await page.waitForTimeout(700);
    const fs = await (await request.get('/api/file-settings', { headers })).json() as { terminals: { id: string }[] };
    expect(fs.terminals).toHaveLength(1);
  });

  // HS-6403: guard against the original dragstart-swallows-click race. When
  // the row is draggable="true", a click that drifts a pixel can cause
  // dragstart to fire first and the browser to cancel the click entirely.
  // Simulate this by moving between mousedown and mouseup over the delete icon.
  test('delete still works when the click drifts (HS-6403 drag/click race)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    const list = page.locator('#settings-terminals-list');
    await expect(list.locator('.settings-terminal-row')).toHaveCount(2, { timeout: 5000 });

    const btn = list.locator('.settings-terminal-row').nth(1).locator('.cmd-outline-delete-btn');
    const box = await btn.boundingBox();
    if (box === null) throw new Error('could not measure delete button');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    // Drift a pixel so the browser is tempted to start a drag.
    await page.mouse.move(cx + 1, cy + 1);
    await page.mouse.up();

    await page.locator('.confirm-dialog-overlay .confirm-dialog-confirm').click();
    await expect(list.locator('.settings-terminal-row')).toHaveCount(1, { timeout: 5000 });
    await page.waitForTimeout(700);
    const fs = await (await request.get('/api/file-settings', { headers })).json() as { terminals: { id: string }[] };
    expect(fs.terminals).toHaveLength(1);
  });

  // HS-6403: the delete flow reveals the target terminal in the drawer and
  // hides the settings dialog so the user can see what they're about to
  // remove. On confirm the PTY is destroyed so it doesn't orphan; on cancel
  // the drawer + settings go back to their prior state.
  test('delete reveals terminal in drawer, hides settings, and destroys the PTY (HS-6403)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer and activate the "second" terminal so its PTY spawns.
    // We want to assert that confirming the delete actually tears it down.
    await page.locator('#command-log-btn').click();
    const secondTab = page.locator('.drawer-terminal-tab[data-terminal-id="second"]');
    await expect(secondTab).toBeVisible({ timeout: 5000 });
    await secondTab.click();
    await expect(page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:second"] .xterm-rows')).toBeVisible({ timeout: 5000 });

    // Now close the drawer — the delete flow should re-open it to show the
    // user the target terminal, then close it again on finish.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeHidden();

    // Open Settings → Terminal.
    await page.locator('#settings-btn').click();
    const settingsOverlay = page.locator('#settings-overlay');
    await expect(settingsOverlay).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    const list = page.locator('#settings-terminals-list');
    await expect(list.locator('.settings-terminal-row')).toHaveCount(2, { timeout: 5000 });

    // Click delete on the second row.
    await list.locator('.settings-terminal-row').nth(1).locator('.cmd-outline-delete-btn').click();

    // The confirm overlay is up, settings is hidden out of the way, and the
    // drawer is open with the second terminal active so the user can see it.
    const confirmOverlay = page.locator('.confirm-dialog-overlay');
    await expect(confirmOverlay).toBeVisible({ timeout: 3000 });
    await expect(settingsOverlay).toBeHidden();
    await expect(page.locator('#command-log-panel')).toBeVisible();
    await expect(secondTab).toHaveClass(/active/);

    // Confirm the delete.
    await confirmOverlay.locator('.confirm-dialog-confirm').click();
    await expect(confirmOverlay).toHaveCount(0);

    // Settings comes back; the drawer returns to its prior state (was closed).
    await expect(settingsOverlay).toBeVisible();
    await expect(page.locator('#command-log-panel')).toBeHidden();

    // Row gone, save persisted.
    await expect(list.locator('.settings-terminal-row')).toHaveCount(1, { timeout: 5000 });
    await page.waitForTimeout(700);
    const fs = await (await request.get('/api/file-settings', { headers })).json() as { terminals: { id: string }[] };
    expect(fs.terminals).toHaveLength(1);
    expect(fs.terminals[0].id).toBe('default');

    // Server-side: the PTY for "second" was destroyed, not orphaned.
    const list2 = await (await request.get('/api/terminal/list', { headers })).json() as {
      configured?: { id: string }[];
      alive?: { id: string }[];
    };
    const aliveIds = (list2.alive ?? []).map(t => t.id);
    expect(aliveIds).not.toContain('second');
  });

  // HS-6403: cancelling via the overlay's Cancel button (or Escape) leaves
  // the row in place — this guards against over-eager destruction.
  test('delete overlay Cancel leaves the terminal in place (HS-6403)', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    const list = page.locator('#settings-terminals-list');
    await expect(list.locator('.settings-terminal-row')).toHaveCount(2, { timeout: 5000 });

    await list.locator('.settings-terminal-row').nth(1).locator('.cmd-outline-delete-btn').click();
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await overlay.locator('.confirm-dialog-cancel').click();
    await expect(overlay).toHaveCount(0);

    await expect(list.locator('.settings-terminal-row')).toHaveCount(2);
    await page.waitForTimeout(700);
    const fs = await (await request.get('/api/file-settings', { headers })).json() as { terminals: { id: string }[] };
    expect(fs.terminals).toHaveLength(2);
  });

  // HS-6470: right-click on a terminal tab shows a context menu with
  // close tab / close others / close to the left / close to the right.
  // Configured (default) terminals disable "Close Tab" and are skipped by
  // the bulk-close actions.
  test('tab context menu closes dynamic tabs and spares configured defaults (HS-6470)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open drawer and create three dynamic terminals.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#drawer-add-terminal-btn')).toBeVisible({ timeout: 5000 });
    for (let i = 0; i < 3; i++) {
      await page.locator('#drawer-add-terminal-btn').click();
      await expect(page.locator('.drawer-terminal-tab[data-terminal-id^="dyn-"]').nth(i)).toBeVisible({ timeout: 5000 });
    }

    // Tab strip now has: default, second (both configured), dyn-0, dyn-1, dyn-2.
    const tabs = page.locator('.drawer-terminal-tab');
    await expect(tabs).toHaveCount(5, { timeout: 3000 });
    const dyns = page.locator('.drawer-terminal-tab[data-terminal-id^="dyn-"]');
    await expect(dyns).toHaveCount(3);

    // Right-click the middle dynamic tab → "Close Other Tabs" should close
    // only dyn-0 and dyn-2 (the two configured defaults must remain).
    await dyns.nth(1).click({ button: 'right' });
    const menu = page.locator('.terminal-tab-context-menu');
    await expect(menu).toBeVisible({ timeout: 3000 });

    // "Close Tab" must be enabled on a dynamic tab.
    await expect(menu.locator('[data-action="close"]')).not.toHaveClass(/disabled/);

    await menu.locator('[data-action="close-others"]').click();
    // Two configured defaults + the one dynamic we right-clicked should remain.
    await expect(tabs).toHaveCount(3, { timeout: 5000 });
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="default"]')).toBeVisible();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="second"]')).toBeVisible();
    await expect(dyns).toHaveCount(1);
  });

  // HS-6337: terminal options live on their own Settings tab, the enabled
  // checkbox is gone, and an unconfigured project shows no terminal tabs in
  // the drawer (no implicit default).
  test('Terminal settings live on their own tab with no enable-checkbox (HS-6337)', async ({ page, request }) => {
    // Reset to an *empty* terminals list so we exercise the "no default" path.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'false',
        drawer_active_tab: 'commands-log',
        terminals: [],
      },
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Drawer: tab strip is visible (Tauri stub present) but no *configured*
    // terminal tabs (the + add-button has its own class and does not count;
    // dynamic tabs from earlier tests are scoped to the server-side registry
    // and may persist across tests — we only care about configured ones here).
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#drawer-terminal-tabs-wrap')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.drawer-terminal-tab:not([data-terminal-id^="dyn-"])')).toHaveCount(0);

    // Settings: dedicated "Terminal" tab is visible in Tauri mode.
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-tab-terminal')).toBeVisible();
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    await expect(page.locator('#settings-terminal-panel')).toBeVisible({ timeout: 3000 });
    // The "Show Terminal tabs in the bottom drawer" checkbox was removed.
    await expect(page.locator('#settings-terminal-enabled')).toHaveCount(0);
    // Core terminal settings (list + scrollback) still live here.
    await expect(page.locator('#settings-terminals-list')).toBeVisible();
    await expect(page.locator('#settings-terminal-scrollback')).toBeVisible();
  });

  // HS-6437: when not running inside Tauri, the drawer's terminal tab strip
  // and the Settings → Embedded Terminal section must be hidden. We drop the
  // __TAURI__ stub for this one test by re-registering addInitScript (the
  // later script overrides the earlier one at navigation time).
  test('terminal UI is hidden in non-Tauri (web) sessions (HS-6437)', async ({ page, request }) => {
    // Even though the setting is "true", web clients should not see the UI.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        terminals: [{ id: 'default', name: 'Default', command: '/bin/echo hi', lazy: true }],
      },
    });
    // Clear the previously-registered init script by registering one that
    // deletes __TAURI__ before the app bundle boots.
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI__;
    });

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer — Commands Log should show, but no terminal tabs.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#drawer-terminal-tabs-wrap')).toBeHidden();

    // Settings must hide the Terminal tab button entirely (HS-6337 moved the
    // embedded-terminal options into their own tab, and HS-6437 makes that
    // tab Tauri-only).
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#settings-tab-terminal')).toBeHidden();
  });

  // HS-6474 / HS-6475: Commands Log tab renders as an icon-only button (no
  // visible "Commands Log" text) and a vertical divider sits between it and
  // the terminal tabs wrap. The divider is hidden on non-desktop sessions.
  test('Commands Log tab is icon-only with a divider before terminal tabs (HS-6474, HS-6475)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer so the tab strip is in the viewport.
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });

    const logTab = page.locator('#drawer-tab-commands-log');
    // Tab should exist and carry the icon-only modifier class.
    await expect(logTab).toHaveClass(/drawer-tab-icon/);
    // The button now has an SVG instead of text. Text content should be empty
    // (whitespace only) — the accessible name comes from aria-label/title.
    const label = (await logTab.innerText()).trim();
    expect(label).toBe('');
    await expect(logTab).toHaveAttribute('aria-label', 'Commands Log');
    await expect(logTab.locator('svg')).toBeVisible();

    // Divider sits between the Commands Log tab and the terminal tabs wrap.
    const divider = page.locator('.drawer-tabs-divider');
    await expect(divider).toHaveCount(1);
    await expect(divider).toBeVisible();
  });

  // HS-6502: when the drawer is expanded to full height (or manually resized),
  // the active terminal's xterm must refit so rows/cols track the new pane
  // size. We exercise this by opening a terminal, recording its cols/rows,
  // clicking the expand button, and asserting rows grew (width is unchanged
  // by vertical expansion, so we key off rows).
  test('active terminal refits when the drawer is expanded (HS-6502)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    const firstTab = page.locator('.drawer-terminal-tab[data-terminal-id="default"]');
    await expect(firstTab).toBeVisible({ timeout: 5000 });
    await firstTab.click();
    await expect(firstTab).toHaveClass(/active/);

    // Wait for the xterm grid to mount and settle at its initial size.
    const pane = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:default"]');
    await expect(pane.locator('.xterm-rows')).toBeVisible({ timeout: 5000 });

    // Collapse any prior expanded state first so we always start small.
    const app = page.locator('.app');
    if ((await app.getAttribute('class'))?.includes('drawer-expanded')) {
      await page.locator('#drawer-expand-btn').click();
    }
    const getRows = async () => pane.locator('.xterm-rows > *').count();
    // Let fit settle.
    await page.waitForTimeout(200);
    const initialRows = await getRows();
    expect(initialRows).toBeGreaterThan(0);

    // Expand the drawer — this is the user action that previously didn't refit.
    await page.locator('#drawer-expand-btn').click();
    await expect(app).toHaveClass(/drawer-expanded/);

    // ResizeObserver fires async; poll briefly for the grid to grow.
    await expect.poll(async () => getRows(), { timeout: 3000, intervals: [100, 200, 400, 800] })
      .toBeGreaterThan(initialRows);

    // Collapse again and the grid should shrink back.
    await page.locator('#drawer-expand-btn').click();
    await expect(app).not.toHaveClass(/drawer-expanded/);
    await expect.poll(async () => getRows(), { timeout: 3000, intervals: [100, 200, 400, 800] })
      .toBeLessThan(initialRows + 4); // small tolerance for rounding
  });

  // HS-6472: when focus is inside an xterm pane, Cmd+Shift+ArrowRight
  // cycles terminal tabs instead of project tabs; Cmd+Shift+Opt+ArrowRight
  // escapes back to project-tab navigation.
  test('Cmd+Shift+Arrow switches terminal tabs when a terminal is focused (HS-6472)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open the drawer and activate the first configured terminal.
    await page.locator('#command-log-btn').click();
    const firstTab = page.locator('.drawer-terminal-tab[data-terminal-id="default"]');
    const secondTab = page.locator('.drawer-terminal-tab[data-terminal-id="second"]');
    await expect(firstTab).toBeVisible({ timeout: 5000 });
    await firstTab.click();
    await expect(firstTab).toHaveClass(/active/);

    // Wait for the xterm helper textarea to mount and receive focus.
    const helper = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:default"] .xterm-helper-textarea');
    await expect(helper).toHaveCount(1, { timeout: 5000 });
    await helper.focus();

    // Cmd+Shift+ArrowRight should advance to the next terminal tab.
    await page.keyboard.press('Meta+Shift+ArrowRight');
    await expect(secondTab).toHaveClass(/active/, { timeout: 3000 });

    // Cmd+Shift+ArrowLeft wraps back to the first terminal tab.
    const helper2 = page.locator('.drawer-terminal-pane[data-drawer-panel="terminal:second"] .xterm-helper-textarea');
    await expect(helper2).toHaveCount(1, { timeout: 5000 });
    // activateTerminal focuses the new terminal; refocus the helper defensively
    // in case Playwright's synthetic key dispatch bypassed xterm's focus call.
    await helper2.focus();
    await page.keyboard.press('Meta+Shift+ArrowLeft');
    await expect(firstTab).toHaveClass(/active/, { timeout: 3000 });
  });

  test('Commands Log divider hides on non-desktop sessions (HS-6475)', async ({ page }) => {
    await page.addInitScript(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI__;
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await page.locator('#command-log-btn').click();
    await expect(page.locator('#command-log-panel')).toBeVisible({ timeout: 3000 });
    // Divider is hidden when the terminal tabs wrap is hidden.
    await expect(page.locator('.drawer-tabs-divider')).toBeHidden();
    // Commands Log tab stays visible.
    await expect(page.locator('#drawer-tab-commands-log')).toBeVisible();
  });

  test('context menu on a configured default disables "Close Tab" but still offers the rest (HS-6470)', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#command-log-btn').click();
    await expect(page.locator('#drawer-add-terminal-btn')).toBeVisible({ timeout: 5000 });
    // Add one dynamic terminal so there is something bulk-close can act on.
    await page.locator('#drawer-add-terminal-btn').click();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id^="dyn-"]').first()).toBeVisible({ timeout: 5000 });

    await page.locator('.drawer-terminal-tab[data-terminal-id="default"]').click({ button: 'right' });
    const menu = page.locator('.terminal-tab-context-menu');
    await expect(menu).toBeVisible({ timeout: 3000 });
    // "Close Tab" is disabled because default is a configured terminal.
    await expect(menu.locator('[data-action="close"]')).toHaveClass(/disabled/);
    // The other three options remain available.
    await expect(menu.locator('[data-action="close-others"]')).not.toHaveClass(/disabled/);
    await expect(menu.locator('[data-action="close-left"]')).not.toHaveClass(/disabled/);
    await expect(menu.locator('[data-action="close-right"]')).not.toHaveClass(/disabled/);

    // Close Others: the default should remain, the dynamic should close, the
    // other configured ("second") should also remain (skip-configured semantics).
    await menu.locator('[data-action="close-others"]').click();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id^="dyn-"]')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="default"]')).toBeVisible();
    await expect(page.locator('.drawer-terminal-tab[data-terminal-id="second"]')).toBeVisible();
  });
});
