/**
 * HS-5182: ticket copy/cut/paste via keyboard shortcuts.
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draftInput = page.locator('.draft-input');
  await draftInput.fill(title);
  await draftInput.press('Enter');
  await expect(page.locator(`.ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 3000 });
}

async function selectTicket(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-checkbox').click();
  // Blur active element so focus is not in an INPUT — the shortcut handler
  // skips Cmd+C/X/V when isInput is true (checkbox is still an INPUT tag).
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

test.describe('Ticket copy/cut/paste (HS-5182)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('Cmd+C then Cmd+V copies a ticket with (Copy) suffix', async ({ page }) => {
    const tag = Date.now().toString(36);
    const title = `Copy ${tag}`;
    await createTicket(page, title);
    await selectTicket(page, title);

    const countBefore = await page.locator('.ticket-row[data-id]').count();

    // Copy then paste
    await page.keyboard.press('Meta+c');
    await page.keyboard.press('Meta+v');
    await expect(page.locator('.ticket-row[data-id]')).toHaveCount(countBefore + 1, { timeout: 3000 });

    // The pasted ticket should have "(Copy)" suffix
    await expect(page.locator(`.ticket-title-input[value="${title} (Copy)"]`)).toBeVisible();
  });

  test('Cmd+X then Cmd+V moves the ticket (cut + paste)', async ({ page }) => {
    const tag = Date.now().toString(36);
    const title = `Cut ${tag}`;
    await createTicket(page, title);
    await selectTicket(page, title);

    const countBefore = await page.locator('.ticket-row[data-id]').count();

    // Cut
    await page.keyboard.press('Meta+x');

    // The cut ticket should show with reduced opacity (cut styling)
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
    await expect(row).toHaveClass(/cut/, { timeout: 2000 });

    // Paste — original is deleted, new copy created with same title
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(500);

    // Count should be the same (one deleted, one created)
    const countAfter = await page.locator('.ticket-row[data-id]').count();
    expect(countAfter).toBe(countBefore);
  });

  test('Pasting twice deduplicates with (Copy) and (Copy 2)', async ({ page }) => {
    const tag = Date.now().toString(36);
    const title = `Dedup ${tag}`;
    await createTicket(page, title);
    await selectTicket(page, title);

    const countBefore = await page.locator('.ticket-row[data-id]').count();

    // Copy and paste twice
    await page.keyboard.press('Meta+c');
    await page.keyboard.press('Meta+v');
    await expect(page.locator('.ticket-row[data-id]')).toHaveCount(countBefore + 1, { timeout: 3000 });
    await page.keyboard.press('Meta+v');
    await expect(page.locator('.ticket-row[data-id]')).toHaveCount(countBefore + 2, { timeout: 3000 });

    await expect(page.locator(`.ticket-title-input[value="${title} (Copy)"]`)).toBeVisible();
    await expect(page.locator(`.ticket-title-input[value="${title} (Copy 2)"]`)).toBeVisible();
  });
});
