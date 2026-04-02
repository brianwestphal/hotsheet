import { expect, test } from './coverage-fixture.js';

/** Helper: create a ticket via the draft input and wait for it to appear in the list. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  // Wait for the ticket row to appear with the given title
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

test.describe('Ticket management', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the app to initialize — draft input is visible when ready
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('create a ticket and verify it appears', async ({ page }) => {
    await createTicket(page, 'My first ticket');
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="My first ticket"]') });
    await expect(row).toBeVisible();
    // Should have a ticket number like HS-1
    await expect(row.locator('.ticket-number')).toContainText('HS-');
  });

  test('click a ticket row to open the detail panel', async ({ page }) => {
    await createTicket(page, 'Detail panel ticket');

    // Click the category badge area of the row (not on an input/button) to select it
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Detail panel ticket"]') });
    await row.locator('.ticket-number').click();

    // Detail panel should show the ticket number and title
    const detailHeader = page.locator('#detail-header');
    await expect(detailHeader).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#detail-ticket-number')).toContainText('HS-');
    await expect(page.locator('#detail-title')).toHaveValue('Detail panel ticket');
  });

  test('edit ticket title in the detail panel', async ({ page }) => {
    await createTicket(page, 'Original title');

    // Open detail panel by clicking the row
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Original title"]') });
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });

    // Edit the title in the detail panel
    const detailTitle = page.locator('#detail-title');
    await detailTitle.fill('Updated title');

    // Wait for debounced save (the app debounces saves)
    await page.waitForTimeout(1000);

    // Verify the list row title updated
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Updated title"]')).toBeVisible({ timeout: 5000 });
  });

  test('change ticket status by clicking the status button', async ({ page }) => {
    await createTicket(page, 'Status test ticket');

    // Initial status should be "not_started" (circle icon)
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Status test ticket"]') });
    const statusBtn = row.locator('.ticket-status-btn');
    await expect(statusBtn).toHaveAttribute('title', 'not started');

    // Click to cycle status to "started"
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 5000 });

    // Click again to cycle to "completed"
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'completed', { timeout: 5000 });
  });

  test('toggle the up-next star', async ({ page }) => {
    await createTicket(page, 'Star test ticket');

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Star test ticket"]') });
    const star = row.locator('.ticket-star');

    // Initially not active
    await expect(star).not.toHaveClass(/active/);

    // Click to toggle on
    await star.click();
    await expect(star).toHaveClass(/active/, { timeout: 5000 });

    // Click to toggle off
    await star.click();
    await expect(star).not.toHaveClass(/active/, { timeout: 5000 });
  });

  test('delete a ticket via keyboard', async ({ page }) => {
    await createTicket(page, 'Ticket to delete');

    // Click the row to select it (click on ticket number area, not on input)
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Ticket to delete"]') });
    await row.locator('.ticket-number').click();
    await expect(row).toHaveClass(/selected/, { timeout: 3000 });

    // Press Backspace while focus is not in an input — need to click a non-input area first
    // Click on the ticket list container to move focus away from any input
    await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Backspace');

    // Ticket should disappear from the list (moved to trash)
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Ticket to delete"]')).toBeHidden({ timeout: 5000 });
  });
});
