import { expect, test } from './coverage-fixture.js';

/** Ensure the app is in list view (not column view). */
async function ensureListView(page: import('@playwright/test').Page) {
  const listBtn = page.locator('.layout-btn[data-layout="list"]');
  if (await listBtn.isVisible() && !(await listBtn.evaluate(el => el.classList.contains('active')))) {
    await listBtn.click();
    await expect(page.locator('#ticket-list')).not.toHaveClass(/ticket-list-columns/, { timeout: 3000 });
  }
}

/** Helper: create a ticket via the draft input in list view and wait for it to appear. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

test.describe('Column view', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureListView(page);
  });

  test('switch to column view and verify columns container appears', async ({ page }) => {
    await createTicket(page, 'Column layout ticket');

    // Click the column layout button
    const columnBtn = page.locator('.layout-btn[data-layout="columns"]');
    await columnBtn.click();
    await expect(columnBtn).toHaveClass(/active/);

    // The ticket list should have the columns class
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });
  });

  test('column view has multiple column elements', async ({ page }) => {
    await createTicket(page, 'Column count ticket');

    await page.locator('.layout-btn[data-layout="columns"]').click();

    // Should have multiple column elements (Not Started, Started, Completed, Verified)
    const columns = page.locator('.column[data-status]');
    await expect(columns).toHaveCount(4, { timeout: 5000 });

    // Each column should have a header
    await expect(page.locator('.column-header')).toHaveCount(4, { timeout: 5000 });
  });

  test('create a ticket in column view via draft input', async ({ page }) => {
    // First switch to column view
    await page.locator('.layout-btn[data-layout="columns"]').click();
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });

    // The draft input should still be visible in column view
    const draft = page.locator('.draft-input');
    await expect(draft).toBeVisible();

    // Create a ticket
    await draft.fill('Column new ticket');
    await draft.press('Enter');

    // The ticket should appear as a column card
    await expect(page.locator('.column-card[data-id]').filter({ hasText: 'Column new ticket' })).toBeVisible({ timeout: 5000 });
  });

  test('click a column card to select it and open detail panel', async ({ page }) => {
    await createTicket(page, 'Column detail ticket');

    // Switch to column view
    await page.locator('.layout-btn[data-layout="columns"]').click();
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });

    // Find and click the column card
    const card = page.locator('.column-card[data-id]').filter({ hasText: 'Column detail ticket' });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();

    // Card should be selected
    await expect(card).toHaveClass(/selected/, { timeout: 3000 });

    // Detail panel should open
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#detail-title')).toHaveValue('Column detail ticket');
  });

  test('switch back to list view and verify layout restores', async ({ page }) => {
    await createTicket(page, 'Column restore ticket');

    // Switch to column view
    const columnBtn = page.locator('.layout-btn[data-layout="columns"]');
    await columnBtn.click();
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });

    // Switch back to list view
    const listBtn = page.locator('.layout-btn[data-layout="list"]');
    await listBtn.click();
    await expect(listBtn).toHaveClass(/active/);

    // Column class should be removed, ticket rows should be visible
    await expect(page.locator('#ticket-list')).not.toHaveClass(/ticket-list-columns/, { timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id]').first()).toBeVisible({ timeout: 3000 });
  });

  test('draft input works in both views', async ({ page }) => {
    // Create a ticket in list view
    await createTicket(page, 'Draft list ticket');
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Draft list ticket"]')).toBeVisible();

    // Switch to column view
    await page.locator('.layout-btn[data-layout="columns"]').click();
    await expect(page.locator('#ticket-list')).toHaveClass(/ticket-list-columns/, { timeout: 5000 });

    // Draft input should be available
    const draft = page.locator('.draft-input');
    await expect(draft).toBeVisible();

    // Create another ticket in column view
    await draft.fill('Draft column ticket');
    await draft.press('Enter');
    await expect(page.locator('.column-card[data-id]').filter({ hasText: 'Draft column ticket' })).toBeVisible({ timeout: 5000 });

    // Switch back to list view — both tickets should be visible as rows
    await page.locator('.layout-btn[data-layout="list"]').click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Draft list ticket"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Draft column ticket"]')).toBeVisible({ timeout: 5000 });
  });
});
