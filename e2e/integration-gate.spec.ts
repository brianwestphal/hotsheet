import { expect, test } from './coverage-fixture.js';

/**
 * HS-9099 / docs/106 §106.2 — the Settings → General "Worker integration gate"
 * input persists the `integrationGate` command to the project's settings.json
 * (read back via /api/file-settings) and restores after a reload; clearing it
 * removes the setting (back to the agent-runs-gates default). Drives the real UI.
 */
test.describe('Worker integration gate (HS-9099 / §106.2)', () => {
  const GATE = 'npm run -s typecheck && npm test';

  test('input saves to file-settings, restores on reload, and clears', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    // Open Settings → General. The scoped scalar fields are (re-)applied after the
    // async GET /file-settings/layered fetch, so a fill that lands before that
    // would be clobbered — wait for the scope load + a settle first (mirrors the
    // worklist-preamble spec / HS-9065).
    const firstScopeLoad = page.waitForResponse((r) => r.url().includes('/file-settings/layered'));
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.waitForResponse((r) => r.url().includes('/api/file-settings') && r.request().method() === 'GET');
    await firstScopeLoad;
    await page.waitForTimeout(300);

    // HS-9127 — the Resolved (default) scope view is read-only; scoped fields are
    // editable only in a concrete layer. `integrationGate` is shared-only, so
    // switch to Shared before editing.
    await page.locator('.scope-seg-btn.scope-seg-shared').click();

    const input = page.locator('#settings-integration-gate');
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();
    await input.fill(GATE);
    await expect(input).toHaveValue(GATE);
    // Debounced save (800 ms) — the hint confirms the write.
    await expect(page.locator('#settings-integration-gate-hint')).toContainText(/Saved/i, { timeout: 5000 });

    // Persisted server-side.
    const fs = await request.get('/api/file-settings').then((r) => r.json()) as { integrationGate?: string };
    expect(fs.integrationGate).toBe(GATE);

    // Restores after a full reload.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    const secondScopeLoad = page.waitForResponse((r) => r.url().includes('/file-settings/layered'));
    await page.locator('#settings-btn').click();
    await secondScopeLoad;
    await page.waitForTimeout(300);
    // Re-enter Shared to read back + edit the persisted value (Resolved is read-only).
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(page.locator('#settings-integration-gate')).toHaveValue(GATE);

    // Clearing it removes the gate (back to the agent-runs-gates default) — and
    // keeps the shared server clean for other specs.
    await page.locator('#settings-integration-gate').fill('');
    await expect(page.locator('#settings-integration-gate-hint')).toContainText(/Cleared/i, { timeout: 5000 });
    const cleared = await request.get('/api/file-settings').then((r) => r.json()) as { integrationGate?: string };
    expect(cleared.integrationGate ?? '').toBe('');
  });
});
