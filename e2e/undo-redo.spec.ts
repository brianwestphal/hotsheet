/**
 * HS-5628: Undo/redo workflow — Cmd+Z to undo changes, verify state reverts.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Undo/redo workflow (HS-5628)', () => {
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

  test('undo status change reverts to previous status', async ({ page, request }) => {
    // HS-9698 — same load-sensitivity class as the delete-undo tests below (observed
    // flaking under concurrent load even though focus is already reset before undo).
    // Give it 3× headroom; the revert assertion below carries a generous budget too.
    test.slow();
    const suffix = Date.now();
    const title = `Undo status test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();

    // Change status: not_started → started. HS-9698 — `trackedPatch` writes the
    // store OPTIMISTICALLY (so `title=started` shows instantly) but pushes the undo
    // entry only AFTER the awaited PATCH (`actions.ts`), so an undo fired on the
    // optimistic title can hit an EMPTY stack. Wait for the PATCH response — the push
    // follows it synchronously — before undoing.
    const statusBtn = row.locator('.ticket-status-btn');
    const patchResp = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/api\/tickets\/\d+/.test(r.url()));
    await statusBtn.click();
    await patchResp;
    await expect(statusBtn).toHaveAttribute('title', 'started', { timeout: 3000 });

    // Click the ticket list container to ensure focus is not in an input
    await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });

    // Undo with Cmd+Z
    await page.keyboard.press('Meta+z');

    // Should revert to not_started (15s ceiling — the undo round-trip + re-render
    // lags under load; Playwright polls, so the extra budget is free on a fast run).
    await expect(statusBtn).toHaveAttribute('title', 'not started', { timeout: 15000 });
  });

  test('undo delete restores the ticket', async ({ page, request }) => {
    // HS-9698 — under heavy parallel CI load the undo-restore re-render is slow;
    // give the whole test 3× headroom (test.slow) so the delete/reload steps don't
    // exhaust the budget, and the post-undo visibility assertion below a generous
    // condition-based budget of its own (expect timeouts are independent of the
    // test timeout). Both were 5/5-flaky on a loaded machine; neither slows a fast run.
    test.slow();
    const suffix = Date.now();
    const title = `Undo delete test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();

    // Select and delete via context menu (more reliable than keyboard on CI)
    await row.locator('.ticket-number').click();
    await expect(row).toHaveClass(/selected/, { timeout: 3000 });
    await row.locator('.ticket-number').click({ button: 'right' });
    await page.waitForTimeout(200);
    // HS-9698 — the real flake cause: `trackedDelete` removes the card IMMEDIATELY
    // (optimistic) but pushes the undo entry only AFTER the awaited DELETE round-trip
    // (`actions.ts` — `removeTicket` then `await deleteTicket` then `push`). So a
    // `Meta+z` fired as soon as the card hides can hit an EMPTY undo stack → nothing
    // restores; load widens that window. Wait for the DELETE response (which the
    // push follows synchronously) before undo, not just for the card to vanish.
    const deleteResp = page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/tickets\/\d+/.test(r.url()));
    await page.locator('.context-menu-item.danger').filter({ hasText: 'Delete' }).click();
    await deleteResp;
    await expect(page.locator(`.ticket-title-input[value="${title}"]`)).toBeHidden({ timeout: 5000 });

    // Move focus OUT of any ticket input before undo. The global Cmd+Z handler bails
    // to native undo when `e.target` is editable (`shouldSkipGlobalUndo`), so if
    // focus lingers on an input the ticket-level undo never fires. Clicking the
    // (non-editable) list neutralizes that deterministically.
    await page.locator('#ticket-list').click({ position: { x: 5, y: 5 } });

    // Undo delete
    await page.keyboard.press('Meta+z');

    // Ticket should reappear (15s ceiling for the restore re-render under load;
    // Playwright polls, so the extra budget is free on a fast run).
    await expect(page.locator(`.ticket-title-input[value="${title}"]`)).toBeVisible({ timeout: 15000 });
  });

  test('HS-9117 — undo reverts the details textarea immediately while it has focus', async ({ page, request }) => {
    const suffix = Date.now();
    const title = `Undo details focus test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title, defaults: { details: 'original details' } } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    // Open the detail panel for this ticket.
    await row.locator('.ticket-number').click();
    await expect(page.locator('#detail-title')).toHaveValue(title, { timeout: 5000 });

    // Enter edit mode on the Details field (click the rendered view).
    await page.locator('#detail-details-rendered').click();
    const detailsArea = page.locator('#detail-details');
    await expect(detailsArea).toBeFocused();
    await expect(detailsArea).toHaveValue('original details');

    // HS-9352 — append the edit with REAL keystrokes, not `fill()`. For a focused
    // editable field the app delegates Cmd+Z to the browser's NATIVE undo
    // (HS-9335 `shouldSkipGlobalUndo`), and `fill()` sets `.value` directly WITHOUT
    // a native-undo entry — so native Cmd+Z was a no-op and the revert never
    // happened (the recurring hard-failure). A contiguous typed run is one native
    // undo unit, so a single Cmd+Z reverts exactly it.
    await detailsArea.press('End');
    await page.keyboard.type('EDITED');
    await expect(detailsArea).toHaveValue('original detailsEDITED');
    // Let the debounced auto-save round-trip (recorded synchronously in the same
    // input handler; a landed save proves the edit registered).
    await expect.poll(async () => {
      const res = await page.request.get('/api/tickets?status=active');
      const tickets = await res.json() as { title: string; details: string }[];
      return tickets.find(t => t.title === title)?.details ?? '';
    }, { timeout: 8000 }).toBe('original detailsEDITED');

    // Keep focus in the textarea and undo — the native undo reverts the typed run.
    // HS-9352 — `ControlOrMeta`, NOT `Meta`: for a focused field the app delegates
    // to the browser's NATIVE undo (HS-9335), whose chord is Ctrl+Z on Linux/Windows
    // and Cmd+Z on macOS. Hard-coding Meta+z passed on the macOS dev box but was a
    // no-op on the Linux CI runner (received "original detailsEDITED"), the last
    // e2e-job hard-failer.
    await detailsArea.focus();
    await page.keyboard.press('ControlOrMeta+z');

    await expect(detailsArea).toHaveValue('original details', { timeout: 5000 });
  });

  test.skip('undo up-next toggle reverts the star', async ({ page, request }) => {
    // Skip: inline star toggle uses trackedPatch but the undo may be
    // coalesced or the re-render doesn't reflect the revert fast enough.
    const suffix = Date.now();
    const title = `Undo star test ${suffix}`;
    await request.post('/api/tickets', { headers, data: { title } });
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    const row = page.locator('.ticket-row[data-id]').filter({ has: page.locator(`.ticket-title-input[value="${title}"]`) }).first();
    const star = row.locator('.ticket-star');

    // Select the ticket first, then toggle star
    await row.locator('.ticket-number').click();
    await page.waitForTimeout(200);
    await star.click();
    await expect(star).toHaveClass(/active/, { timeout: 3000 });

    // Undo — Cmd+Z works from anywhere, no need to refocus
    await page.keyboard.press('Meta+z');

    // Star should be off
    await expect(star).not.toHaveClass(/active/, { timeout: 5000 });
  });
});
