import { expect, test } from './coverage-fixture.js';

/** Helper: create a ticket via the draft input and wait for it to appear in the list. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

/** Helper: open the detail panel for a ticket by clicking its ticket number. */
async function openDetail(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

test.describe('Detail panel interactions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('open detail panel and verify header shows ticket number and title', async ({ page }) => {
    await createTicket(page, 'Detail header ticket');
    await openDetail(page, 'Detail header ticket');

    await expect(page.locator('#detail-ticket-number')).toContainText('HS-');
    await expect(page.locator('#detail-title')).toHaveValue('Detail header ticket');
  });

  test('edit details textarea, reload, and verify persistence', async ({ page }) => {
    await createTicket(page, 'Detail persist ticket');
    await openDetail(page, 'Detail persist ticket');

    const detailsArea = page.locator('#detail-details');
    await detailsArea.fill('These are the ticket details.');

    // Wait for debounced save
    await page.waitForTimeout(1500);

    // Reload and re-open detail
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openDetail(page, 'Detail persist ticket');

    await expect(page.locator('#detail-details')).toHaveValue('These are the ticket details.');
  });

  test('change category via detail dropdown', async ({ page }) => {
    await createTicket(page, 'Category change ticket');
    await openDetail(page, 'Category change ticket');

    // Click the category dropdown button
    const catBtn = page.locator('#detail-category');
    await catBtn.click();

    // Wait for dropdown menu to appear and click "Bug" item
    const dropdown = page.locator('.dropdown-menu');
    await expect(dropdown).toBeVisible({ timeout: 3000 });
    await dropdown.locator('.dropdown-item').filter({ hasText: 'Bug' }).click();

    // Verify the button updated to show Bug
    await expect(catBtn).toContainText('Bug', { timeout: 5000 });
  });

  test('change priority via detail dropdown', async ({ page }) => {
    await createTicket(page, 'Priority change ticket');
    await openDetail(page, 'Priority change ticket');

    // Click the priority dropdown button
    const priBtn = page.locator('#detail-priority');
    await priBtn.click();

    // Wait for dropdown and click "High"
    const dropdown = page.locator('.dropdown-menu');
    await expect(dropdown).toBeVisible({ timeout: 3000 });
    await dropdown.locator('.dropdown-item').filter({ hasText: 'High' }).first().click();

    // Verify the button updated to show High
    await expect(priBtn).toContainText('High', { timeout: 5000 });
  });

  test('add a tag via tag input', async ({ page }) => {
    await createTicket(page, 'Tag add ticket');
    await openDetail(page, 'Tag add ticket');

    const tagInput = page.locator('#detail-tag-input');
    await tagInput.fill('frontend');
    await tagInput.press('Enter');

    // Verify tag chip appears
    await expect(page.locator('#detail-tags .tag-chip').filter({ hasText: 'Frontend' })).toBeVisible({ timeout: 5000 });
  });

  test('remove a tag by clicking its X button', async ({ page }) => {
    await createTicket(page, 'Tag remove ticket');
    await openDetail(page, 'Tag remove ticket');

    // Add a tag first
    const tagInput = page.locator('#detail-tag-input');
    await tagInput.fill('backend');
    await tagInput.press('Enter');
    await expect(page.locator('#detail-tags .tag-chip').filter({ hasText: 'Backend' })).toBeVisible({ timeout: 5000 });

    // Click the remove button on the tag chip
    await page.locator('#detail-tags .tag-chip').filter({ hasText: 'Backend' }).locator('.tag-chip-remove').click();

    // Tag should disappear
    await expect(page.locator('#detail-tags .tag-chip').filter({ hasText: 'Backend' })).toBeHidden({ timeout: 5000 });
  });

  test('add a note via add-note button', async ({ page }) => {
    await createTicket(page, 'Note add ticket');
    await openDetail(page, 'Note add ticket');

    // Click the add note button
    await page.locator('#detail-add-note-btn').click();

    // A note entry should appear in the notes container
    const noteEntry = page.locator('#detail-notes .note-entry').first();
    await expect(noteEntry).toBeVisible({ timeout: 5000 });

    // HS-5051: the new note should immediately enter edit mode (textarea focused
    // for typing) with no default text, not show a "(new note)" placeholder string.
    const textarea = noteEntry.locator('textarea.note-edit-area');
    await expect(textarea).toBeVisible({ timeout: 2000 });
    await expect(textarea).toBeFocused();
    await expect(textarea).toHaveValue('');

    // Type into the focused textarea and blur — the note should save with that text.
    await textarea.fill('Typed into the new note');
    await page.locator('#detail-body').click({ position: { x: 5, y: 5 } });
    await expect(noteEntry.locator('.note-text')).toContainText('Typed into the new note', { timeout: 5000 });
  });

  // HS-7601 — megaphone button on each non-feedback note: visible when the
  // channel feature is enabled, hidden on FEEDBACK NEEDED notes (those are
  // Claude → user, not user → Claude), and surfaces a warning when Claude
  // isn't connected at click time.
  test('megaphone button hidden when channel feature is disabled (HS-7601)', async ({ page, request }) => {
    // Default test config has channel disabled — confirm.
    await createTicket(page, 'Megaphone disabled ticket');
    await openDetail(page, 'Megaphone disabled ticket');
    // Add a note to render an entry.
    await page.locator('#detail-add-note-btn').click();
    const noteEntry = page.locator('#detail-notes .note-entry').first();
    await noteEntry.locator('textarea.note-edit-area').fill('Hello world');
    await page.locator('#detail-body').click({ position: { x: 5, y: 5 } });
    await expect(noteEntry.locator('.note-text')).toContainText('Hello world');
    // Megaphone should NOT be present (channel disabled by default in tests).
    await expect(noteEntry.locator('.note-megaphone-btn')).toHaveCount(0);
    // Cleanup so no test pollution
    void request;
  });

// HS-7600: a second "Add note" pill at the bottom of the notes list so the
  // user doesn't have to scroll back up after reading existing notes. Hidden
  // when the list is empty (the empty-state row reads cleanly without it).
  test('bottom add-note button is hidden on empty list and visible once a note exists, and adds a new note (HS-7600)', async ({ page }) => {
    await createTicket(page, 'Bottom add note ticket');
    await openDetail(page, 'Bottom add note ticket');

    // Empty notes list — the bottom pill is NOT rendered, only the
    // notes-empty row.
    await expect(page.locator('#detail-notes .notes-empty')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.detail-add-note-bottom-btn')).toHaveCount(0);

    // Add a first note via the header button so the list is non-empty.
    await page.locator('#detail-add-note-btn').click();
    const firstNote = page.locator('#detail-notes .note-entry').first();
    await firstNote.locator('textarea.note-edit-area').fill('First note');
    await page.locator('#detail-body').click({ position: { x: 5, y: 5 } });
    await expect(firstNote.locator('.note-text')).toContainText('First note', { timeout: 5000 });

    // Bottom add-note pill is now visible.
    const bottomBtn = page.locator('.detail-add-note-bottom-btn');
    await expect(bottomBtn).toBeVisible();
    await expect(bottomBtn).toContainText('Add note');

    // Click it — a second note appears in edit mode (same flow as the header
    // button, since the bottom one forwards click to it).
    await bottomBtn.click();
    const noteEntries = page.locator('#detail-notes .note-entry');
    await expect(noteEntries).toHaveCount(2);
    await expect(noteEntries.nth(1).locator('textarea.note-edit-area')).toBeFocused();
  });

  test('empty note shows placeholder when unfocused', async ({ page }) => {
    await createTicket(page, 'Empty note ticket');
    await openDetail(page, 'Empty note ticket');

    // Add a new note but don't type anything; blur immediately.
    await page.locator('#detail-add-note-btn').click();
    const noteEntry = page.locator('#detail-notes .note-entry').first();
    await expect(noteEntry.locator('textarea.note-edit-area')).toBeFocused();
    await page.locator('#detail-body').click({ position: { x: 5, y: 5 } });

    // The note should still exist and show placeholder text in its unfocused state.
    await expect(noteEntry).toHaveClass(/note-empty/, { timeout: 3000 });
    await expect(noteEntry.locator('.note-placeholder')).toBeVisible();
  });

  test('upload file attachment via file input', async ({ page }) => {
    await createTicket(page, 'Attachment ticket');
    await openDetail(page, 'Attachment ticket');

    // Use setInputFiles on the hidden file input
    const fileInput = page.locator('#detail-file-input');
    await fileInput.setInputFiles({
      name: 'test-file.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Hello, attachment!'),
    });

    // Verify the attachment appears
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'test-file.txt' })).toBeVisible({ timeout: 5000 });
  });

  test('close detail panel with Escape key', async ({ page }) => {
    await createTicket(page, 'Escape close ticket');
    await openDetail(page, 'Escape close ticket');

    await expect(page.locator('#detail-header')).toBeVisible();

    // Press Escape to close — click body first to ensure focus is not in an input
    await page.locator('#detail-body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');

    // Detail header should be hidden, placeholder should show
    await expect(page.locator('#detail-header')).toBeHidden({ timeout: 5000 });
    await expect(page.locator('#detail-placeholder')).toBeVisible();
  });

  test('arrow keys navigate between attachments without switching tickets', async ({ page, request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': projects[0]?.secret ?? '' };

    // Create two tickets so arrow keys could switch between them
    await createTicket(page, 'Attach nav ticket A');
    await createTicket(page, 'Attach nav ticket B');
    await openDetail(page, 'Attach nav ticket A');

    // Upload two attachments
    const fileInput = page.locator('#detail-file-input');
    await fileInput.setInputFiles({
      name: 'file-one.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('First file'),
    });
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'file-one.txt' })).toBeVisible({ timeout: 5000 });

    await fileInput.setInputFiles({
      name: 'file-two.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Second file'),
    });
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'file-two.txt' })).toBeVisible({ timeout: 5000 });

    // Click the first attachment to select and focus it
    const firstAtt = page.locator('#detail-attachments .attachment-item').first();
    await firstAtt.click();
    await expect(firstAtt).toHaveClass(/selected/, { timeout: 3000 });

    // Press ArrowDown — should select second attachment, not switch tickets
    await page.keyboard.press('ArrowDown');

    const secondAtt = page.locator('#detail-attachments .attachment-item').nth(1);
    await expect(secondAtt).toHaveClass(/selected/, { timeout: 3000 });
    await expect(firstAtt).not.toHaveClass(/selected/);

    // Detail panel should still show ticket A (not switched to B)
    await expect(page.locator('#detail-title')).toHaveValue('Attach nav ticket A');

    // Press ArrowUp — should go back to first attachment
    await page.keyboard.press('ArrowUp');
    await expect(firstAtt).toHaveClass(/selected/, { timeout: 3000 });
    await expect(secondAtt).not.toHaveClass(/selected/);
  });

  test('switch selection: click a different ticket updates detail panel', async ({ page }) => {
    await createTicket(page, 'Switch ticket A');
    await createTicket(page, 'Switch ticket B');

    // Open detail for ticket A
    await openDetail(page, 'Switch ticket A');
    await expect(page.locator('#detail-title')).toHaveValue('Switch ticket A');

    // Click ticket B's number to switch
    const rowB = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Switch ticket B"]') });
    await rowB.locator('.ticket-number').click();

    // Detail panel should now show ticket B
    await expect(page.locator('#detail-title')).toHaveValue('Switch ticket B', { timeout: 5000 });
  });
});
