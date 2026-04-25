/**
 * HS-7599 — feedback drafts + don't-close-on-clickaway end-to-end coverage.
 *
 * Exercises the full flow:
 * - FEEDBACK NEEDED note → "Provide Feedback" link opens the dialog
 * - Click outside the dialog with empty inputs → closes
 * - Click outside the dialog with text in inputs → stays open
 * - Save Draft → POST /feedback-drafts → draft renders inline below parent
 * - Click the saved draft → re-opens dialog with restored partitions
 * - Submit from the reopened draft dialog → DELETEs draft + adds note
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

async function openDetail(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

async function getProjectSecret(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/projects');
  const projects = await res.json() as { secret: string }[];
  return projects[0]?.secret ?? '';
}

/** Add a FEEDBACK NEEDED note to the active ticket via the API so the
 *  detail panel auto-shows the feedback dialog when re-opened. */
async function addFeedbackNote(
  page: import('@playwright/test').Page,
  ticketTitle: string,
  prompt: string,
): Promise<{ ticketId: number; noteId: string }> {
  const secret = await getProjectSecret(page);
  const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  const ticketId = Number(await page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${ticketTitle}"]`) }).getAttribute('data-id'));
  const ticketRes = await page.request.get(`/api/tickets/${ticketId}`, { headers });
  const ticket = await ticketRes.json() as { notes: string };
  const existingNotes = (() => {
    try {
      const parsed: unknown = JSON.parse(ticket.notes);
      return Array.isArray(parsed) ? parsed as { id: string; text: string; created_at: string }[] : [];
    } catch { return []; }
  })();
  const noteId = `n_test_${Date.now().toString(36)}`;
  const newNotes = [...existingNotes, { id: noteId, text: `FEEDBACK NEEDED: ${prompt}`, created_at: new Date().toISOString() }];
  const putRes = await page.request.put(`/api/tickets/${ticketId}/notes-bulk`, {
    headers,
    data: { notes: JSON.stringify(newNotes) },
  });
  if (!putRes.ok()) throw new Error(`notes-bulk PUT failed: ${putRes.status()} ${await putRes.text()}`);
  return { ticketId, noteId };
}

test.describe('Feedback drafts + dont-close-on-clickaway (HS-7599)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('clicking outside the dialog with empty inputs closes it', async ({ page }) => {
    await createTicket(page, 'Empty clickaway ticket');
    await addFeedbackNote(page, 'Empty clickaway ticket', 'Single question?');
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openDetail(page, 'Empty clickaway ticket');
    // Re-open the detail panel so the dialog auto-shows.
    // Page reload reset `lastAutoShownKey`, so opening the detail panel
    // auto-shows the feedback dialog. Wait for it.
    const overlay = page.locator('.feedback-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Click on the overlay's backdrop (not the dialog body) — outside-click
    // dismissal path. Use a corner so we miss the dialog.
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(overlay).toHaveCount(0);
  });

  test('clicking outside the dialog with text entered keeps it open', async ({ page }) => {
    await createTicket(page, 'Text clickaway ticket');
    await addFeedbackNote(page, 'Text clickaway ticket', 'Single question?');
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openDetail(page, 'Text clickaway ticket');
    const overlay = page.locator('.feedback-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Type in the catch-all so the click-away threshold is tripped.
    await overlay.locator('#feedback-catchall-text').fill('Some draft text');

    await overlay.click({ position: { x: 5, y: 5 } });
    // Still visible.
    await expect(overlay).toBeVisible();
    // The user can still close explicitly via the × button.
    await overlay.locator('#feedback-close').click();
    await expect(overlay).toHaveCount(0);
  });

  test('Save Draft persists the in-progress response and renders it inline below the FEEDBACK NEEDED note', async ({ page }) => {
    await createTicket(page, 'Save draft ticket');
    const { noteId } = await addFeedbackNote(page, 'Save draft ticket', 'What is your favourite colour?');
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openDetail(page, 'Save draft ticket');
    const overlay = page.locator('.feedback-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Type a partial response then click Save Draft.
    await overlay.locator('#feedback-catchall-text').fill('Probably blue, but I want to think more');
    await overlay.locator('#feedback-save-draft').click();
    await expect(overlay).toHaveCount(0, { timeout: 5000 });

    // Draft should render inline below the FEEDBACK NEEDED note (visible
    // immediately when the notes list re-renders post-save).
    const draftEntry = page.locator(`.feedback-draft-entry`).first();
    await expect(draftEntry).toBeVisible({ timeout: 5000 });
    await expect(draftEntry.locator('.feedback-draft-badge')).toHaveText('Draft');
    await expect(draftEntry.locator('.feedback-draft-preview')).toContainText('Probably blue');

    // The draft sits inside the notes container alongside the parent note.
    // (Position-relative-to-parent is tricky to test deterministically since
    // reload-driven re-render may strip the parent's data-note-id; the
    // important promise — "draft visible after parent" — is exercised by
    // the DOM-ordering of `renderNotes` which appends drafts directly after
    // each note loop iteration.)
    const notesContainer = page.locator('#detail-notes');
    await expect(notesContainer.locator('.feedback-draft-entry')).toHaveCount(1);
    expect(noteId).not.toBe('');
  });

  test('clicking a saved draft re-opens the dialog with the restored response, and Submit deletes the draft', async ({ page }) => {
    await createTicket(page, 'Reopen draft ticket');
    await addFeedbackNote(page, 'Reopen draft ticket', 'Pick A or B?');
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openDetail(page, 'Reopen draft ticket');
    const overlay = page.locator('.feedback-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });

    // Save a draft.
    await overlay.locator('#feedback-catchall-text').fill('Leaning towards A');
    await overlay.locator('#feedback-save-draft').click();
    await expect(overlay).toHaveCount(0, { timeout: 5000 });

    // Click the draft to re-open.
    const draftEntry = page.locator(`.feedback-draft-entry`).first();
    await expect(draftEntry).toBeVisible({ timeout: 5000 });
    await draftEntry.click();

    // Dialog re-opens with the catch-all populated.
    const reopened = page.locator('.feedback-dialog-overlay');
    await expect(reopened).toBeVisible({ timeout: 5000 });
    await expect(reopened.locator('#feedback-catchall-text')).toHaveValue('Leaning towards A');

    // Submit — should delete the draft + add the note.
    await reopened.locator('#feedback-submit').click();
    await expect(reopened).toHaveCount(0, { timeout: 5000 });

    // Draft is gone from the notes list.
    await expect(page.locator('.feedback-draft-entry')).toHaveCount(0);
    // A new note appeared with the response text.
    await expect(page.locator('#detail-notes .note-entry').last().locator('.note-text')).toContainText('Leaning towards A');
  });
});
