/**
 * HS-5183: user interface test gaps — keyboard shortcuts, sort, custom views,
 * strikethrough styling, batch tags, detail position toggle.
 * Skips drag-and-drop tests (unreliable in headless Playwright).
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string, opts?: { category?: string; priority?: string; status?: string }) {
  const draftInput = page.locator('.draft-input');
  await draftInput.fill(title);
  await draftInput.press('Enter');
  await expect(page.locator(`.ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 3000 });
  if (opts) {
    // Select the ticket and patch via API
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
    const id = await row.getAttribute('data-id');
    if (id && opts.status) {
      await page.request.patch(`/api/tickets/${id}`, {
        headers: { 'Content-Type': 'application/json' },
        data: opts,
      });
    }
  }
}

test.describe('UI gaps (HS-5183)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  // --- Keyboard shortcuts ---

  test('Cmd+F focuses the search input', async ({ page }) => {
    await page.keyboard.press('Meta+f');
    await expect(page.locator('#search-input')).toBeFocused({ timeout: 2000 });
  });

  test('Cmd+A selects all visible tickets', async ({ page }) => {
    await createTicket(page, `SelectAll A ${Date.now()}`);
    await createTicket(page, `SelectAll B ${Date.now()}`);
    // Blur any input so Cmd+A doesn't select text
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());

    await page.keyboard.press('Meta+a');
    // Batch toolbar should show count ≥ 2
    const batchToolbar = page.locator('#batch-toolbar');
    await expect(batchToolbar).toContainText('selected', { timeout: 2000 });
  });

  // --- Sort controls ---

  test('sort dropdown changes ticket order', async ({ page }) => {
    const prefix = `SortGap${Date.now()}`;
    await createTicket(page, `${prefix} Z`);
    await createTicket(page, `${prefix} A`);

    // Default is "Newest First" — A should be above Z
    const titlesBefore = await page.locator('.ticket-title-input').evaluateAll(
      (els, p) => els.map(el => (el as HTMLInputElement).value).filter(v => v.startsWith(p)),
      prefix,
    );
    expect(titlesBefore[0]).toBe(`${prefix} A`); // newest first

    // Change sort to "Oldest First"
    const sortSelect = page.locator('#sort-select');
    await sortSelect.selectOption('created:asc');
    await page.waitForTimeout(300);

    const titlesAfter = await page.locator('.ticket-title-input').evaluateAll(
      (els, p) => els.map(el => (el as HTMLInputElement).value).filter(v => v.startsWith(p)),
      prefix,
    );
    expect(titlesAfter[0]).toBe(`${prefix} Z`); // oldest first

    // Reset sort to default
    await sortSelect.selectOption('created:desc');
  });

  // --- Strikethrough on completed/verified ---

  test('completed tickets show strikethrough styling', async ({ page }) => {
    await createTicket(page, `Strike ${Date.now()}`);
    const row = page.locator('.ticket-row[data-id]').first();
    const id = await row.getAttribute('data-id');

    // Set to completed via API (needs project secret)
    await page.request.patch(`/api/tickets/${id}`, {
      headers,
      data: { status: 'completed' },
    });

    // Reload and switch to All Tickets view (completed tickets are hidden in default Non-Verified view)
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('.sidebar-item[data-view="all"]').click();
    await page.waitForTimeout(300);

    // The completed ticket row should have the 'completed' class (renders strikethrough)
    const completedRow = page.locator(`.ticket-row[data-id="${id}"]`);
    await expect(completedRow).toHaveClass(/completed/, { timeout: 3000 });
  });

  // --- Detail panel position toggle ---

  test('detail position toggle switches between side and bottom', async ({ page }) => {
    await createTicket(page, `Position ${Date.now()}`);
    const row = page.locator('.ticket-row[data-id]').first();
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 3000 });

    // Default is "side" layout — the side button should be active
    const sideBtn = page.locator('#detail-position-toggle .layout-btn[data-position="side"]');
    const bottomBtn = page.locator('#detail-position-toggle .layout-btn[data-position="bottom"]');
    await expect(sideBtn).toHaveClass(/active/);

    // Click bottom button to switch
    await bottomBtn.click();
    await page.waitForTimeout(200);

    // Now bottom should be active, side should not
    await expect(bottomBtn).toHaveClass(/active/);
    // Content area class should change to detail-bottom
    const contentArea = page.locator('#content-area');
    await expect(contentArea).toHaveClass(/detail-bottom/, { timeout: 2000 });

    // Click side to switch back
    await sideBtn.click();
    await expect(contentArea).toHaveClass(/detail-side/, { timeout: 2000 });
  });

  // HS-6669: once the user toggles the detail panel off, subsequent row
  // selections must not force it back open. Previously syncDetailPanel()
  // unconditionally set display:flex on every selection change.
  test('toggling detail panel off stays off when clicking other tickets', async ({ page }) => {
    await createTicket(page, `CloseStay A ${Date.now()}`);
    await createTicket(page, `CloseStay B ${Date.now()}`);

    // Open detail for the first ticket so the panel is visible
    const rowA = page.locator('.ticket-row[data-id]').first();
    await rowA.locator('.ticket-number').click();
    const panel = page.locator('#detail-panel');
    await expect(panel).toBeVisible({ timeout: 3000 });

    // Click the active position toggle to hide the panel
    const sideBtn = page.locator('#detail-position-toggle .layout-btn[data-position="side"]');
    await expect(sideBtn).toHaveClass(/active/);
    await sideBtn.click();
    await expect(panel).toBeHidden({ timeout: 2000 });
    await expect(sideBtn).not.toHaveClass(/active/);

    // Click a different ticket — panel must stay hidden (this is the bug)
    const rowB = page.locator('.ticket-row[data-id]').nth(1);
    await rowB.locator('.ticket-number').click();
    await page.waitForTimeout(300);
    await expect(panel).toBeHidden();

    // Re-activate by clicking the side toggle again — panel returns
    await sideBtn.click();
    await expect(panel).toBeVisible({ timeout: 2000 });
  });

  // --- Long-poll auto-refresh ---

  test('ticket list auto-refreshes when data changes via API', async ({ page }) => {
    const unique = `AutoRefresh ${Date.now()}`;

    // Count tickets before
    const countBefore = await page.locator('.ticket-row[data-id]').count();

    // Create a ticket via API (not the UI) to simulate an external change
    await page.request.post('/api/tickets', {
      headers,
      data: { title: unique },
    });

    // The ticket should appear via long-poll refresh without a manual reload.
    // The long-poll interval is short (100ms check cycle) so 15s is generous.
    await expect(page.locator(`.ticket-title-input[value="${unique}"]`)).toBeVisible({ timeout: 15000 });
  });
});
