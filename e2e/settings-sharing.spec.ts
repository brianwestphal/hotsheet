import { expect, test } from './coverage-fixture.js';

// HS-9004 — dialog-wide Shared | Local overrides | Resolved scope control. A
// persistent toolbar under the Settings tab strip decorates each file-settings
// field in place (no dedicated "Sharing" tab).
test.describe('Settings scope control (Shared | Local | Resolved)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    // First-launch AI-instructions nudge (HS-8913) overlay intercepts clicks.
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
    });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#settings-scope-bar')).toBeVisible();
  });

  test('renders the dialog-wide toolbar; defaults to Resolved with origin tags', async ({ page }) => {
    await expect(page.locator('.scope-seg-btn')).toHaveCount(3);
    await expect(page.locator('.scope-seg-btn.scope-seg-resolved.active')).toBeVisible();
    // Settings stay in their own tabs — the General tab is shown, not a Sharing tab.
    await expect(page.locator('.settings-tab[data-tab="sharing"]')).toHaveCount(0);
    // A scalar field carries an origin tag in Resolved mode.
    const field = page.locator('.settings-field:has(#settings-app-name)');
    await expect(field.locator('.scope-tag')).toBeVisible({ timeout: 5000 });
  });

  test('Shared mode is editable and notes the file being edited', async ({ page }) => {
    await page.locator('.scope-seg-btn.scope-seg-shared').click();
    await expect(page.locator('.scope-seg-btn.scope-seg-shared.active')).toBeVisible();
    await expect(page.locator('#settings-scope-note')).toContainText('settings.json');
    await expect(page.locator('#settings-app-name')).toBeEnabled();
  });

  test('Local mode: override an inherited field, then reset it', async ({ page }) => {
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(page.locator('#settings-scope-note')).toContainText('settings.local.json');

    const field = page.locator('.settings-field:has(#settings-app-name)');
    // Inherited → read-only behind a "+ Override" affordance.
    const overrideBtn = field.locator('[data-scope-action="override"]');
    await expect(overrideBtn).toBeVisible();
    await expect(page.locator('#settings-app-name')).toBeDisabled();
    await overrideBtn.click();

    // Now an editable local override with a Reset action.
    await expect(page.locator('#settings-app-name')).toBeEnabled({ timeout: 3000 });
    await page.locator('#settings-app-name').fill('Local Name');
    await page.waitForTimeout(900); // debounced write

    // Reset to shared → in-app confirm overlay (Tauri-safe, NOT window.confirm).
    await field.locator('[data-scope-action="reset"]').click();
    const confirmBtn = page.locator('.confirm-dialog-confirm');
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();

    // Back to inherited (the +Override affordance returns, control re-disabled).
    await expect(field.locator('[data-scope-action="override"]')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#settings-app-name')).toBeDisabled();
  });

  test('complex / non-overridable surfaces lock in Shared/Local mode', async ({ page }) => {
    // Categories is a complex list editor — read-only outside Resolved.
    await page.locator('.scope-seg-btn.scope-seg-local').click();
    await expect(page.locator('.settings-tab-panel[data-panel="categories"].scope-locked')).toHaveCount(1);
    await page.locator('.scope-seg-btn.scope-seg-resolved').click();
    await expect(page.locator('.settings-tab-panel[data-panel="categories"].scope-locked')).toHaveCount(0);
  });
});
