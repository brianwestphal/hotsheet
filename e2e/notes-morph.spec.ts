import { expect, test } from './coverage-fixture.js';

/**
 * HS-8651 — `renderNotes` commits via `morph()` instead of `replaceChildren`.
 * The user-visible win is that a poll-driven detail re-render (the detail panel
 * re-fetches + re-renders its notes on every poll tick via
 * `refreshDetail` → `loadDetail` → `renderNotes`) reconciles the notes IN PLACE
 * — existing note nodes are reused, so scroll position survives instead of
 * snapping back to the top on every tick.
 *
 * This needs a real browser: scroll position + DOM-node identity across a
 * live poll cycle aren't observable in the happy-dom unit tests (which assert
 * the reconcile logic directly). See `noteRenderer.test.tsx` for the unit-level
 * morph coverage (in-place reuse, keyed add, in-progress-edit preservation,
 * committed-save rebuild).
 */

async function createTicket(page: import('@playwright/test').Page, title: string): Promise<number> {
  const draft = page.locator('.draft-input');
  await draft.fill(title);
  await draft.press('Enter');
  const row = page.locator(`.ticket-row[data-id]`).filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await expect(row).toBeVisible({ timeout: 5000 });
  return Number(await row.getAttribute('data-id'));
}

async function openDetail(page: import('@playwright/test').Page, title: string): Promise<void> {
  const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) });
  await row.locator('.ticket-number').click();
  await expect(page.locator('#detail-header')).toBeVisible({ timeout: 5000 });
}

async function getSecret(page: import('@playwright/test').Page): Promise<string> {
  const res = await page.request.get('/api/projects');
  const projects = await res.json() as { secret: string }[];
  return projects[0]?.secret ?? '';
}

test.describe('Notes morph reconciliation (HS-8651)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('a poll-driven notes re-render reuses existing note nodes in place + preserves scroll', async ({ page }) => {
    const ticketId = await createTicket(page, 'Morph notes ticket');
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': await getSecret(page) };

    // Seed enough notes to make the detail body scrollable.
    const baseNotes = Array.from({ length: 20 }, (_, i) => ({
      id: `m${String(i)}`,
      text: `Seeded note number ${String(i)} with a sentence of text so the notes list is tall enough to scroll.`,
      created_at: new Date(Date.now() + i * 1000).toISOString(),
    }));
    const seedRes = await page.request.put(`/api/tickets/${String(ticketId)}/notes-bulk`, {
      headers, data: { notes: JSON.stringify(baseNotes) },
    });
    expect(seedRes.ok()).toBe(true);

    await openDetail(page, 'Morph notes ticket');
    const m5 = page.locator('#detail-notes .note-entry[data-note-id="m5"]');
    await expect(m5).toBeVisible({ timeout: 5000 });

    // Stamp a JS-property marker on m5's live node (a custom *attribute* would
    // be stripped by morph's attr-reconcile; a JS property survives node reuse
    // and is absent on a freshly-created node).
    await m5.evaluate((el) => { (el as unknown as { __morphKept?: boolean }).__morphKept = true; });

    // Scroll the detail body down (the notes list is inside `.detail-body`,
    // which is the `overflow-y:auto` scroll container).
    await page.locator('#detail-body').evaluate((el) => { el.scrollTop = 200; });
    const scrollBefore = await page.locator('#detail-body').evaluate((el) => el.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);

    // EXTERNAL change → the detail poll re-fetches + re-renders the notes.
    const more = [...baseNotes, {
      id: 'm-new',
      text: 'Externally added note (simulates another client / the channel writing a note).',
      created_at: new Date(Date.now() + 9_000_000).toISOString(),
    }];
    const updRes = await page.request.put(`/api/tickets/${String(ticketId)}/notes-bulk`, {
      headers, data: { notes: JSON.stringify(more) },
    });
    expect(updRes.ok()).toBe(true);

    // Wait until the new note appears — proves a poll-driven `renderNotes` ran.
    await expect(page.locator('#detail-notes .note-entry[data-note-id="m-new"]')).toBeVisible({ timeout: 10000 });

    // morph reused m5's node → the JS-property marker survives. A
    // `replaceChildren` teardown would have created a fresh node without it.
    const kept = await page.locator('#detail-notes .note-entry[data-note-id="m5"]')
      .evaluate((el) => (el as unknown as { __morphKept?: boolean }).__morphKept === true);
    expect(kept).toBe(true);

    // ...and the scroll position survives the re-render (morph reconciles in
    // place; the pre-fix teardown reset it toward the top).
    const scrollAfter = await page.locator('#detail-body').evaluate((el) => el.scrollTop);
    expect(scrollAfter).toBeGreaterThan(0);
  });
});
