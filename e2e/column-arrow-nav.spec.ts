/**
 * HS-6040: Arrow key navigation in column view.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Column view arrow navigation (HS-6040)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.afterAll(async ({ request }) => {
    await request.patch('/api/settings', { headers, data: { layout: 'list' } });
  });

  test('click card then ArrowDown selects the next card', async ({ page, request }) => {
    const suffix = Date.now();
    await request.post('/api/tickets', { headers, data: { title: `ColNav A ${suffix}` } });
    await request.post('/api/tickets', { headers, data: { title: `ColNav B ${suffix}` } });

    await request.patch('/api/settings', { headers, data: { layout: 'columns' } });
    await page.goto('/');
    await expect(page.locator('.columns-container')).toBeVisible({ timeout: 10000 });

    // Click the first card to select and focus it
    const firstCard = page.locator('.column-card').first();
    await firstCard.click();
    await expect(firstCard).toHaveClass(/selected/, { timeout: 3000 });

    // Press ArrowDown to move to next card
    await page.keyboard.press('ArrowDown');

    // Second card should now be selected, first should not
    const secondCard = page.locator('.column-card').nth(1);
    await expect(secondCard).toHaveClass(/selected/, { timeout: 3000 });
    await expect(firstCard).not.toHaveClass(/selected/);
  });
});
