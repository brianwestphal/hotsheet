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

  test('arrow keys navigate attachments when attachment is focused (HS-6239)', async ({ page, request }) => {
    const suffix = Date.now();
    await request.post('/api/tickets', { headers, data: { title: `ColAtt A ${suffix}` } });
    await request.post('/api/tickets', { headers, data: { title: `ColAtt B ${suffix}` } });

    await request.patch('/api/settings', { headers, data: { layout: 'columns' } });
    await page.goto('/');
    await expect(page.locator('.columns-container')).toBeVisible({ timeout: 10000 });

    // Click the first card to select it and open detail panel
    const firstCard = page.locator('.column-card').first();
    await firstCard.click();
    await expect(firstCard).toHaveClass(/selected/, { timeout: 3000 });
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });

    // Upload two attachments via the file input
    const fileInput = page.locator('#detail-file-input');
    await fileInput.setInputFiles({
      name: 'att-one.txt', mimeType: 'text/plain', buffer: Buffer.from('first'),
    });
    await expect(page.locator('#detail-attachments .attachment-item').first()).toBeVisible({ timeout: 5000 });

    await fileInput.setInputFiles({
      name: 'att-two.txt', mimeType: 'text/plain', buffer: Buffer.from('second'),
    });
    await expect(page.locator('#detail-attachments .attachment-item')).toHaveCount(2, { timeout: 5000 });

    // Click first attachment to select/focus it
    const firstAtt = page.locator('#detail-attachments .attachment-item').first();
    await firstAtt.click();
    await expect(firstAtt).toHaveClass(/selected/, { timeout: 3000 });

    // ArrowDown should navigate to second attachment, NOT switch tickets
    await page.keyboard.press('ArrowDown');
    const secondAtt = page.locator('#detail-attachments .attachment-item').nth(1);
    await expect(secondAtt).toHaveClass(/selected/, { timeout: 3000 });
    await expect(firstAtt).not.toHaveClass(/selected/);

    // First card should still be selected (not switched to second card)
    await expect(firstCard).toHaveClass(/selected/);
  });
});
