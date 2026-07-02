import { expect, test } from './coverage-fixture.js';

/**
 * HS-9222 (docs/110 §110.7 P2) — the Settings → Experimental "Induce AI review
 * notes" checkbox (`aiReviewNotes`) is a §95 scope-aware boolean. Toggling it in
 * the Shared layer persists to settings.json (read back via /api/file-settings —
 * the SAME key the worklist gating in `reviewNotesInducement.ts` /
 * `sync/markdown.ts` reads to inject the `## AI Review Notes` section), and it
 * restores after a full reload. Drives the real UI, not just the API. The
 * file-settings → worklist gating itself is unit-tested in
 * `reviewNotesInducement.test.ts` + `sync/markdown.test.ts`.
 */
test.describe('AI Review Notes setting toggle (HS-9222)', () => {
  test('checkbox saves to file-settings (Shared) and restores on reload', async ({ page, request }) => {
    const readAiReviewNotes = async (): Promise<boolean | undefined> =>
      (await request.get('/api/file-settings').then((r) => r.json()) as { aiReviewNotes?: boolean }).aiReviewNotes;

    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open Settings → Experimental in the Shared layer. Opening fires
    // loadAndApplyScope() (async GET /file-settings/layered), which re-applies each
    // scoped field's effective value to its control — so wait for that + a settle
    // before touching the checkbox, or a late decorate clobbers our toggle.
    const firstScopeLoad = page.waitForResponse((r) => r.url().includes('/file-settings/layered'));
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.locator('#settings-tab-experimental').click();
    await page.locator('.scope-seg-btn.scope-seg-shared').click(); // edit the shared layer
    await firstScopeLoad;
    await page.waitForTimeout(300);

    const checkbox = page.locator('#settings-ai-review-notes');
    await expect(checkbox).toBeVisible();
    await expect(checkbox).not.toBeChecked(); // default off

    // Enable → persists to settings.json (the key the worklist gating reads).
    await checkbox.check();
    await expect.poll(readAiReviewNotes, { timeout: 5000 }).toBe(true);

    // Restores checked after a full reload.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    const secondScopeLoad = page.waitForResponse((r) => r.url().includes('/file-settings/layered'));
    await page.locator('#settings-btn').click();
    await page.locator('#settings-tab-experimental').click();
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await secondScopeLoad;
    await page.waitForTimeout(300);
    await expect(page.locator('#settings-ai-review-notes')).toBeChecked();

    // Clean up — disable so the shared server's project doesn't carry the
    // inducement into other specs' worklist.md.
    await page.locator('#settings-ai-review-notes').uncheck();
    await expect.poll(readAiReviewNotes, { timeout: 5000 }).toBe(false);
  });
});
