import { expect, test } from './coverage-fixture.js';

test.describe('Settings persistence', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('open settings via gear icon and verify overlay appears', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
  });

  test('switch to Categories tab and verify category list loads', async ({ page }) => {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });

    // Click the Categories tab
    await page.locator('.settings-tab[data-tab="categories"]').click();
    await expect(page.locator('.settings-tab[data-tab="categories"]')).toHaveClass(/active/);

    // The categories panel should be active
    await expect(page.locator('.settings-tab-panel[data-panel="categories"]')).toHaveClass(/active/);

    // Category list container should exist and have content (default categories are loaded)
    const categoryList = page.locator('#category-list');
    await expect(categoryList).toBeVisible({ timeout: 3000 });
    // There should be at least one category row (defaults are loaded on startup)
    await expect(categoryList.locator('.category-row').first()).toBeVisible({ timeout: 5000 });
  });

  test('change trash cleanup days persists to the DB, not the file layer (HS-9168)', async ({ page }) => {
    // Open settings
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });

    // HS-9168 — trash_cleanup_days is a DB-only project setting (not in SCOPED_FIELDS).
    // Under the default Local scope mode it must still write to the DB — NOT misroute
    // to settings.local.json, which the server's cleanup logic ignores for this key.
    const trashInput = page.locator('#settings-trash-days');
    await trashInput.fill('7');
    await page.waitForTimeout(1000); // debounced save (500ms) + API call

    // It persisted to the DB (what the cleanup logic reads).
    const db = await (await page.request.get('/api/settings')).json() as Record<string, string>;
    expect(db.trash_cleanup_days).toBe('7');
    // And it did NOT leak into the local file layer.
    const layered = await (await page.request.get('/api/file-settings/layered')).json() as { local: Record<string, unknown> };
    expect(layered.local.trash_cleanup_days).toBeUndefined();

    // Reopen settings and verify the value is shown.
    await page.locator('#settings-close').click();
    await expect(page.locator('#settings-overlay')).toBeHidden({ timeout: 3000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await expect(trashInput).toHaveValue('7', { timeout: 3000 });
  });

  test('toggle auto-prioritize persists to settings.local.json + reopen (HS-9170 local-only)', async ({ page }) => {
    // Open settings (default Local mode). HS-9170 — auto_order is now a local-only
    // file setting, editable in Local; it must persist to settings.local.json and
    // be read back from the file layer (not the DB).
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });

    const autoOrderCheckbox = page.locator('#settings-auto-order');
    await expect(autoOrderCheckbox).toBeEnabled(); // editable in the default Local mode
    const initialChecked = await autoOrderCheckbox.isChecked();

    await autoOrderCheckbox.click();
    if (initialChecked) {
      await expect(autoOrderCheckbox).not.toBeChecked({ timeout: 3000 });
    } else {
      await expect(autoOrderCheckbox).toBeChecked({ timeout: 3000 });
    }
    await page.waitForTimeout(600); // debounced write to settings.local.json

    // It persisted to the LOCAL file layer (the value the client now reads back).
    const layered = await (await page.request.get('/api/file-settings/layered')).json() as { local: Record<string, unknown> };
    expect(String(layered.local.auto_order)).toBe(String(!initialChecked));

    // RELOAD the page (re-runs loadSettings) → this is the actual regression: the
    // file value must be read back, not reverted to the stale DB value.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    if (initialChecked) {
      await expect(autoOrderCheckbox).not.toBeChecked({ timeout: 3000 });
    } else {
      await expect(autoOrderCheckbox).toBeChecked({ timeout: 3000 });
    }
  });

  test('close settings with Escape key', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden({ timeout: 3000 });
  });

  test('close settings by clicking overlay background', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    // Click the overlay background (top-left corner, outside the dialog)
    await overlay.click({ position: { x: 5, y: 5 } });
    await expect(overlay).toBeHidden({ timeout: 3000 });
  });
});
