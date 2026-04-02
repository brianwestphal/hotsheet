import { expect, test } from './coverage-fixture.js';

test.describe('Settings dialog', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('open settings, change app name, and verify title updates', async ({ page }) => {
    // Click the settings gear button
    await page.locator('#settings-btn').click();

    // Settings overlay should be visible
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    // Wait for the async file-settings fetch to populate the app name field.
    // The app fetches /api/file-settings after opening and sets the input value.
    // We detect load completion by waiting for the input to become stable (not disabled)
    // and for any network activity to settle.
    const appNameInput = page.locator('#settings-app-name');
    await appNameInput.waitFor({ state: 'visible' });
    // Give the async settings fetch time to complete and populate the field
    await page.waitForTimeout(500);

    // Clear and type the new name character by character to ensure input events fire
    await appNameInput.clear();
    await appNameInput.type('My Project Board');

    // The app debounces the save at 800ms then makes an async API call that updates the h1.
    await expect(page.locator('.app-title h1')).toHaveText('My Project Board', { timeout: 10000 });
    // Document title should also update
    await expect(page).toHaveTitle('My Project Board', { timeout: 5000 });

    // Close settings
    await page.locator('#settings-close').click();
    await expect(overlay).toBeHidden();

    // Reload and verify the name persisted
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.app-title h1')).toHaveText('My Project Board', { timeout: 5000 });
  });

  test('close settings with Escape key', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden({ timeout: 3000 });
  });
});
