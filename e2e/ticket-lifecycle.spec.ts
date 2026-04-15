/**
 * HS-5628: Full ticket lifecycle — create through archive.
 * Tests the complete user workflow: create → edit → categorize → notes → complete → archive.
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

async function selectTicket(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

test.describe('Full ticket lifecycle (HS-5628)', () => {
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

  test('create → edit title → edit details → change category → change priority', async ({ page }) => {
    const suffix = Date.now();
    const title = `Lifecycle test ${suffix}`;
    const editedTitle = `Lifecycle test ${suffix} (edited)`;
    await createTicket(page, title);
    await selectTicket(page, title);

    // Edit title in detail panel
    const detailTitle = page.locator('#detail-title');
    await detailTitle.fill(editedTitle);
    await page.waitForTimeout(500);

    // Edit details
    const detailDetails = page.locator('#detail-details');
    await detailDetails.fill('This is the description');
    await page.waitForTimeout(500);

    // Change category via detail dropdown
    await page.locator('#detail-category').click();
    await page.locator('.dropdown-menu .dropdown-item').first().click();
    await page.waitForTimeout(300);

    // Change priority via detail dropdown
    await page.locator('#detail-priority').click();
    const priorityItems = page.locator('.dropdown-menu .dropdown-item');
    await priorityItems.nth(1).click();
    await page.waitForTimeout(300);

    // Verify the title was saved by reading it back
    await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${editedTitle}"]`)).toBeVisible({ timeout: 5000 });
  });

  test('add note → edit note → delete note via context menu', async ({ page, request }) => {
    const suffix = Date.now();
    const noteTitle = `Note lifecycle ${suffix}`;
    // Create ticket via API for a clean state
    const res = await request.post('/api/tickets', { headers, data: { title: noteTitle } });
    const ticket = await res.json() as { id: number };
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Add a note via API (notes-bulk replaces all notes)
    const notes = JSON.stringify([{ id: 'n_test1', text: 'First note', created_at: new Date().toISOString() }]);
    await request.put(`/api/tickets/${ticket.id}/notes-bulk`, {
      headers, data: { notes },
    });

    // Reload to pick up the new note, then select the ticket
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await selectTicket(page, noteTitle);
    await expect(page.locator('.note-entry .note-text')).toContainText('First note', { timeout: 5000 });

    // Click on the note to edit it
    await page.locator('.note-entry').first().click();
    const noteEditor = page.locator('.note-edit-area');
    await expect(noteEditor).toBeVisible({ timeout: 3000 });
    await noteEditor.fill('Edited note text');
    await noteEditor.press('Meta+Enter');
    await page.waitForTimeout(500);

    // Verify the edited text appears
    await expect(page.locator('.note-entry .note-text')).toContainText('Edited note text', { timeout: 5000 });

    // Delete note via right-click context menu
    await page.locator('.note-entry').first().click({ button: 'right' });
    await page.waitForTimeout(100);
    await page.locator('.note-context-menu .context-menu-item').click();
    await page.waitForTimeout(500);

    // Note should be gone — "No notes added" shown
    await expect(page.locator('.notes-empty')).toBeVisible({ timeout: 5000 });
  });

  test('mark completed → verified → archive via context menu', async ({ page, request }) => {
    const suffix = Date.now();
    const statusTitle = `Status lifecycle ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title: statusTitle } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${statusTitle}"]`) }).first();

    // Cycle status: not_started → started → completed
    const statusBtn = row.locator('.ticket-status-btn');
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 3000 });
    await statusBtn.click();
    await expect(statusBtn).toHaveAttribute('title', 'completed', { timeout: 3000 });

    // Right-click → Verified (top-level item when ticket is completed)
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    // Use first() — "Verified" appears both as a top-level action and in the Status submenu
    const verifiedItem = page.locator('.context-menu-item').filter({ hasText: 'Verified' }).first();
    await verifiedItem.click();
    await page.waitForTimeout(500);

    // Right-click → Archive
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(100);
    const archiveItem = page.locator('.context-menu-item').filter({ hasText: 'Archive' });
    await archiveItem.click();
    await page.waitForTimeout(500);

    // Ticket should no longer be visible in the active list
    await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${statusTitle}"]`)).toBeHidden({ timeout: 5000 });
  });
});
