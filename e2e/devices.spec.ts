/**
 * HS-9024 — E2E for the Remote Access (mTLS device enrollment) UI: Settings →
 * "Remote Access" tab. Add a device through the real form → a `.p12` download is
 * triggered and the row lists; revoke it → the row shows a "Revoked" chip and the
 * revoke button is gone.
 *
 * The `/api/auth/devices/*` routes are intercepted so the test never mints a real
 * CA / touches the OS keychain (that path is covered by
 * `src/routes/enrollment.test.ts` + `src/auth/ca.test.ts`). This spec exercises
 * the real client wiring: mint → Tauri-safe download (Blob in Chromium) → list →
 * revoke. The Tauri native-save path is a manual-test-plan item (Chromium can't
 * catch the WKWebView `<a download>` no-op).
 */
import { expect, test } from './coverage-fixture.js';

interface Device {
  clientId: string; label: string; serial: string; fingerprint: string;
  enrolledAt: string; expiresAt: string; revoked: boolean; revokedAt?: string;
}

test('Remote Access tab: add a device → .p12 downloads + lists → revoke shows the chip (HS-9024)', async ({ page }) => {
  const devices: Device[] = [];

  // Regex routes (the typed callers append a query string, so an exact glob
  // wouldn't match). Registered list-first so the later, more specific mint /
  // revoke handlers win (Playwright checks routes last-registered-first).
  await page.route(/\/api\/auth\/devices(\?|$)/, (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ devices }) });
  });
  await page.route(/\/api\/auth\/devices\/mint(\?|$)/, (route) => {
    const body = route.request().postDataJSON() as { label: string; password: string };
    const now = new Date().toISOString();
    const device: Device = {
      clientId: `client-${String(devices.length + 1)}-abcdef`, label: body.label,
      serial: 'AA:BB', fingerprint: 'FP', enrolledAt: now,
      expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(), revoked: false,
    };
    devices.push(device);
    // A tiny stand-in for the .p12 bytes (base64 of "PKCS12bytes").
    const p12Base64 = Buffer.from('PKCS12bytes').toString('base64');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ device, p12Base64, filename: 'hotsheet-test.p12' }) });
  });
  await page.route(/\/api\/auth\/devices\/[^/]+\/revoke(\?|$)/, (route) => {
    const clientId = decodeURIComponent(route.request().url().split('/devices/')[1].split('/revoke')[0]);
    const d = devices.find(x => x.clientId === clientId);
    if (d) { d.revoked = true; d.revokedAt = new Date().toISOString(); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ device: d }) });
  });

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  // First-launch AI-instructions nudge (HS-8913) overlay intercepts clicks.
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
  });

  // Open Settings → Remote Access tab. Starts empty.
  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-tab="devices"]').click();
  const panel = page.locator('#settings-devices-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('#settings-devices-list')).toContainText('No devices enrolled yet');

  // Add a device → fill the form → expect a .p12 download.
  await panel.locator('#settings-device-add-btn').click();
  const dialog = page.locator('.settings-key-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input.settings-key-dialog-input').nth(0).fill('Brian’s iPhone'); // label
  await dialog.locator('input.settings-key-dialog-input').nth(1).fill('hunter2'); // export password

  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Create & Download .p12' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('hotsheet-test.p12');

  // The row lists with the label + a Revoke button.
  const row = panel.locator('.settings-key-row');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.settings-device-label')).toHaveText('Brian’s iPhone');
  await expect(row.locator('.settings-key-meta')).toContainText('expires');
  await expect(row.locator('.settings-device-revoke')).toBeVisible();

  // Revoke → confirm in the in-app overlay → the row flips to a "Revoked" chip.
  await row.locator('.settings-device-revoke').click();
  await page.locator('.confirm-dialog-confirm').click();
  await expect(row.locator('.settings-device-revoked-chip')).toHaveText('Revoked');
  await expect(row.locator('.settings-device-revoke')).toHaveCount(0);
});

test('Remote Access tab: "Pair a Device" renders a QR + countdown (HS-9026)', async ({ page }) => {
  await page.route(/\/api\/auth\/devices(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ devices: [] }),
  }));
  await page.route(/\/api\/auth\/pair\/start(\?|$)/, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ token: 'tok-abc-123', expiresAt: Date.now() + 5 * 60 * 1000 }),
  }));

  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
  });

  await page.locator('#settings-btn').click();
  await page.locator('.settings-tab[data-tab="devices"]').click();
  const panel = page.locator('#settings-devices-panel');
  await expect(panel).toBeVisible();

  // Pair → an address form appears; enter a reachable URL → Generate Code.
  await panel.locator('#settings-device-pair-btn').click();
  const urlInput = panel.locator('.settings-pairing-url');
  await expect(urlInput).toBeVisible();
  await urlInput.fill('https://192.168.1.50:4174');
  await panel.locator('.settings-pairing-generate').click();

  // The QR image renders (a data URL) with a live countdown.
  const qrImg = panel.locator('.settings-pairing-qr img');
  await expect(qrImg).toBeVisible();
  await expect(qrImg).toHaveAttribute('src', /^data:image\//);
  await expect(panel.locator('.settings-pairing-countdown')).toContainText('Expires in');

  // "Done" tears the pairing UI back down.
  await panel.locator('.settings-pairing-done').click();
  await expect(panel.locator('.settings-pairing-qr')).toHaveCount(0);
});
