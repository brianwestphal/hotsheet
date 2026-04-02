import { expect, test } from './coverage-fixture.js';

/** Helper: create a ticket via the draft input. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

test.describe('View navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('switch between sidebar views', async ({ page }) => {
    // Create a ticket so there is something visible
    await createTicket(page, 'Nav test ticket');

    // "All Tickets" should be active by default
    await expect(page.locator('.sidebar-item[data-view="all"]')).toHaveClass(/active/);
    // Our ticket should be visible in the "All" view
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Nav test ticket"]')).toBeVisible();

    // Click "Up Next" — our ticket is not starred, so it should not appear
    await page.locator('.sidebar-item[data-view="up-next"]').click();
    await expect(page.locator('.sidebar-item[data-view="up-next"]')).toHaveClass(/active/);
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Nav test ticket"]')).toBeHidden({ timeout: 3000 });

    // Click "Completed" — our ticket is not completed
    await page.locator('.sidebar-item[data-view="completed"]').click();
    await expect(page.locator('.sidebar-item[data-view="completed"]')).toHaveClass(/active/);
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Nav test ticket"]')).toBeHidden({ timeout: 3000 });

    // Go back to "All" — ticket should be visible again
    await page.locator('.sidebar-item[data-view="all"]').click();
    await expect(page.locator('.sidebar-item[data-view="all"]')).toHaveClass(/active/);
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Nav test ticket"]')).toBeVisible({ timeout: 3000 });
  });

  test('switch to column view and back', async ({ page }) => {
    await createTicket(page, 'Column view ticket');

    // Click the column layout button
    const columnBtn = page.locator('.layout-btn[data-layout="columns"]');
    await columnBtn.click();
    await expect(columnBtn).toHaveClass(/active/);

    // Column headers should appear (4 statuses: Not Started, Started, Completed, Verified)
    await expect(page.locator('.column-header')).toHaveCount(4, { timeout: 5000 });

    // At least one column card should exist (our ticket)
    const cards = page.locator('.column-card[data-id]');
    await expect(cards.first()).toBeVisible({ timeout: 3000 });

    // Switch back to list view
    const listBtn = page.locator('.layout-btn[data-layout="list"]');
    await listBtn.click();
    await expect(listBtn).toHaveClass(/active/);

    // Column headers should be gone, ticket rows should be visible
    await expect(page.locator('.column-header')).toHaveCount(0, { timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id]').first()).toBeVisible();
  });

  test('search input filters tickets', async ({ page }) => {
    // Use unique prefixes to avoid collisions with other tests
    await createTicket(page, 'Xalpha unique search');
    await createTicket(page, 'Xbeta unique search');

    // Both should be visible
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Xalpha unique search"]')).toBeVisible();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Xbeta unique search"]')).toBeVisible();

    // Type in search box to filter
    const searchInput = page.locator('#search-input');
    await searchInput.fill('Xalpha');

    // Only the "Xalpha" ticket should remain
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Xalpha unique search"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Xbeta unique search"]')).toBeHidden({ timeout: 5000 });

    // Clear search — both should appear again
    await searchInput.fill('');
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Xalpha unique search"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Xbeta unique search"]')).toBeVisible({ timeout: 5000 });
  });
});
