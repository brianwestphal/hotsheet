import type { APIRequestContext, Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/**
 * HS-9702 (docs/137) — the Settings → Permissions "Auto-approve after timeout"
 * dropdown persists `permission_auto_approve_ms` (local-only) and restores on
 * reload. Drives the real UI, reading back through /api/file-settings (the same
 * key the overlay + server enforcement consume). The countdown/fire behavior is
 * covered by unit tests (permissionOverlay.test.ts) — a full minute-long e2e wait
 * isn't practical.
 */
test.describe('Auto-approve permission timeout setting (HS-9702)', () => {
  const readWindow = async (request: APIRequestContext): Promise<number | undefined> =>
    (await request.get('/api/file-settings').then((r) => r.json()) as { permission_auto_approve_ms?: number }).permission_auto_approve_ms;

  async function openPermissionsTab(page: Page): Promise<void> {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible();
    await page.locator('#settings-tab-permissions').click();
    await expect(page.locator('#permission-auto-approve')).toBeVisible();
  }

  test('dropdown persists the window and restores it on reload', async ({ page, request }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });

    await openPermissionsTab(page);
    const select = page.locator('#permission-auto-approve');
    // Default: Off (0). The setting is absent until the user picks a window.
    await expect(select).toHaveValue('0');

    // Pick 5 minutes → persists to settings.local.json.
    await select.selectOption('300000');
    await expect.poll(() => readWindow(request), { timeout: 5000 }).toBe(300_000);

    // Restores on a fresh load.
    await page.reload();
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openPermissionsTab(page);
    await expect(page.locator('#permission-auto-approve')).toHaveValue('300000', { timeout: 5000 });

    // Turning it back Off clears it (persists 0).
    await page.locator('#permission-auto-approve').selectOption('0');
    await expect.poll(() => readWindow(request), { timeout: 5000 }).toBe(0);
  });
});
