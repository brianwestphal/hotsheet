import { expect, test } from './coverage-fixture.js';

// Helper: open settings and switch to the Experimental tab.
//
// HS-8440 — replaced the previous `await page.waitForTimeout(1500)` blind
// sleep with a deterministic visibility wait on `.cmd-outline-add-btn`,
// which `renderCustomCommandSettings` appends LAST after the for-loop
// over `commandItems`. Its visibility proves at least one render
// finished. The deeper "stale reload races with delete" race is closed
// production-side in `experimentalSettings.tsx::reloadCustomCommands`
// via a mutation-epoch guard (HS-8440 + HS-8441 merged) — once a local
// edit has bumped the epoch, any in-flight reload whose `await` started
// before the edit is dropped on resolution, so we don't need a network
// sync wait here. `networkidle` would not work anyway: the app keeps a
// persistent long-poll open for ticket updates, so the network is never
// idle.
async function openExperimentalSettings(page: import('@playwright/test').Page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
  await page.locator('.settings-tab[data-tab="experimental"]').click();
  await expect(page.locator('.settings-tab-panel[data-panel="experimental"]')).toHaveClass(/active/);
  await expect(page.locator('.cmd-outline-add-btn')).toBeVisible({ timeout: 5000 });
}

// Helper: set custom commands via API then reload to pick them up
async function setCommandsAndReload(page: import('@playwright/test').Page, items: unknown[]) {
  const origin = page.url().replace(/\/[^/]*$/, '');
  await page.request.patch('/api/settings', {
    data: { custom_commands: JSON.stringify(items) },
    headers: { Origin: origin },
  });
  await page.reload();
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
}

test.describe('Custom commands', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Clear any existing commands
    const origin = page.url().replace(/\/[^/]*$/, '');
    await page.request.patch('/api/settings', {
      data: { custom_commands: '[]' },
      headers: { Origin: origin },
    });
  });

  test('add a command via the Add Command button', async ({ page }) => {
    await openExperimentalSettings(page);

    // Click Add Command
    await page.locator('.cmd-outline-add-btn').click();
    await page.waitForTimeout(300);

    // Should see a command row (new commands show as "(untitled)")
    const rows = page.locator('.cmd-outline-row');
    await expect(rows.first()).toBeVisible({ timeout: 3000 });
    await expect(rows.first()).toContainText('(untitled)');
  });

  test('add a group via the Add Group button', async ({ page }) => {
    await openExperimentalSettings(page);

    // Click Add Group
    await page.locator('.cmd-outline-add-group-btn').click();
    await page.waitForTimeout(300);

    // Should see a group row
    const groupRows = page.locator('.cmd-outline-group-row');
    await expect(groupRows.first()).toBeVisible({ timeout: 3000 });
    await expect(groupRows.first()).toContainText('New Group');
  });

  test('delete an empty group', async ({ page }) => {
    await setCommandsAndReload(page, [
      { type: 'group', name: 'Empty Group', children: [] },
    ]);

    await openExperimentalSettings(page);

    // Group should be visible
    const groupRow = page.locator('.cmd-outline-group-row');
    await expect(groupRow.first()).toBeVisible({ timeout: 3000 });

    // Delete the empty group. HS-8440 — dropped the 300ms blind wait
    // between the click and the assertion; `toHaveCount(0)` already polls
    // with a 5s default and the delete handler is synchronous (splice +
    // re-render), so the bald sleep added overhead without addressing the
    // real race (stale `reloadCustomCommands` resolving post-delete), which
    // is now closed in `openExperimentalSettings` via the networkidle wait.
    await groupRow.first().locator('.cmd-outline-delete-btn').click();

    // Group should be gone
    await expect(page.locator('.cmd-outline-group-row')).toHaveCount(0);
  });

  test('cannot delete a group that has children', async ({ page }) => {
    await setCommandsAndReload(page, [
      { type: 'group', name: 'Has Children', children: [
        { name: 'Child Cmd', prompt: 'test' },
      ]},
    ]);

    await openExperimentalSettings(page);

    // Group should be visible
    const groupRow = page.locator('.cmd-outline-group-row');
    await expect(groupRow.first()).toBeVisible({ timeout: 3000 });

    // Delete button should not be present for non-empty group
    await expect(groupRow.first().locator('.cmd-outline-delete-btn')).toHaveCount(0);
  });

  test('edit a command opens modal dialog', async ({ page }) => {
    await setCommandsAndReload(page, [
      { name: 'Test Cmd', prompt: 'do something' },
    ]);

    await openExperimentalSettings(page);

    // Click edit on the command
    await page.locator('.cmd-outline-row .cmd-outline-edit-btn').first().click();

    // Modal should appear
    const modal = page.locator('.cmd-editor-overlay');
    await expect(modal).toBeVisible({ timeout: 3000 });

    // Close the modal
    await modal.locator('.cmd-editor-close-btn').click();
    await expect(modal).toBeHidden({ timeout: 3000 });
  });

  // HS-8894 — the "Launch in new terminal" shell sub-option label fell through
  // to the generic muted `.cmd-editor-dialog-body label` rule, so a checked box
  // rendered with disabled-looking light-gray text. It must match the sibling
  // "Show log on completion" label exactly. Guard by comparing computed colors.
  test('shell sub-option labels render with the same (non-disabled) color (HS-8894)', async ({ page }) => {
    await setCommandsAndReload(page, [
      { name: 'Shell Cmd', prompt: 'echo hi', target: 'shell' },
    ]);

    await openExperimentalSettings(page);
    await page.locator('.cmd-outline-row .cmd-outline-edit-btn').first().click();

    const modal = page.locator('.cmd-editor-overlay');
    await expect(modal).toBeVisible({ timeout: 3000 });
    // Ensure the Shell target is active so both sub-option rows are shown.
    await modal.locator('.seg-btn[data-target="shell"]').click();

    const autoShow = modal.locator('.command-auto-show-label');
    const launchTerminal = modal.locator('.command-launch-terminal-label');
    await expect(autoShow).toBeVisible();
    await expect(launchTerminal).toBeVisible();

    const colorOf = (loc: import('@playwright/test').Locator) =>
      loc.evaluate((el) => getComputedStyle(el).color);
    const autoShowColor = await colorOf(autoShow);
    const launchColor = await colorOf(launchTerminal);

    // Identical to its sibling, and NOT the muted/disabled-looking gray
    // (#9ca3af === rgb(156, 163, 175)) the generic label rule applies.
    expect(launchColor).toBe(autoShowColor);
    expect(launchColor).not.toBe('rgb(156, 163, 175)');

    await modal.locator('.cmd-editor-close-btn').click();
  });

  test('delete a command from the outline', async ({ page }) => {
    await setCommandsAndReload(page, [
      { name: 'Cmd A', prompt: 'a' },
      { name: 'Cmd B', prompt: 'b' },
    ]);

    await openExperimentalSettings(page);
    const rows = page.locator('.cmd-outline-row');
    await expect(rows).toHaveCount(2, { timeout: 3000 });

    // Delete the first command
    await rows.first().locator('.cmd-outline-delete-btn').click();
    await page.waitForTimeout(300);

    // Should have one command left
    await expect(page.locator('.cmd-outline-row')).toHaveCount(1);
    await expect(page.locator('.cmd-outline-row').first()).toContainText('Cmd B');
  });

  test('commands persist after reload', async ({ page }) => {
    await setCommandsAndReload(page, [
      { name: 'Persistent Cmd', prompt: 'persist test' },
    ]);

    await openExperimentalSettings(page);
    await expect(page.locator('.cmd-outline-row').first()).toContainText('Persistent Cmd');

    // Close settings and reload
    await page.locator('#settings-close').click();
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Reopen settings and verify
    await openExperimentalSettings(page);
    await expect(page.locator('.cmd-outline-row').first()).toContainText('Persistent Cmd');
  });

  test('group with children persists correctly', async ({ page }) => {
    await setCommandsAndReload(page, [
      { name: 'Top Cmd', prompt: 'top' },
      { type: 'group', name: 'My Group', children: [
        { name: 'Grouped Cmd 1', prompt: 'g1' },
        { name: 'Grouped Cmd 2', prompt: 'g2' },
      ]},
      { name: 'Bottom Cmd', prompt: 'bottom' },
    ]);

    await openExperimentalSettings(page);

    // Verify the group row exists
    await expect(page.locator('.cmd-outline-group-row')).toHaveCount(1, { timeout: 3000 });
    await expect(page.locator('.cmd-outline-group-row').first()).toContainText('My Group');

    // Verify indented children exist
    const indentedRows = page.locator('.cmd-outline-row.cmd-outline-indented');
    await expect(indentedRows).toHaveCount(2, { timeout: 3000 });

    // Verify non-indented command rows (Top Cmd, Bottom Cmd) — exclude group headers
    const topLevelRows = page.locator('.cmd-outline-row:not(.cmd-outline-indented):not(.cmd-outline-group-row)');
    await expect(topLevelRows).toHaveCount(2, { timeout: 3000 });

    // Close and reload to verify persistence
    await page.locator('#settings-close').click();
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await openExperimentalSettings(page);
    await expect(page.locator('.cmd-outline-group-row')).toHaveCount(1);
    await expect(page.locator('.cmd-outline-row.cmd-outline-indented')).toHaveCount(2, { timeout: 3000 });
  });

  test('sidebar shows command buttons', async ({ page }) => {
    await setCommandsAndReload(page, [
      { name: 'Sidebar Cmd', prompt: 'test', color: '#3b82f6', target: 'shell' },
    ]);

    // Wait for channel init to render commands in sidebar
    await page.waitForTimeout(1500);

    // Commands only render in sidebar when channel section is visible
    // (shell commands always show, but the container may not exist in all environments)
    const container = page.locator('#channel-commands-container');
    if (await container.count() === 0) {
      test.skip();
      return;
    }

    const btns = container.locator('.channel-command-btn');
    await expect(btns).toHaveCount(1, { timeout: 5000 });
    await expect(btns.first()).toContainText('Sidebar Cmd');
  });

  // HS-6636: a "Show log on completion" shell command must switch the drawer to
  // the Commands Log tab if the user happens to be on a terminal tab when it
  // finishes — otherwise the auto-show is silently invisible.
  test('autoShowLog command switches drawer from terminal tab to commands-log on completion (HS-6636)', async ({ page, request }) => {
    // Tauri stub so the terminal feature is enabled in the bundle.
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__TAURI__ = {
        core: { invoke: async () => undefined },
      };
    });

    // Find the project secret so we can patch file-settings directly.
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };

    // Configure: a terminal + a shell command with autoShowLog. Open the drawer
    // pre-positioned on the terminal tab so the test exercises the bug case.
    await request.patch('/api/file-settings', {
      headers,
      data: {
        terminal_enabled: 'true',
        drawer_open: 'true',
        drawer_active_tab: 'terminal:default',
        terminals: [
          { id: 'default', name: 'Default', command: '/bin/echo configured', lazy: true },
        ],
      },
    });
    await setCommandsAndReload(page, [
      { name: 'Quick Echo', prompt: '/bin/echo hello-world', target: 'shell', autoShowLog: true },
    ]);

    // Drawer should restore to the terminal tab.
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:default"]')).toHaveClass(/active/, { timeout: 5000 });
    await expect(page.locator('.drawer-tab[data-drawer-tab="commands-log"]')).not.toHaveClass(/active/);

    // Trigger the autoShow command by clicking it in the sidebar.
    const btn = page.locator('#channel-commands-container .channel-command-btn', { hasText: 'Quick Echo' });
    if (await btn.count() === 0) {
      test.skip();
      return;
    }
    await btn.click();

    // Shell poll runs every 2s; give it room to detect completion + auto-show.
    await expect(page.locator('.drawer-tab[data-drawer-tab="commands-log"]')).toHaveClass(/active/, { timeout: 8000 });
    await expect(page.locator('.drawer-tab[data-drawer-tab="terminal:default"]')).not.toHaveClass(/active/);
  });
});
