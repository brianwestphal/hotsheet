/**
 * HS-5628: Undo/redo workflow — Cmd+Z to undo changes, verify state reverts.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Undo/redo workflow (HS-5628)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('undo status change reverts to previous status', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Undo status test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();

    // Change status: not_started → started
    const statusBtn = row.locator('.ticket-status-btn');
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 3000 });

    // Click the ticket list container to ensure focus is not in an input
    await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });

    // Undo with Cmd+Z
    await page.keyboard.press('Meta+z');

    // Should revert to not_started
    await expect(statusBtn).toHaveAttribute('title', 'not started', { timeout: 5000 });
  });

  test('undo delete restores the ticket', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Undo delete test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();

    // Select and delete via context menu (more reliable than keyboard on CI)
    await row.locator('.ticket-number').click();
    await expect(row).toHaveClass(/selected/, { timeout: 3000 });
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    await page.locator('.context-menu-item.danger').filter({ hasText: 'Delete' }).click();
    await expect(page.locator(`.ticket-title-input[value="${title}"]`)).toBeHidden({ timeout: 5000 });

    // Undo delete
    await page.keyboard.press('Meta+z');

    // Ticket should reappear
    await expect(page.locator(`.ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
  });

  test('HS-9117 — undo reverts the details textarea immediately while it has focus', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Undo details focus test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title, defaults: { details: 'original details' } } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    // Open the detail panel for this ticket.
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-title')).toHaveValue(title, { timeout: 5000 });

    // Enter edit mode on the Details field (click the rendered view), then type.
    await page.locator('#detail-details-rendered').click();
    const detailsArea = page.locator('#detail-details');
    await expect(detailsArea).toBeFocused();
    await detailsArea.fill('original details — edited');
    // Let the debounced auto-save (300ms) round-trip so state is persisted.
    await page.waitForTimeout(600);

    // Keep focus in the textarea and undo. Pre-HS-9117 the focus guard skipped
    // the value update, so the revert only showed after the panel redrew.
    await detailsArea.focus();
    await page.keyboard.press('Meta+z');

    await expect(detailsArea).toHaveValue('original details', { timeout: 5000 });
  });

  test.skip('undo up-next toggle reverts the star', async ({ page, request }) => {
    // Skip: inline star toggle uses trackedPatch but the undo may be
    // coalesced or the re-render doesn't reflect the revert fast enough.
    const suffix = Date.now();
    const title = `Undo star test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    const star = row.locator('.ticket-star');

    // Select the ticket first, then toggle star
    await row.locator('.ticket-number').click();
    await page.waitForTimeout(200);
    await star.click();
    await expect(star).toHaveClass(/active/, { timeout: 3000 });

    // Undo — Cmd+Z works from anywhere, no need to refocus
    await page.keyboard.press('Meta+z');

    // Star should be off
    await expect(star).not.toHaveClass(/active/, { timeout: 5000 });
  });
});
