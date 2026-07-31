/**
 * HS-9408 — clicking the ticket number in the detail panel copies it. Clicking it
 * AGAIN inside the 1 s confirmation window used to copy the literal string
 * "Copied!", because the handler wrote the confirmation into the element and then
 * read the number back out of that same element on the next click.
 *
 * The fix makes the confirmation a CSS overlay (`.is-copied` → `::after`) so the
 * element's text is always the real ticket number. This spec drives the real UI
 * and records every `navigator.clipboard.writeText` argument.
 *
 * The clipboard API is stubbed (same approach as `terminal-osc133-copy-output.spec.ts`)
 * so the assertion is deterministic and needs no browser clipboard permission.
 *
 * The OTHER failure mode the fix closes — a pending restore clobbering the NEXT
 * ticket's number after a mid-flash ticket switch — is covered deterministically in
 * `src/client/detailBindings/panel.test.ts` instead. An e2e version of it proved
 * flaky for reasons unrelated to the bug (it depends on ticket-list selection
 * timing that shifts with how many rows the shared server has accumulated), and a
 * test that is green for the wrong reason is worse than no test.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';


/** Record every clipboard write into `window.__copied` before the app loads. */
async function stubClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t: string) => { w.__copied.push(t); return Promise.resolve(); } },
    });
  });
}

/** The e2e data dir persists across runs, so fixed titles accumulate duplicate
 *  rows and a title-based locator starts matching a STALE ticket (which is how
 *  this spec first went red for reasons unrelated to the bug). Suffix every title
 *  so each run addresses its own tickets. */
const RUN = String(Date.now()).slice(-6);
const title = (name: string): string => `${name} ${RUN}`;

const copied = async (page: Page): Promise<string[]> =>
  await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test.describe('Detail-panel ticket-number copy (HS-9408)', () => {
  test('clicking twice in a row copies the ticket number both times', async ({ page }) => {
    await stubClipboard(page);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Create a ticket and select it so the detail panel is populated.
    const draft = page.locator('.draft-input');
    const target = title('copy-target ticket');
    await draft.fill(target);
    await draft.press('Enter');
    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${target}"]`) });
    await expect(row).toBeVisible({ timeout: 5000 });
    // Selecting via the row's ticket number is the established pattern
    // (e2e/detail.spec.ts) — clicking the title input focuses it for editing.
    await row.locator('.ticket-number').click();

    const numEl = page.locator('#detail-ticket-number');
    await expect(numEl).toBeVisible({ timeout: 5000 });
    const ticketNumber = (await numEl.textContent())?.trim() ?? '';
    expect(ticketNumber).toMatch(/^HS-\d+$/);

    // First click — copies, and flashes via the overlay class.
    await numEl.click();
    await expect(numEl).toHaveClass(/is-copied/);
    // The label itself must NOT have been rewritten.
    expect((await numEl.textContent())?.trim()).toBe(ticketNumber);

    // Second click while the flash is still up — the reported bug.
    await numEl.click();
    const writes = await copied(page);
    expect(writes).toHaveLength(2);
    expect(writes).toEqual([ticketNumber, ticketNumber]);
    expect(writes).not.toContain('Copied!');

    // And the header is intact once the flash expires.
    await expect(numEl).not.toHaveClass(/is-copied/, { timeout: 3000 });
    expect((await numEl.textContent())?.trim()).toBe(ticketNumber);
  });

});
