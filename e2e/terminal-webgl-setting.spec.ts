import { expect, test } from './coverage-fixture.js';

/**
 * HS-8488 — the "Use software rendering for terminals" opt-out row in
 * Settings → Terminal (HS-9404 moved it there from General). The row is gated on WebGL2 being available in the
 * browser (headless Chromium ships SwiftShader WebGL2, so it shows here),
 * writes the global `terminalWebglOptOut` flag through `/api/global-config`,
 * and the choice survives a reload (hydrated at boot from the same endpoint).
 *
 * The renderer-decision logic itself (`shouldUseWebglRenderer`) is unit-tested
 * in `src/client/terminalWebgl.test.ts`; the e2e suite force-disables the WebGL
 * renderer via the coverage fixture's `__HOTSHEET_DISABLE_WEBGL__` seam so the
 * DOM-scraping terminal specs keep working — that seam is independent of the
 * `isWebgl2Available()` probe this row's visibility depends on.
 */
test.describe('Terminal WebGL opt-out setting (HS-8488)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('software-rendering row appears in Terminal settings and persists across reload', async ({ page, errorCapture }) => {
    // Opening the settings dialog eagerly fires the snapshot-protection status
    // GET (§73); the `page.reload()` below can abort it mid-flight, surfacing a
    // benign "Failed to fetch" console.error. Same reload-aborts-in-flight-fetch
    // category as the global `/api/poll` allowlist entry — not a real failure.
    errorCapture.allowErrors([/Could not load snapshot-protection setting/]);

    // HS-9404 — the row lives on the Terminal tab now, not General.
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    await expect(page.locator('.settings-tab-panel[data-panel="terminal"]')).toHaveClass(/active/);

    // WebGL2 is available under SwiftShader, so the row reveals itself.
    const section = page.locator('#terminal-webgl-section');
    await expect(section).toBeVisible({ timeout: 3000 });

    const checkbox = page.locator('#settings-terminal-webgl-opt-out');
    await expect(checkbox).not.toBeChecked();

    // Opt in to software rendering — writes the global flag via PATCH.
    await checkbox.check();
    await expect(checkbox).toBeChecked();

    // Wait for the PATCH to actually land before reloading. `check()` only proves
    // the local DOM flipped; `setTerminalWebglOptOut` PATCHes `/api/global-config`
    // asynchronously, and reloading first would throw the write away and leave the
    // reopened dialog unchecked. (Latent race — it only started failing once
    // HS-9404 added the extra tab click and shifted the timing.)
    await expect.poll(
      async () => (await (await page.request.get('/api/global-config')).json() as { terminalWebglOptOut?: boolean }).terminalWebglOptOut,
      { timeout: 5000 },
    ).toBe(true);

    // Reload: the boot hydration (loadTerminalWebglOptOut) should re-read the
    // persisted flag, and reopening settings should reflect it.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="terminal"]').click();
    await expect(page.locator('#settings-terminal-webgl-opt-out')).toBeChecked();
  });

  // HS-9404 — pin WHICH tab owns the row. Without this a future refactor could
  // move it back to General and every other assertion here would still pass.
  test('the row is inside the Terminal panel, not General (HS-9404)', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.settings-tab-panel[data-panel="terminal"] #terminal-webgl-section')).toHaveCount(1);
    await expect(page.locator('.settings-tab-panel[data-panel="general"] #terminal-webgl-section')).toHaveCount(0);
  });
});
