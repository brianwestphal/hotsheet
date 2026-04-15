/**
 * HS-5909: Column header click selects/deselects all tickets in that column.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Column header select (HS-5909)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.afterAll(async ({ request }) => {
    await request.patch('/api/settings', { headers, data: { layout: 'list' } });
  });

  test('clicking column header selects all, clicking again deselects', async ({ page, request }) => {
    const suffix = Date.now();
    await request.post('/api/tickets', { headers, data: { title: `ColSel A ${suffix}` } });
    await request.post('/api/tickets', { headers, data: { title: `ColSel B ${suffix}` } });

    await request.patch('/api/settings', { headers, data: { layout: 'columns' } });
    await page.goto('/');
    await expect(page.locator('.columns-container')).toBeVisible({ timeout: 10000 });

    const header = page.locator('.column-header').first();
    await header.click();
    await page.waitForTimeout(500);

    const selectedCount = await page.locator('.column-card.selected').count();
    expect(selectedCount).toBeGreaterThan(0);

    // Click again to deselect
    await header.click();
    await page.waitForTimeout(500);
    expect(await page.locator('.column-card.selected').count()).toBe(0);
  });

  test('clicking column header without modifier deselects other columns', async ({ page, request }) => {
    const suffix = Date.now();
    // Create tickets in different statuses
    const resA = await request.post('/api/tickets', { headers, data: { title: `ColMod A ${suffix}` } });
    const ticketA = await resA.json() as { id: number };
    await request.post('/api/tickets', { headers, data: { title: `ColMod B ${suffix}` } });
    // Move ticket A to Started
    await request.patch(`/api/tickets/${ticketA.id}`, {
      headers: { ...headers, 'X-Hotsheet-User-Action': 'true' },
      data: { status: 'started' },
    });

    await request.patch('/api/settings', { headers, data: { layout: 'columns' } });
    await page.goto('/');
    await expect(page.locator('.columns-container')).toBeVisible({ timeout: 10000 });

    // Click first column header (Not Started) to select those tickets
    const firstHeader = page.locator('.column-header').first();
    await firstHeader.click();
    await page.waitForTimeout(300);
    const firstColSelected = await page.locator('.column-card.selected').count();
    expect(firstColSelected).toBeGreaterThan(0);

    // Click second column header (Started) WITHOUT modifier
    const secondHeader = page.locator('.column-header').nth(1);
    await secondHeader.click();
    await page.waitForTimeout(300);

    // Only the second column's tickets should be selected — first column deselected
    const firstCol = page.locator('.column').first();
    const secondCol = page.locator('.column').nth(1);
    expect(await firstCol.locator('.column-card.selected').count()).toBe(0);
    expect(await secondCol.locator('.column-card.selected').count()).toBeGreaterThan(0);
  });
});
