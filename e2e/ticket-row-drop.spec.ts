/**
 * HS-7492 — drop an attachment onto a ticket row.
 *
 * Previously, dropping a file onto the list attached it to the single
 * selected ticket (or created a new one if 0 / 2+ were selected). Users can
 * now drop a file directly onto a specific ticket row / column card and the
 * attachment lands on THAT ticket regardless of selection state.
 *
 * Playwright can't simulate a real OS-level file drag, so the test
 * dispatches a synthetic `drop` event with a `DataTransfer` whose `.files`
 * is a `DataTransferItemList` containing a `File`. The document-level drop
 * handler in `src/client/app.tsx` reads `e.dataTransfer?.files`, reaches
 * the same `apiUpload` path that the real file input uses, and the
 * attachment shows up in the detail panel.
 */
import { expect, test } from './coverage-fixture.js';

async function createTicket(page: import('@playwright/test').Page, title: string): Promise<void> {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

async function openDetail(page: import('@playwright/test').Page, title: string): Promise<void> {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

/**
 * Dispatch a synthetic `drop` event (with `dragover` first so the app's
 * document-level dragover handler can run) carrying a single `File` onto
 * the given selector. Mirrors the shape of a real OS file drop.
 */
async function simulateFileDrop(
  page: import('@playwright/test').Page,
  selector: string,
  fileName: string,
  content: string,
): Promise<void> {
  await page.evaluate(
    ({ selector, fileName, content }) => {
      const el = document.querySelector(selector);
      if (el === null) throw new Error(`simulateFileDrop: no element for ${selector}`);
      const file = new File([content], fileName, { type: 'text/plain' });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { selector, fileName, content },
  );
}

test.describe('Ticket row file-drop attachment (HS-7492)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('drops file on a row and attaches to THAT ticket, ignoring selection', async ({ page }) => {
    // Two tickets — selection is set to the WRONG one so the test proves
    // the drop target wins over the selection.
    await createTicket(page, 'Alpha ticket');
    await createTicket(page, 'Beta ticket');

    const alphaRow = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Alpha ticket"]') });
    const betaRow = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Beta ticket"]') });

    // Select Beta by clicking its checkbox.
    await betaRow.locator('.ticket-checkbox').click();
    await expect(betaRow).toHaveClass(/selected/);

    // Dispatch the drop on Alpha's row — Alpha should receive the attachment
    // even though Beta is the current selection.
    const alphaId = await alphaRow.getAttribute('data-id');
    expect(alphaId).not.toBeNull();
    await simulateFileDrop(page, `.ticket-row[data-id="${alphaId!}"]`, 'dropped.txt', 'hello drop');

    // Open Alpha's detail panel and assert the attachment shows up.
    await openDetail(page, 'Alpha ticket');
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'dropped.txt' })).toBeVisible({ timeout: 5000 });

    // Open Beta's detail panel and assert NO attachment was added.
    await openDetail(page, 'Beta ticket');
    await expect(page.locator('#detail-attachments .attachment-item')).toHaveCount(0);
  });

  test('drop outside any row still creates a new ticket via the fallback path', async ({ page }) => {
    // Regression: the existing fallback (no row under the drop, no
    // selection) creates a new "Attachment" ticket with the file attached.
    // This test guards the fallback path so the HS-7492 addition does not
    // silently break it.
    await simulateFileDrop(page, '#ticket-list', 'fallback.txt', 'fallback body');

    const fallbackRow = page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="Attachment"]') });
    await expect(fallbackRow).toBeVisible({ timeout: 5000 });
    await fallbackRow.locator('.ticket-number').click();
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'fallback.txt' })).toBeVisible({ timeout: 5000 });
  });
});
