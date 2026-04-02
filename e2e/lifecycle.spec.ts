import { expect, test } from './coverage-fixture.js';

/** Helper: create a ticket via the draft input and wait for it to appear in the list. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

test.describe('Ticket lifecycle and batch operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('create multiple tickets and verify all appear', async ({ page }) => {
    await createTicket(page, 'Lifecycle ticket A');
    await createTicket(page, 'Lifecycle ticket B');
    await createTicket(page, 'Lifecycle ticket C');

    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Lifecycle ticket A"]')).toBeVisible();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Lifecycle ticket B"]')).toBeVisible();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Lifecycle ticket C"]')).toBeVisible();
  });

  test('change status through full lifecycle: not_started -> started -> completed', async ({ page }) => {
    await createTicket(page, 'Status lifecycle ticket');

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Status lifecycle ticket"]') });
    const statusBtn = row.locator('.ticket-status-btn');

    // Initial status: not_started
    await expect(statusBtn).toHaveAttribute('title', 'not started');

    // Click to cycle to started
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 5000 });

    // Click to cycle to completed
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'completed', { timeout: 5000 });
  });

  test('toggle up-next star and verify ticket appears in Up Next view', async ({ page }) => {
    await createTicket(page, 'Upnext view ticket');

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Upnext view ticket"]') });
    const star = row.locator('.ticket-star');

    // Star the ticket
    await star.click();
    await expect(star).toHaveClass(/active/, { timeout: 5000 });

    // Switch to Up Next view
    await page.locator('.sidebar-item[data-view="up-next"]').click();
    await expect(page.locator('.sidebar-item[data-view="up-next"]')).toHaveClass(/active/);

    // Ticket should be visible in the Up Next view
    await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="Upnext view ticket"]`)).toBeVisible({ timeout: 5000 });
  });

  test('select ticket via checkbox, verify batch toolbar shows count', async ({ page }) => {
    await createTicket(page, 'Checkbox select ticket');

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Checkbox select ticket"]') });
    const checkbox = row.locator('.ticket-checkbox');

    // Click the checkbox to select
    await checkbox.click();

    // Batch toolbar should show "1 selected"
    await expect(page.locator('#batch-count')).toHaveText('1 selected', { timeout: 5000 });
  });

  test('multi-select with Cmd+click shows correct count', async ({ page }) => {
    await createTicket(page, 'Multi select A');
    await createTicket(page, 'Multi select B');

    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Multi select A"]') });
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Multi select B"]') });

    // Select first ticket via checkbox
    await rowA.locator('.ticket-checkbox').click();
    await expect(page.locator('#batch-count')).toHaveText('1 selected', { timeout: 5000 });

    // Cmd+click (Meta on Mac) on second ticket row to add to selection
    await rowB.click({ modifiers: ['Meta'] });
    await expect(page.locator('#batch-count')).toHaveText('2 selected', { timeout: 5000 });
  });

  test('batch delete: select two tickets and delete via batch toolbar', async ({ page }) => {
    await createTicket(page, 'Batch del X');
    await createTicket(page, 'Batch del Y');
    await createTicket(page, 'Batch del survivor');

    // Select first via checkbox
    const rowX = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Batch del X"]') });
    await rowX.locator('.ticket-checkbox').click();
    await expect(page.locator('#batch-count')).toHaveText('1 selected', { timeout: 5000 });

    // Add second via checkbox
    const rowY = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Batch del Y"]') });
    await rowY.locator('.ticket-checkbox').click();
    await expect(page.locator('#batch-count')).toHaveText('2 selected', { timeout: 5000 });

    // Click batch delete button
    await page.locator('#batch-delete').click();

    // Both tickets should disappear from the list
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Batch del X"]')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Batch del Y"]')).toBeHidden({ timeout: 5000 });

    // Survivor should still be visible
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Batch del survivor"]')).toBeVisible();
  });

  test('move ticket to trash and verify it appears in Trash view', async ({ page }) => {
    await createTicket(page, 'Trash me ticket');

    // Select the ticket by clicking its number to open detail and select it
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Trash me ticket"]') });
    await row.locator('.ticket-checkbox').click();
    await expect(page.locator('#batch-count')).toHaveText('1 selected', { timeout: 5000 });

    // Click batch delete to move to trash
    await page.locator('#batch-delete').click();

    // Ticket should disappear from the main list
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Trash me ticket"]')).toBeHidden({ timeout: 5000 });

    // Switch to Trash view
    await page.locator('.sidebar-item[data-view="trash"]').click();
    await expect(page.locator('.sidebar-item[data-view="trash"]')).toHaveClass(/active/);

    // Ticket should appear in the trash view
    await expect(page.locator('.ticket-row[data-id]').filter({ has: page.locator('text=Trash me ticket') })).toBeVisible({ timeout: 5000 });
  });
});
