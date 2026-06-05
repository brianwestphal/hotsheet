/**
 * HS-8662 — paste files/images from the clipboard to create attachments.
 *
 * Selection drives the target: 1 selected → that ticket; 0 selected → a new
 * "Attachment(s)" ticket (mirrors the dropped-image fallback); 2+ selected →
 * no-op + a toast. Playwright can't drive a real OS clipboard paste, so the
 * test dispatches a synthetic `paste` event whose `clipboardData` carries a
 * `File` — the document-level handler reads `e.clipboardData` and reaches the
 * same `uploadAttachment` path the file input / drop use.
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string): Promise<void> {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
}

/** Dispatch a synthetic `paste` carrying a single `File`. `clipboardData` is
 *  read-only on a constructed ClipboardEvent, so patch it on after building. */
async function simulatePasteFile(page: import('@playwright/test').Page, fileName: string, content: string): Promise<void> {
  await page.evaluate(
    ({ fileName, content }) => {
      const file = new File([content], fileName, { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const ev = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'clipboardData', { configurable: true, value: dt });
      document.body.dispatchEvent(ev);
    },
    { fileName, content },
  );
}

test.describe('Paste-to-attachment (HS-8662)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('0 selected → pastes onto a new "Attachment" ticket', async ({ page }) => {
    // Nothing selected, focus blurred out of the draft input.
    await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');

    await simulatePasteFile(page, 'pasted.txt', 'hello paste');

    const newRow = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Attachment"]') });
    await expect(newRow).toBeVisible({ timeout: 5000 });
    // HS-8742 — the new ticket is auto-selected and its detail panel auto-opens
    // (no manual click), showing the attachment so the user can retitle it.
    await expect(newRow).toHaveClass(/selected/, { timeout: 5000 });
    await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'pasted.txt' })).toBeVisible({ timeout: 5000 });
  });

  test('1 selected → pastes onto that ticket', async ({ page }) => {
    await createTicket(page, 'Target ticket');
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Target ticket"]') });
    // Select exactly one (checkbox), leaving focus out of any text input.
    await row.locator('.ticket-checkbox').click();
    await expect(row).toHaveClass(/selected/);

    await simulatePasteFile(page, 'onto-target.txt', 'body');

    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'onto-target.txt' })).toBeVisible({ timeout: 5000 });
    // No stray "Attachment" ticket was created.
    await expect(page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Attachment"]') })).toHaveCount(0);
  });

  test('2+ selected → no-op with a toast, no new ticket', async ({ page }) => {
    await createTicket(page, 'One');
    await createTicket(page, 'Two');
    const one = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="One"]') });
    const two = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Two"]') });
    await one.locator('.ticket-checkbox').click();
    await two.locator('.ticket-checkbox').click();
    await expect(page.locator('.ticket-row.selected')).toHaveCount(2);

    await simulatePasteFile(page, 'ignored.txt', 'nope');

    await expect(page.locator('.hs-toast')).toContainText("multiple tickets", { timeout: 5000 });
    // No "Attachment" ticket created.
    await expect(page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Attachment"]') })).toHaveCount(0);
  });
});
