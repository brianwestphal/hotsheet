/**
 * HS-5628: Settings persistence — change settings and verify they survive reload.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Settings persistence (HS-5628)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.afterAll(async ({ request }) => {
    // Reset sort to default so other tests aren't affected
    await request.patch('/api/settings', { headers, data: { sort_by: 'created', sort_dir: 'desc', detail_position: 'side' } });
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('detail position change persists after reload', async ({ page, request }) => {
    // Set detail position to bottom via API
    await request.patch('/api/settings', { headers, data: { detail_position: 'bottom' } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Content area should have the bottom class
    await expect(page.locator('#content-area')).toHaveClass(/detail-bottom/, { timeout: 3000 });

    // Reset to side
    await request.patch('/api/settings', { headers, data: { detail_position: 'side' } });
  });

  test('sort order persists after reload', async ({ page, request }) => {
    const suffix = Date.now();
    // Create tickets
    await request.post('/api/tickets', { headers, data: { title: `Sort test A ${suffix}` } });
    await request.post('/api/tickets', { headers, data: { title: `Sort test Z ${suffix}` } });

    // Change sort to category ascending
    await request.patch('/api/settings', { headers, data: { sort_by: 'category', sort_dir: 'asc' } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Verify sort dropdown shows the right value
    const sortSelect = page.locator('#sort-select');
    await expect(sortSelect).toHaveValue('category:asc', { timeout: 3000 });

    // Reset sort
    await request.patch('/api/settings', { headers, data: { sort_by: 'created', sort_dir: 'desc' } });
  });

  test('up-next star state persists via API', async ({ page, request }) => {
    const suffix = Date.now();
    const starTitle = `Star persist test ${suffix}`;
    const res = await request.post('/api/tickets', { headers, data: { title: starTitle } });
    const ticket = await res.json() as { id: number };

    // Toggle up_next on
    await request.patch(`/api/tickets/${ticket.id}`, { headers, data: { up_next: true } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Verify the star is active
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${starTitle}"]`) }).first();
    await expect(row.locator('.ticket-star')).toHaveClass(/active/, { timeout: 5000 });
  });
});
