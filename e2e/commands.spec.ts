import { expect, test } from './coverage-fixture.js';

// Helper: open settings and switch to the Experimental tab
async function openExperimentalSettings(page: import('@playwright/test').Page) {
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
  await page.locator('.settings-tab[data-tab="experimental"]').click();
  await expect(page.locator('.settings-tab-panel[data-panel="experimental"]')).toHaveClass(/active/);
  // Wait for async command reload from API
  await page.waitForTimeout(1500);
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

    // Delete the empty group
    await groupRow.first().locator('.cmd-outline-delete-btn').click();
    await page.waitForTimeout(300);

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
});
