import type { Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/**
 * HS-9427 (docs/127 §127.5) — E2E for the Settings → Telemetry "Reclaim telemetry
 * disk" button. Drives the real round-trip: click the button, click the in-app
 * confirm overlay's REAL button (Tauri-safe `confirmDialog`, not
 * `page.on('dialog')`), and assert the status line reports back.
 *
 * The e2e server's telemetry clusters are freshly created (tuned, well under the
 * 256 MB threshold), so a real reclaim finds nothing to do and reports "already
 * compact" — which is exactly what proves the button → confirm → POST →
 * status-line path works end to end. Bloating a cluster past 256 MB just to see a
 * non-zero number isn't worth minutes of CI; the shrink itself is unit-tested
 * against a real bloated cluster in `src/db/telemetryReclaim.test.ts`.
 */
test.describe('Reclaim telemetry disk (HS-9427)', () => {
  async function openTelemetryTab(page: Page): Promise<void> {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="telemetry"]').click();
    await expect(page.locator('.settings-tab-panel[data-panel="telemetry"]')).toHaveClass(/active/);
    await expect(page.locator('#settings-telemetry-reclaim-btn')).toBeVisible({ timeout: 3000 });
  }

  test('confirming runs a reclaim and reports back', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openTelemetryTab(page);

    await page.locator('#settings-telemetry-reclaim-btn').click();
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await overlay.locator('.confirm-dialog-confirm').click();

    // Healthy clusters → nothing over threshold → the "already compact" message.
    // Either way the status line resolves out of "Reclaiming…" to a real result.
    await expect(page.locator('#settings-telemetry-reclaim-status'))
      .toHaveText(/already compact|Reclaimed/, { timeout: 15000 });
  });

  test('cancelling does nothing', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
    await openTelemetryTab(page);

    await page.locator('#settings-telemetry-reclaim-btn').click();
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await overlay.locator('.confirm-dialog-cancel').click();
    await expect(overlay).toBeHidden();
    await expect(page.locator('#settings-telemetry-reclaim-status')).toHaveText('');
  });
});
