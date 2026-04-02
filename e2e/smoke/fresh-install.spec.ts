import { expect, test } from '@playwright/test';

// Smoke tests for a fresh npm install of hotsheet.
// Prerequisites (handled by CI):
//   1. hotsheet is installed globally via npm
//   2. hotsheet is running with --data-dir <temp> --no-open --port $SMOKE_PORT

test.describe('Fresh install smoke test', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 15000 });
  });

  test('page loads with draft input and sidebar', async ({ page }) => {
    await expect(page.locator('.draft-input')).toBeVisible();
    await expect(page.locator('.sidebar-item[data-view="all"]')).toBeVisible();
    await expect(page.locator('.sidebar-item[data-view="up-next"]')).toBeVisible();
  });

  test('create a ticket via draft input', async ({ page }) => {
    const draft = page.locator('.draft-input');
    await draft.fill('Smoke test ticket');
    await draft.press('Enter');
    const row = page.locator('.ticket-row[data-id]').first();
    await expect(row).toBeVisible({ timeout: 5000 });
    // Verify ticket number assigned
    await expect(row.locator('.ticket-number')).toContainText('HS-');
  });

  test('open detail panel and edit title', async ({ page }) => {
    // Create a ticket first
    const draft = page.locator('.draft-input');
    await draft.fill('Detail smoke test');
    await draft.press('Enter');
    await expect(page.locator('.ticket-row[data-id]')).toBeVisible({ timeout: 5000 });

    // Click to open detail panel
    await page.locator('.ticket-row[data-id] .ticket-number').first().click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });

    // Edit title in detail panel
    const detailTitle = page.locator('#detail-title');
    await detailTitle.fill('Updated smoke title');
    await page.waitForTimeout(500); // Wait for debounced save

    // Verify the list row updated
    await expect(page.locator('.ticket-title-input[value="Updated smoke title"]')).toBeVisible({ timeout: 5000 });
  });

  test('change ticket status and toggle up-next', async ({ page }) => {
    // Create a ticket
    const draft = page.locator('.draft-input');
    await draft.fill('Status smoke test');
    await draft.press('Enter');
    const row = page.locator('.ticket-row[data-id]').filter({
      has: page.locator('.ticket-title-input[value="Status smoke test"]'),
    });
    await expect(row).toBeVisible({ timeout: 5000 });

    // Cycle status
    const statusBtn = row.locator('.ticket-status-btn');
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 5000 });

    // Toggle up-next star
    const star = row.locator('.ticket-star');
    await star.click();
    await expect(star).toHaveClass(/active/, { timeout: 5000 });
  });

  test('search filters tickets', async ({ page }) => {
    // Create two tickets
    const draft = page.locator('.draft-input');
    await draft.fill('Findable ticket');
    await draft.press('Enter');
    await expect(page.locator('.ticket-title-input[value="Findable ticket"]')).toBeVisible({ timeout: 5000 });

    await draft.fill('Hidden ticket');
    await draft.press('Enter');
    await expect(page.locator('.ticket-title-input[value="Hidden ticket"]')).toBeVisible({ timeout: 5000 });

    // Search for one
    const searchInput = page.locator('#search-input');
    await searchInput.fill('Findable');
    await page.waitForTimeout(300); // Debounce

    // Findable should be visible, Hidden should not
    await expect(page.locator('.ticket-title-input[value="Findable ticket"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.ticket-title-input[value="Hidden ticket"]')).toBeHidden({ timeout: 5000 });
  });

  test('API health check', async ({ page }) => {
    const statsRes = await page.request.get('/api/stats');
    expect(statsRes.ok()).toBe(true);
    const stats = await statsRes.json();
    expect(stats).toHaveProperty('total');
    expect(stats).toHaveProperty('open');
    expect(stats).toHaveProperty('up_next');
  });
});
