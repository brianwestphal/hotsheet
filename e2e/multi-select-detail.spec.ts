/**
 * HS-5628: Multi-ticket detail panel behavior.
 * Tests: select multiple → placeholder shown → deselect to one → detail loads.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Multi-select detail panel (HS-5628)', () => {
  let headers: Record<string, string> = {};
  let titleA: string, titleB: string, titleC: string;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    const suffix = Date.now();
    titleA = `Multi A ${suffix}`;
    titleB = `Multi B ${suffix}`;
    titleC = `Multi C ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title: titleA } });
    await request.post('/api/tickets', { headers, data: { title: titleB } });
    await request.post('/api/tickets', { headers, data: { title: titleC } });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('selecting one ticket shows its detail', async ({ page }) => {
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    await row.locator('.ticket-number').click();

    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#detail-title')).toHaveValue(titleA);
    await expect(page.locator('#detail-placeholder')).toBeHidden();
  });

  test('selecting multiple tickets shows placeholder', async ({ page }) => {
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleB}"]`) }).first();

    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });

    // Detail should show placeholder with item count
    await expect(page.locator('#detail-placeholder')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#detail-placeholder-text')).toContainText('2 items selected');
    await expect(page.locator('#detail-header')).toBeHidden();
  });

  test('deselecting to one ticket loads its detail', async ({ page }) => {
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleB}"]`) }).first();

    // Select both
    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });
    await expect(page.locator('#detail-placeholder-text')).toContainText('2 items selected');

    // Click only B (without modifier) — deselects A, selects only B
    await rowB.locator('.ticket-number').click();

    // Detail should load for Multi B
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#detail-title')).toHaveValue(titleB);
  });

  test('right-click on selected ticket preserves multi-selection (HS-6257)', async ({ page }) => {
    const rowA = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleB}"]`) }).first();

    // Select A, then Cmd+click B to add to selection
    await rowA.locator('.ticket-number').click();
    await rowB.locator('.ticket-number').click({ modifiers: ['Meta'] });
    await expect(rowA).toHaveClass(/selected/, { timeout: 3000 });
    await expect(rowB).toHaveClass(/selected/);

    // Right-click on A — selection should stay (both still selected)
    await rowA.click({ button: 'right' });
    await expect(rowA).toHaveClass(/selected/);
    await expect(rowB).toHaveClass(/selected/);

    // Context menu should be visible
    await expect(page.locator('.context-menu')).toBeVisible({ timeout: 3000 });

    // Close the context menu
    await page.keyboard.press('Escape');
  });

  test('Escape deselects all and shows "Nothing selected"', async ({ page }) => {
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${titleA}"]`) }).first();
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });

    // Press Escape to close detail
    await page.keyboard.press('Escape');

    await expect(page.locator('#detail-placeholder')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#detail-placeholder-text')).toContainText('Nothing selected');
  });
});
