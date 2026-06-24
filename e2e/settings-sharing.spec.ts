import { expect, test } from './coverage-fixture.js';

// HS-9004 — Settings → Sharing tab (Xcode-style Shared | Local overrides |
// Resolved view of the shared/local settings split).
test.describe('Settings → Sharing tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // First-launch AI-instructions nudge (HS-8913) renders shortly after boot and
    // its overlay intercepts clicks. Let it settle, then remove any instance.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
    });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="sharing"]').click();
    // Lazy-loaded panel renders the segmented control once the fetch lands.
    await expect(page.locator('.sharing-seg')).toBeVisible({ timeout: 5000 });
  });

  test('renders the three-mode control and curated rows', async ({ page }) => {
    await expect(page.locator('.sharing-seg-btn')).toHaveCount(3);
    // Resolved is the default mode (read-only).
    await expect(page.locator('.sharing-seg-btn.sharing-seg-resolved.active')).toBeVisible();
    // The hero local-scoped key is present.
    await expect(page.locator('.sharing-row[data-key="backupDir"]')).toBeVisible();
    // Resolved mode shows origin badges, no editable inputs.
    await expect(page.locator('.sharing-tag')).not.toHaveCount(0);
    await expect(page.locator('.sharing-input')).toHaveCount(0);
  });

  test('Shared mode exposes editable inputs; switching modes works', async ({ page }) => {
    await page.locator('.sharing-seg-btn.sharing-seg-shared').click();
    await expect(page.locator('.sharing-note-shared')).toBeVisible();
    // Editable inputs appear for simple keys in shared mode.
    await expect(page.locator('.sharing-input').first()).toBeVisible();
  });

  test('Local mode: override an inherited key, then reset it', async ({ page }) => {
    await page.locator('.sharing-seg-btn.sharing-seg-local').click();
    await expect(page.locator('.sharing-note-local')).toBeVisible();

    const row = page.locator('.sharing-row[data-key="backupDir"]');
    // Not yet overridden → shows the +Override affordance.
    const overrideBtn = row.locator('[data-action="override"]');
    await expect(overrideBtn).toBeVisible();
    await overrideBtn.click();

    // Now it's an editable local override with a Reset action.
    const input = row.locator('.sharing-input');
    await expect(input).toBeVisible({ timeout: 3000 });
    await input.fill('/tmp/my-local-backups');
    // Debounced write — give it a moment.
    await page.waitForTimeout(600);

    // Reset to shared → in-app confirm overlay (Tauri-safe, NOT window.confirm).
    await row.locator('[data-action="reset"]').click();
    const confirmBtn = page.locator('.confirm-dialog-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();

    // Back to inherited (the +Override affordance returns).
    await expect(row.locator('[data-action="override"]')).toBeVisible({ timeout: 3000 });
  });
});
