import { expect, test } from './coverage-fixture.js';

/** Helper: create a ticket via the draft input and wait for it to appear in the list. */
async function createTicket(page: import('@playwright/test').Page, title: string) {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

/** Helper: click on empty space to ensure focus is not in any input. */
async function blurInputs(page: import('@playwright/test').Page) {
  await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });
}

/** Helper: select a ticket by clicking its ticket number. */
async function selectTicket(page: import('@playwright/test').Page, title: string) {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(row).toHaveClass(/selected/, { timeout: 3000 });
}

test.describe('Keyboard shortcuts', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('N key focuses draft input when not in an input', async ({ page }) => {
    // Create a ticket so the list has content and we can click away from inputs
    await createTicket(page, 'Focus test ticket');
    await blurInputs(page);

    // Verify draft input is NOT focused
    await expect(page.locator('.draft-input')).not.toBeFocused();

    // Press N
    await page.keyboard.press('n');

    // Draft input should now be focused
    await expect(page.locator('.draft-input')).toBeFocused();
  });

  test('Enter in draft input creates a ticket', async ({ page }) => {
    const draft = page.locator('.draft-input');
    await draft.fill('Enter creates ticket');
    await draft.press('Enter');

    // Ticket should appear in the list
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Enter creates ticket"]')).toBeVisible({ timeout: 5000 });
    // Draft input should be cleared
    await expect(draft).toHaveValue('');
  });

  test('Escape clears ticket selection', async ({ page }) => {
    await createTicket(page, 'Escape test ticket');
    await selectTicket(page, 'Escape test ticket');

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Escape test ticket"]') });
    await expect(row).toHaveClass(/selected/);

    // Press Escape
    await page.keyboard.press('Escape');

    // Selection should be cleared
    await expect(row).not.toHaveClass(/selected/, { timeout: 3000 });
  });

  test('Delete/Backspace deletes selected ticket', async ({ page }) => {
    await createTicket(page, 'Delete shortcut ticket');
    await selectTicket(page, 'Delete shortcut ticket');

    // Move focus away from any input
    await blurInputs(page);

    // Re-select after blur (blur may clear selection due to click)
    await selectTicket(page, 'Delete shortcut ticket');
    await blurInputs(page);

    await page.keyboard.press('Backspace');

    // Ticket should disappear
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Delete shortcut ticket"]')).toBeHidden({ timeout: 5000 });
  });

  test('Cmd+D toggles up-next star on selected ticket', async ({ page }) => {
    await createTicket(page, 'Star shortcut ticket');
    await selectTicket(page, 'Star shortcut ticket');

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Star shortcut ticket"]') });
    const star = row.locator('.ticket-star');

    // Initially not active
    await expect(star).not.toHaveClass(/active/);

    // Press Cmd+D to toggle up-next on
    await page.keyboard.press('Meta+d');

    // Star should become active
    await expect(star).toHaveClass(/active/, { timeout: 5000 });

    // Press Cmd+D again to toggle off
    await page.keyboard.press('Meta+d');
    await expect(star).not.toHaveClass(/active/, { timeout: 5000 });
  });

  test('Cmd+Z undoes a deletion', async ({ page }) => {
    await createTicket(page, 'Undo test ticket');

    // Select and delete the ticket
    await selectTicket(page, 'Undo test ticket');
    await blurInputs(page);
    await selectTicket(page, 'Undo test ticket');
    await blurInputs(page);
    await page.keyboard.press('Backspace');

    // Verify it is gone
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Undo test ticket"]')).toBeHidden({ timeout: 5000 });

    // Press Cmd+Z to undo
    await page.keyboard.press('Meta+z');

    // Ticket should reappear
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="Undo test ticket"]')).toBeVisible({ timeout: 5000 });
  });

  test('typing in draft input does not trigger shortcuts', async ({ page }) => {
    const draft = page.locator('.draft-input');
    await draft.focus();

    // Type 'n' — it should be typed into the input, not trigger the N shortcut
    await page.keyboard.type('n');

    // The draft input should contain 'n'
    await expect(draft).toHaveValue('n');
    // And the draft should still be focused (not re-focused by the shortcut)
    await expect(draft).toBeFocused();
  });
});
