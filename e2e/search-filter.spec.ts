/**
 * HS-5628: Search and filter workflows — text search, category filter, status filter.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Search and filter workflows (HS-5628)', () => {
  let headers: Record<string, string> = {};
  let titleBug: string, titleFeature: string, titleInvestigation: string;
  let suffix: number;

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page, request }) => {
    suffix = Date.now();
    titleBug = `Login bug fix ${suffix}`;
    titleFeature = `Dashboard feature ${suffix}`;
    titleInvestigation = `API investigation ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title: titleBug, defaults: { category: 'bug' } } });
    await request.post('/api/tickets', { headers, data: { title: titleFeature, defaults: { category: 'feature' } } });
    await request.post('/api/tickets', { headers, data: { title: titleInvestigation, defaults: { category: 'investigation' } } });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('search filters tickets by text', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    // Search by the unique suffix to match only our tickets
    await searchInput.fill(String(suffix));
    await page.waitForTimeout(400); // Wait for debounce

    // All 3 of our tickets should be visible (they all share the suffix)
    await expect(page.locator(`.ticket-title-input[value="${titleBug}"]`)).toBeVisible({ timeout: 3000 });
    await expect(page.locator(`.ticket-title-input[value="${titleFeature}"]`)).toBeVisible();
    await expect(page.locator(`.ticket-title-input[value="${titleInvestigation}"]`)).toBeVisible();

    // Now search for just "Login" + suffix to narrow to one
    await searchInput.fill(`Login bug fix ${suffix}`);
    await page.waitForTimeout(400);
    await expect(page.locator(`.ticket-title-input[value="${titleBug}"]`)).toBeVisible({ timeout: 3000 });
    await expect(page.locator(`.ticket-title-input[value="${titleFeature}"]`)).toBeHidden();
    await expect(page.locator(`.ticket-title-input[value="${titleInvestigation}"]`)).toBeHidden();
  });

  test('clear search shows all tickets again', async ({ page }) => {
    const searchInput = page.locator('#search-input');
    await searchInput.fill(`Login bug fix ${suffix}`);
    await page.waitForTimeout(400);

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(400);

    // All tickets should be visible again
    await expect(page.locator(`.ticket-title-input[value="${titleBug}"]`)).toBeVisible({ timeout: 3000 });
    await expect(page.locator(`.ticket-title-input[value="${titleFeature}"]`)).toBeVisible();
    await expect(page.locator(`.ticket-title-input[value="${titleInvestigation}"]`)).toBeVisible();
  });

  test('filter by category via sidebar', async ({ page }) => {
    // Click the Bug category in the sidebar
    const bugBtn = page.locator('.sidebar-item[data-view="category:bug"]');
    await bugBtn.click();
    await page.waitForTimeout(300);

    // Only bug tickets should show
    await expect(page.locator(`.ticket-title-input[value="${titleBug}"]`)).toBeVisible({ timeout: 3000 });
    await expect(page.locator(`.ticket-title-input[value="${titleFeature}"]`)).toBeHidden();

    // Click "All" to show everything again
    await page.locator('.sidebar-item[data-view="all"]').click();
    await page.waitForTimeout(300);
    await expect(page.locator(`.ticket-title-input[value="${titleFeature}"]`)).toBeVisible({ timeout: 3000 });
  });

  test('filter by completed status via sidebar', async ({ page, request }) => {
    // Mark one ticket as completed via API
    const ticketsRes = await request.get('/api/tickets', { headers });
    const tickets = await ticketsRes.json() as { id: number; title: string }[];
    const bugTicket = tickets.find(t => t.title === titleBug);
    expect(bugTicket).toBeTruthy();
    await request.patch(`/api/tickets/${bugTicket!.id}`, { headers, data: { status: 'completed' } });

    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Click "Completed" in sidebar
    await page.locator('.sidebar-item[data-view="completed"]').click();
    await page.waitForTimeout(500);

    // Our completed ticket should be visible; our non-completed tickets should not
    await expect(page.locator(`.ticket-title-input[value="${titleBug}"]`)).toBeVisible({ timeout: 5000 });
    await expect(page.locator(`.ticket-title-input[value="${titleFeature}"]`)).toBeHidden({ timeout: 3000 });
  });

  test('Cmd+F focuses the search input', async ({ page }) => {
    await page.keyboard.press('Meta+f');
    await expect(page.locator('#search-input')).toBeFocused({ timeout: 3000 });
  });
});
