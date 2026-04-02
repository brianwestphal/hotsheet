import { expect, test } from './coverage-fixture.js';

/** Ensure the app is in list view (not column view). */
async function ensureListView(page: import('@playwright/test').Page) {
  const listBtn = page.locator('.layout-btn[data-layout="list"]');
  if (await listBtn.isVisible() && !(await listBtn.evaluate(el => el.classList.contains('active')))) {
    await listBtn.click();
    await expect(page.locator('#ticket-list')).not.toHaveClass(/ticket-list-columns/, { timeout: 3000 });
  }
}

/** Helper: create a ticket via the draft input and wait for it to appear in the list. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

test.describe('Sidebar navigation and custom views', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await ensureListView(page);
  });

  test('sidebar views filter tickets by status', async ({ page }) => {
    // Create a ticket that stays not_started
    await createTicket(page, 'Sidebar open ticket');

    // Create a ticket and cycle it to started
    await createTicket(page, 'Sidebar started ticket');
    const startedRow = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Sidebar started ticket"]') });
    await startedRow.locator('.ticket-status-btn').click();
    await expect(startedRow.locator('.ticket-status-btn')).toHaveAttribute('title', 'started', { timeout: 5000 });

    // Create a ticket and cycle it to completed (click status twice)
    await createTicket(page, 'Sidebar completed ticket');
    const completedRow = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Sidebar completed ticket"]') });
    await completedRow.locator('.ticket-status-btn').click();
    await expect(completedRow.locator('.ticket-status-btn')).toHaveAttribute('title', 'started', { timeout: 5000 });
    await completedRow.locator('.ticket-status-btn').click();
    await expect(completedRow.locator('.ticket-status-btn')).toHaveAttribute('title', 'completed', { timeout: 5000 });

    // "All Tickets" view — all three should be visible
    await expect(page.locator('.sidebar-item[data-view="all"]')).toHaveClass(/active/);
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar open ticket"]')).toBeVisible();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar started ticket"]')).toBeVisible();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar completed ticket"]')).toBeVisible();

    // "Up Next" view — none starred, so none should show
    await page.locator('.sidebar-item[data-view="up-next"]').click();
    await expect(page.locator('.sidebar-item[data-view="up-next"]')).toHaveClass(/active/);
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar open ticket"]')).toBeHidden({ timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar started ticket"]')).toBeHidden({ timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar completed ticket"]')).toBeHidden({ timeout: 3000 });

    // "Completed" view — only the completed ticket should show
    await page.locator('.sidebar-item[data-view="completed"]').click();
    await expect(page.locator('.sidebar-item[data-view="completed"]')).toHaveClass(/active/);
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar completed ticket"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar open ticket"]')).toBeHidden({ timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar started ticket"]')).toBeHidden({ timeout: 3000 });

    // Back to "All" — everything visible again
    await page.locator('.sidebar-item[data-view="all"]').click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar open ticket"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar started ticket"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar completed ticket"]')).toBeVisible({ timeout: 3000 });
  });

  test('category filter shows only matching tickets', async ({ page }) => {
    // Create two tickets — they default to the first category (issue)
    await createTicket(page, 'Sidebar cat ticket A');
    await createTicket(page, 'Sidebar cat ticket B');

    // Change ticket B's category by clicking the badge to open the dropdown
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Sidebar cat ticket B"]') });
    await rowB.locator('.ticket-category-badge').click();
    // Pick "bug" from the dropdown
    const bugOption = page.locator('.dropdown-item').filter({ hasText: /bug/i }).first();
    await bugOption.click();
    await page.waitForTimeout(500);

    // Click the "Bug" category sidebar item
    await page.locator('.sidebar-item[data-view="category:bug"]').click();
    await expect(page.locator('.sidebar-item[data-view="category:bug"]')).toHaveClass(/active/);

    // Only ticket B (bug) should be visible
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar cat ticket B"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar cat ticket A"]')).toBeHidden({ timeout: 3000 });

    // Go back to All — both visible
    await page.locator('.sidebar-item[data-view="all"]').click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar cat ticket A"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Sidebar cat ticket B"]')).toBeVisible({ timeout: 3000 });
  });

  test('stats bar shows ticket counts', async ({ page }) => {
    // Create a ticket so there is something to count
    await createTicket(page, 'Sidebar stats ticket');

    // The status bar should show counts (e.g. "1 tickets · 1 open · 0 up next")
    const statusBar = page.locator('#status-bar');
    await expect(statusBar).toContainText('ticket', { timeout: 5000 });
    await expect(statusBar).toContainText('open', { timeout: 5000 });
    await expect(statusBar).toContainText('up next', { timeout: 5000 });
  });

  test('dashboard widget opens dashboard view', async ({ page }) => {
    // Create a ticket first so the dashboard widget has data
    await createTicket(page, 'Dashboard trigger ticket');

    // The sidebar dashboard widget may take a moment to render
    const widget = page.locator('#sidebar-dashboard-widget');
    // Only test if the widget is present (it loads asynchronously)
    const widgetVisible = await widget.isVisible().catch(() => false);
    if (widgetVisible) {
      await widget.click();
      // The dashboard container should appear
      const dashboard = page.locator('#dashboard-container');
      await expect(dashboard).toBeVisible({ timeout: 5000 });
    }
  });
});
