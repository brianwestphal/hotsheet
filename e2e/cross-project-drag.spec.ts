/**
 * HS-8740 — E2E for cross-project ticket drag (HS-8663).
 *
 * The unit tests (`ticketTransfer.test.ts`, `projectTabsTicketDrop.test.ts`)
 * cover the transfer choreography and the drop wiring; this spec drives the
 * real browser flow end-to-end against TWO genuinely-registered projects so a
 * ticket dragged from A's list onto B's tab actually lands in B's database.
 *
 * Playwright can't perform a real OS drag, so the drag is synthesized: a
 * `dragstart` on the ticket row (which publishes the dragged id) followed by
 * `dragover` + `drop` on the destination project tab — the same technique
 * `e2e/ticket-row-drop.spec.ts` uses for file drops. The Option/Alt-to-move
 * modifier is passed via the drop event's `altKey`.
 *
 * A second project is registered against a throwaway temp dir for the test and
 * unregistered (and its temp dir removed) afterward so the shared e2e server is
 * left as it was found.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './coverage-fixture.js';

interface RegisteredProject { name: string; dataDir: string; secret: string }

/** Create a ticket via the draft input and leave it selected (no Escape). */
async function createTicket(page: import('@playwright/test').Page, title: string): Promise<void> {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  await expect(page.locator(`.ticket-row[data-id] .ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 5000 });
}

/** Synthesize a ticket drag from the row carrying `title` onto the project tab
 *  with `tabSecret`. `move` sets the Alt modifier (copy is the default). */
async function dragTicketOntoTab(page: import('@playwright/test').Page, title: string, tabSecret: string, move: boolean): Promise<void> {
  await page.evaluate(
    ({ title, tabSecret, move }) => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('.ticket-row[data-id]'));
      const row = rows.find(r => r.querySelector<HTMLInputElement>('.ticket-title-input')?.value === title);
      const tab = document.querySelector<HTMLElement>(`.project-tab[data-secret="${tabSecret}"]`);
      if (!row || !tab) throw new Error(`drag setup: row(${String(!!row)}) tab(${String(!!tab)}) not found`);
      const dt = new DataTransfer();
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      tab.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, altKey: move }));
      tab.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, altKey: move }));
    },
    { title, tabSecret, move },
  );
}

test.describe('Cross-project ticket drag (HS-8740 / HS-8663)', () => {
  let projB: RegisteredProject | null = null;

  test.beforeEach(async ({ request }) => {
    // Register a real second project against a throwaway temp dir.
    const dataDir = join(mkdtempSync(join(tmpdir(), 'hs-8740-')), '.hotsheet');
    const res = await request.post('/api/projects/register', { data: { dataDir } });
    expect(res.ok(), 'second project should register').toBeTruthy();
    projB = await res.json() as RegisteredProject;
  });

  test.afterEach(async ({ request }) => {
    // Unregister the temp project so the shared server is left as found. We
    // deliberately do NOT `rm` its data dir: the server still holds the PGLite
    // handle, and deleting the files out from under it panics the next
    // CHECKPOINT. The tiny temp dir under the OS tmpdir is reaped by the OS.
    if (projB) await request.delete(`/api/projects/${projB.secret}`).catch(() => undefined);
    projB = null;
  });

  test('copy: dragging a ticket onto another project tab copies it there, original stays', async ({ page }) => {
    const b = projB!;
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Both project tabs should be present (always-tabbed strip, HS-8664).
    await expect(page.locator(`.project-tab[data-secret="${b.secret}"]`)).toBeVisible({ timeout: 5000 });
    const aSecret = await page.evaluate(() => document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? '');
    expect(aSecret).not.toBe('');

    await createTicket(page, 'CopyMe');
    await dragTicketOntoTab(page, 'CopyMe', b.secret, false);

    // Confirmation toast, then the copy is visible in project B.
    await expect(page.locator('.hs-toast')).toContainText('Copied 1 ticket', { timeout: 5000 });
    await page.locator(`.project-tab[data-secret="${b.secret}"]`).click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="CopyMe"]')).toBeVisible({ timeout: 5000 });

    // Original still present back in project A.
    await page.locator(`.project-tab[data-secret="${aSecret}"]`).click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="CopyMe"]')).toBeVisible({ timeout: 5000 });
  });

  test('move: Alt-dragging removes the original from the source and lands it in the target', async ({ page }) => {
    const b = projB!;
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`.project-tab[data-secret="${b.secret}"]`)).toBeVisible({ timeout: 5000 });

    await createTicket(page, 'MoveMe');
    await dragTicketOntoTab(page, 'MoveMe', b.secret, true);

    await expect(page.locator('.hs-toast')).toContainText('Moved 1 ticket', { timeout: 5000 });
    // Gone from the source project (soft-deleted → not in the open list)...
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="MoveMe"]')).toHaveCount(0, { timeout: 5000 });
    // ...and present in the target project.
    await page.locator(`.project-tab[data-secret="${b.secret}"]`).click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="MoveMe"]')).toBeVisible({ timeout: 5000 });
  });

  test('copy carries the ticket\'s attachments to the target project (HS-8739)', async ({ page }) => {
    const b = projB!;
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`.project-tab[data-secret="${b.secret}"]`)).toBeVisible({ timeout: 5000 });

    await createTicket(page, 'WithFile');
    // Attach a file by dropping it directly on the ticket's row, waiting for the
    // upload POST to land so the attachment exists before we transfer. We do NOT
    // open the detail panel here: leaving an active ticket open while switching
    // to project B would make the panel re-fetch that (project-A) id in B's
    // context and 404 — verifying on the B side below is enough.
    const rowId = await page.locator('.ticket-row[data-id]')
      .filter({ has: page.locator('.ticket-title-input[value="WithFile"]') }).getAttribute('data-id');
    expect(rowId).not.toBeNull();
    await Promise.all([
      page.waitForResponse(r => /\/tickets\/\d+\/attachments(\?|$)/.test(r.url()) && r.request().method() === 'POST'),
      page.evaluate((id) => {
        const row = document.querySelector(`.ticket-row[data-id="${id}"]`);
        if (!row) throw new Error('row not found');
        const dt = new DataTransfer();
        dt.items.add(new File(['carry me'], 'carried.txt', { type: 'text/plain' }));
        row.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        row.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }, rowId!),
    ]);

    // Copy the ticket onto project B.
    await dragTicketOntoTab(page, 'WithFile', b.secret, false);
    await expect(page.locator('.hs-toast')).toContainText('Copied 1 ticket', { timeout: 5000 });

    // In project B the copied ticket carries the attachment. B is a fresh
    // project, so wait for its list to settle to exactly the one copied row
    // before opening it — otherwise the stale project-A rows are momentarily
    // still mounted and a click races onto a ticket id that doesn't exist in B.
    await page.locator(`.project-tab[data-secret="${b.secret}"]`).click();
    await expect(page.locator('.ticket-row[data-id]')).toHaveCount(1, { timeout: 5000 });
    await page.locator('.ticket-row[data-id]').filter({ has: page.locator('.ticket-title-input[value="WithFile"]') }).locator('.ticket-number').click();
    await expect(page.locator('#detail-attachments .attachment-item').filter({ hasText: 'carried.txt' })).toBeVisible({ timeout: 5000 });
  });

  test('no-op: dropping a ticket onto its own source tab does nothing', async ({ page }) => {
    const b = projB!;
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`.project-tab[data-secret="${b.secret}"]`)).toBeVisible({ timeout: 5000 });

    await createTicket(page, 'StayPut');
    // Find the ACTIVE (source) project's tab secret and drop onto it.
    const activeSecret = await page.evaluate(() =>
      document.querySelector<HTMLElement>('.project-tab.active')?.dataset.secret ?? '');
    expect(activeSecret).not.toBe('');
    await dragTicketOntoTab(page, 'StayPut', activeSecret, false);

    // No toast, no duplicate — exactly one StayPut row remains in A.
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="StayPut"]')).toHaveCount(1);
    await page.locator(`.project-tab[data-secret="${b.secret}"]`).click();
    await expect(page.locator('.ticket-row[data-id] .ticket-title-input[value="StayPut"]')).toHaveCount(0, { timeout: 5000 });
  });
});
