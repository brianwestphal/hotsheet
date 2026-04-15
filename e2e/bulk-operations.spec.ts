/**
 * HS-5628: Bulk operations — multi-select, batch status/category changes, batch delete.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Bulk operations (HS-5628)', () => {
  let headers: Record<string, string> = {};
  let titleA: string, titleB: string, titleC: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    const suffix = Date.now();
    titleA = `Bulk A ${suffix}`;
    titleB = `Bulk B ${suffix}`;
    titleC = `Bulk C ${suffix}`;
    for (const title of [titleA, titleB, titleC]) {
      await request.post('/api/tickets', { headers, data: { title } });
    }
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('select multiple tickets with Shift+click', async ({ page }) => {
    const rows = page.locator('.ticket-row[data-id]');
    const firstRow = rows.filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const lastRow = rows.filter({ has: page.locator(`.ticket-title-input[value="${titleC}"]`) }).first();

    // Click first row
    await firstRow.locator('.ticket-number').click();
    await expect(firstRow).toHaveClass(/selected/, { timeout: 3000 });

    // Shift+click last row to select range
    await lastRow.locator('.ticket-number').click({ modifiers: ['Shift'] });
    await page.waitForTimeout(300);

    // Multiple rows should be selected
    const selectedCount = await page.locator('.ticket-row.selected').count();
    expect(selectedCount).toBeGreaterThanOrEqual(2);

    // Detail placeholder should show "N items selected"
    await expect(page.locator('#detail-placeholder-text')).toContainText('items selected', { timeout: 3000 });
  });

  test('batch change status via context menu', async ({ page }) => {
    // Select multiple tickets with Cmd+click
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleB}"]`) }).first();

    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });
    await page.waitForTimeout(200);

    // Right-click → Status → Started
    await rowA.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    const statusSubmenu = page.locator('.context-menu-item.has-submenu').filter({ hasText: 'Status' });
    await statusSubmenu.hover();
    // Wait for the Status submenu's children to appear
    const statusSubmenuContent = statusSubmenu.locator('.context-submenu');
    await expect(statusSubmenuContent).toBeVisible({ timeout: 3000 });
    await statusSubmenuContent.locator('.context-menu-item .context-menu-label').filter({ hasText: /^Started$/ }).click();
    await page.waitForTimeout(500);

    // Both should now show started status
    await expect(rowA.locator('.ticket-status-btn')).toHaveAttribute('title', 'started', { timeout: 3000 });
    await expect(rowB.locator('.ticket-status-btn')).toHaveAttribute('title', 'started', { timeout: 3000 });
  });

  test('batch delete via context menu', async ({ page }) => {
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleB}"]`) }).first();

    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });
    await page.waitForTimeout(200);

    // Right-click → Delete
    await rowA.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(100);
    const deleteItem = page.locator('.context-menu-item.danger').filter({ hasText: 'Delete' });
    await deleteItem.click();
    await page.waitForTimeout(500);

    // Both should be gone from the list
    await expect(page.locator(`.ticket-title-input[value="${titleA}"]`)).toBeHidden({ timeout: 5000 });
    await expect(page.locator(`.ticket-title-input[value="${titleB}"]`)).toBeHidden({ timeout: 5000 });
    // Bulk C should still be visible
    await expect(page.locator(`.ticket-title-input[value="${titleC}"]`)).toBeVisible();
  });
});
