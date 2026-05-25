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

    await expect(async () => {
      const selectedCount = await page.locator('.column-card.selected').count();
      expect(selectedCount).toBeGreaterThan(0);
    }).toPass({ timeout: 3000 });

    // Click again to deselect
    await header.click();
    await expect(page.locator('.column-card.selected')).toHaveCount(0, { timeout: 3000 });
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
    await expect(async () => {
      const firstColSelected = await page.locator('.column-card.selected').count();
      expect(firstColSelected).toBeGreaterThan(0);
    }).toPass({ timeout: 3000 });

    // Click second column header (Started) WITHOUT modifier
    const secondHeader = page.locator('.column-header').nth(1);
    await secondHeader.click();

    // Only the second column's tickets should be selected — first column deselected
    const firstCol = page.locator('.column').first();
    const secondCol = page.locator('.column').nth(1);
    await expect(firstCol.locator('.column-card.selected')).toHaveCount(0, { timeout: 3000 });
    await expect(async () => {
      expect(await secondCol.locator('.column-card.selected').count()).toBeGreaterThan(0);
    }).toPass({ timeout: 3000 });
  });

  // HS-8623 — the selection toolbar "went missing again" in column view.
  // Root cause: backup-preview + dashboard modes hide `#batch-toolbar` via
  // `display:none`, and `renderColumnView` (unlike the list view) never
  // restored it, so returning to a live column view left the toolbar hidden.
  // Fix centralized the restore in `updateBatchToolbar()` — the chokepoint
  // every live-view selection update funnels through. This test simulates the
  // hide (exactly what those modes do) and asserts a live column-view
  // interaction brings the toolbar back.
  test('selection toolbar is restored after being hidden, on a column-view interaction (HS-8623)', async ({ page, request }) => {
    const suffix = Date.now();
    await request.post('/api/tickets', { headers, data: { title: `ColToolbar A ${suffix}` } });
    await request.post('/api/tickets', { headers, data: { title: `ColToolbar B ${suffix}` } });

    await request.patch('/api/settings', { headers, data: { layout: 'columns' } });
    await page.goto('/');
    await expect(page.locator('.columns-container')).toBeVisible({ timeout: 10000 });

    const toolbar = page.locator('#batch-toolbar');
    await expect(toolbar).toBeVisible({ timeout: 5000 });

    // Simulate the toolbar having been hidden, as backup-preview / dashboard
    // mode do (`#batch-toolbar { display: none }`).
    await page.evaluate(() => {
      const el = document.getElementById('batch-toolbar');
      if (el) el.style.display = 'none';
    });
    await expect(toolbar).toBeHidden();

    // A live column-view interaction (selecting a column) must bring it back.
    await page.locator('.column-header').first().click();
    await expect(toolbar).toBeVisible({ timeout: 3000 });
  });
});
