/**
 * HS-9465 — dropping a file with no readable bytes must fail cleanly.
 *
 * On macOS a fresh screen capture can be dragged from the corner preview before it
 * has been written to disk. What the drag carries is a promise of a file, so the
 * upload truncated mid-flight, the server answered `400 Malformed upload body`, and
 * the async drop listener (which had no `catch`) turned that into the generic
 * HS-9455 "Something went wrong" crash popup.
 *
 * Playwright can't produce a real promised file — but a zero-byte `File` takes the
 * same client path, so this drives the actual UI end to end: real drop event, real
 * handler, real popup. What it pins is the user-visible contract: a named,
 * actionable message instead of a crash, and no ticket left behind.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/** Dispatch a real `drop` on the ticket list carrying `files`. */
async function simulateDrop(
  page: Page,
  files: { name: string; content: string }[],
): Promise<void> {
  await page.evaluate((specs) => {
    const dt = new DataTransfer();
    for (const s of specs) dt.items.add(new File([s.content], s.name, { type: 'image/png' }));
    const target = document.querySelector('#ticket-list') ?? document.body;
    const ev = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { configurable: true, value: dt });
    Object.defineProperty(ev, 'target', { configurable: true, value: target });
    target.dispatchEvent(ev);
  }, files);
}

test.describe('Dropping a file with no readable bytes (HS-9465)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Escape');
  });

  test('names the file and what to do, instead of the generic crash popup', async ({ page }) => {
    await simulateDrop(page, [{ name: 'Screenshot 2026-07-29 at 7.58.03 AM.png', content: '' }]);

    const popup = page.locator('.error-popup, #error-popup').first();
    await expect(popup).toBeVisible({ timeout: 5000 });
    // The old failure: title "Something went wrong", body "Error: Malformed upload
    // body (unhandled promise rejection)" — no filename, nothing to act on.
    await expect(popup).not.toContainText('Something went wrong');
    await expect(popup).not.toContainText('Malformed upload body');
    await expect(popup).not.toContainText('unhandled promise rejection');
    await expect(popup).toContainText('Screenshot 2026-07-29 at 7.58.03 AM.png');
    await expect(popup).toContainText('⌘V');
  });

  test('does not leave an empty "Attachment" ticket behind', async ({ page }) => {
    // The readability check runs BEFORE `resolveDropTicketId`, so a drop that
    // can't produce an attachment must not create the ticket that would have
    // held it — otherwise every failed drag leaves litter to clean up.
    await simulateDrop(page, [{ name: 'unsaved.png', content: '' }]);
    await expect(page.locator('.error-popup, #error-popup').first()).toBeVisible({ timeout: 5000 });

    const attachmentTickets = page.locator('.ticket-row[data-id]')
      .filter({ has: page.locator('.ticket-title-input[value="Attachment"]') });
    await expect(attachmentTickets).toHaveCount(0);
  });

  test('a mixed drop still attaches the readable file', async ({ page }) => {
    await simulateDrop(page, [
      { name: 'saved.png', content: 'real-bytes' },
      { name: 'unsaved.png', content: '' },
    ]);

    const newRow = page.locator('.ticket-row[data-id]')
      .filter({ has: page.locator('.ticket-title-input[value="Attachment"]') });
    await expect(newRow).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'saved.png' }))
      .toBeVisible({ timeout: 8000 });
    // ...and still says what it skipped.
    const popup = page.locator('.error-popup, #error-popup').first();
    await expect(popup).toBeVisible({ timeout: 5000 });
    await expect(popup).toContainText('unsaved.png');
  });
});
