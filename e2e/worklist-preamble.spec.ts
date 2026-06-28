import { expect, test } from './coverage-fixture.js';

/**
 * HS-8917 / §6 — the Settings → General "Worklist preamble" textarea persists to
 * the project's settings.json (read back via /api/file-settings) and repopulates
 * after a reload. Drives the real UI, not just the API.
 */
test.describe('Worklist preamble (HS-8917 / §6)', () => {
  const PREAMBLE = 'E2E preamble: be careful with migrations.';

  test('textarea saves to file-settings and restores on reload', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open Settings → General (default panel). The general tab populates fields
    // asynchronously from GET /file-settings on open and assigns the value
    // programmatically (no input event) — so a value typed before that lands is
    // silently clobbered. Wait for the round-trip + a settle before filling.
    // HS-9065 — opening Settings fires `loadAndApplyScope()` (settingsDialog.tsx):
    // it async-fetches GET /file-settings/layered, then `decorateField` re-applies
    // each scoped scalar field's effective value to its control. `worklist_preamble`
    // is a scoped field, so a decorate landing AFTER a fill/clear silently clobbers
    // it. Wait for that fetch (not just the legacy populate) + a settle so the
    // re-apply has already run before we touch the textarea.
    const firstScopeLoad = page.waitForResponse((r) => r.url().includes('/file-settings/layered'));
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    // HS-9127 — Resolved is read-only; edit the (standard) preamble field in Shared.
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await page.waitForResponse((r) => r.url().includes('/api/file-settings') && r.request().method() === 'GET');
    await firstScopeLoad;
    await page.waitForTimeout(300); // let decorate's synchronous re-apply run
    const textarea = page.locator('#settings-worklist-preamble');
    await expect(textarea).toBeVisible();
    await textarea.fill(PREAMBLE);
    await expect(textarea).toHaveValue(PREAMBLE);
    // Debounced save (800 ms) — wait for the hint to confirm the write.
    await expect(page.locator('#settings-worklist-preamble-hint')).toContainText(/Saved/i, { timeout: 5000 });

    // Persisted server-side.
    const fs = await request.get('/api/file-settings').then((r) => r.json()) as { worklist_preamble?: string };
    expect(fs.worklist_preamble).toBe(PREAMBLE);

    // Restores into the textarea after a full reload.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // Same as above — let the scope load + decorate re-apply the restored value
    // BEFORE we clear it, otherwise a late decorate refills the field and the
    // debounced save reads the repopulated (non-empty) value → "Saved" not
    // "Cleared".
    const secondScopeLoad = page.waitForResponse((r) => r.url().includes('/file-settings/layered'));
    await page.locator('#settings-btn').click();
    await page.locator('.scope-seg-btn.scope-seg-shared').click(); // HS-9127 — edit in Shared
    await secondScopeLoad;
    await page.waitForTimeout(300);
    await expect(page.locator('#settings-worklist-preamble')).toHaveValue(PREAMBLE);

    // Clean up so the shared server's project doesn't carry the preamble into
    // other specs' worklist.md.
    await page.locator('#settings-worklist-preamble').fill('');
    await expect(page.locator('#settings-worklist-preamble-hint')).toContainText(/Cleared/i, { timeout: 5000 });
  });
});
