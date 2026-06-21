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
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.waitForResponse((r) => r.url().includes('/api/file-settings') && r.request().method() === 'GET');
    await page.waitForTimeout(500); // let the populate's .then() assign the field first
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
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-worklist-preamble')).toHaveValue(PREAMBLE);

    // Clean up so the shared server's project doesn't carry the preamble into
    // other specs' worklist.md.
    await page.locator('#settings-worklist-preamble').fill('');
    await expect(page.locator('#settings-worklist-preamble-hint')).toContainText(/Cleared/i, { timeout: 5000 });
  });
});
