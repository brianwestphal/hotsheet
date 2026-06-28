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

    // HS-9127 — Resolved is read-only; appName is a shared-only field, so edit it
    // in Shared mode.
    await page.locator('.scope-seg-btn.scope-seg-shared').click();

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

    // HS-8823 — the visible project name is the active project TAB
    // (`.project-tab-name`), not an `.app-title h1` (that h1 only exists in the
    // impossible empty-projects state since HS-8664 made the title area always
    // tabbed). The app debounces the save at 800ms, then `refreshProjectTabs` +
    // the per-row reactive name effect update the tab in place — no reload.
    await expect(page.locator('.project-tab.active .project-tab-name')).toHaveText('My Project Board', { timeout: 10000 });
    // Document title should also update.
    await expect(page).toHaveTitle('My Project Board', { timeout: 5000 });

    // Close settings
    await page.locator('#settings-close').click();
    await expect(overlay).toBeHidden();

    // Reload and verify the name persisted
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.project-tab.active .project-tab-name')).toHaveText('My Project Board', { timeout: 5000 });
  });

  test('HS-9115: dialog height stays constant across tabs', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const dialog = page.locator('.settings-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // General tab (default, content-light).
    const generalHeight = (await dialog.boundingBox())!.height;

    // Switch to a content-heavy tab (Telemetry) — pre-HS-9115 the dialog grew
    // to fit each tab's content, so the height differed between tabs.
    await page.locator('.settings-tab[data-tab="telemetry"]').click();
    const telemetryHeight = (await dialog.boundingBox())!.height;

    // Back to a light tab.
    await page.locator('.settings-tab[data-tab="backups"]').click();
    const backupsHeight = (await dialog.boundingBox())!.height;

    expect(Math.abs(telemetryHeight - generalHeight)).toBeLessThan(2);
    expect(Math.abs(backupsHeight - generalHeight)).toBeLessThan(2);
  });

  test('close settings with Escape key', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden({ timeout: 3000 });
  });

  test('HS-6568: first settings-section in a tab panel has no top border', async ({ page }) => {
    await page.locator('#settings-btn').click();
    const overlay = page.locator('#settings-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });

    // The Terminal tab button is Tauri-gated (hidden in a plain browser) but
    // the panel HTML always exists. Force it visible so getComputedStyle can
    // measure the first section's borders.
    await page.evaluate(() => {
      const panel = document.getElementById('settings-terminal-panel')!;
      panel.classList.add('active');
      panel.style.display = 'block';
    });

    const styles = await page.evaluate(() => {
      const panel = document.getElementById('settings-terminal-panel')!;
      const firstSection = panel.querySelector(':scope > .settings-section') as HTMLElement;
      const cs = window.getComputedStyle(firstSection);
      return {
        borderTopWidth: cs.borderTopWidth,
        paddingTop: cs.paddingTop,
        marginTop: cs.marginTop,
      };
    });

    expect(styles.borderTopWidth).toBe('0px');
    expect(styles.paddingTop).toBe('0px');
    expect(styles.marginTop).toBe('0px');
  });
});
