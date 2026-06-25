/**
 * HS-9033 — E2E for the device (phone) side of mTLS QR pairing: the standalone
 * `/pair` page. Drives the REAL client flow — paste the pairing code → generate
 * an RSA keypair + CSR in the browser (real node-forge) → POST to
 * `/api/auth/pair/complete` → assemble a `.p12` in the browser → download it.
 *
 * Only the server's signing is stubbed (a pre-generated CA + client cert via the
 * project's own `ca.ts`), so the test never needs the OS keychain. The in-browser
 * keygen + CSR + `.p12` assembly are exercised for real; their byte-compatibility
 * with the server signer is separately proven in
 * `src/client/pairing/devicePairing.test.ts`. The camera/`BarcodeDetector` path
 * and the per-platform cert install are manual (docs/manual-test-plan.md §7).
 */
import { generateCa, signClientCert } from '../src/auth/ca.js';
import { pairingPayload } from '../src/client/pairingPayload.js';
import { expect, test } from './coverage-fixture.js';

// HS-9067 — the manual-entry `<details id="pair-paste-details">` auto-opens when
// the browser has no `BarcodeDetector` (the headless-Chromium case — see
// `pair.tsx::renderStart`), and stays closed when a camera scanner IS available
// (real device). A blind `.pair-paste summary` click therefore TOGGLES it: it
// opens on a real device but *closes* the already-open section under headless,
// hiding `#pair-paste-input` so the subsequent `.fill()` times out. Open it
// idempotently instead so the spec works in both environments.
async function openManualEntry(page: import('@playwright/test').Page): Promise<void> {
  const details = page.locator('#pair-paste-details');
  const alreadyOpen = await details.evaluate((d) => (d as HTMLDetailsElement).open);
  if (!alreadyOpen) await page.locator('.pair-paste summary').click();
  await expect(page.locator('#pair-paste-input')).toBeEditable();
}

test('/pair: paste code → in-browser CSR → enroll → .p12 downloads (HS-9033)', async ({ page }) => {
  // A real CA + client cert so the page's forge `.p12` assembly gets parseable
  // PEMs back — no keychain, no real signing endpoint.
  const ca = generateCa({ commonName: 'E2E Project CA' });
  const { certPem } = signClientCert(ca, { clientId: 'e2e-client-1', label: 'My phone' });

  let completeCalls = 0;
  await page.route(/\/api\/auth\/pair\/complete(\?|$)/, (route) => {
    completeCalls += 1;
    const body = route.request().postDataJSON() as { token: string; csrPem: string; label: string };
    // The page must send the token from the payload + a real PEM CSR.
    expect(body.token).toBe('e2e-token-123');
    expect(body.csrPem).toContain('CERTIFICATE REQUEST');
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        device: {
          clientId: 'e2e-client-1', label: body.label, serial: 'AA:BB', fingerprint: 'FP',
          enrolledAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 365 * 86400_000).toISOString(), revoked: false,
        },
        certPem,
        caCertPem: ca.caCertPem,
      }),
    });
  });

  await page.goto('/pair');
  await expect(page.locator('#pair-root')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Pair this device');

  // Open the manual-entry section (the camera path needs a real device) and
  // paste a valid pairing payload.
  await openManualEntry(page);
  await page.locator('#pair-paste-input').fill(pairingPayload('e2e-token-123', 'https://192.168.1.50:4174'));
  await page.locator('#pair-paste-btn').click();

  // Enroll step: the URL is echoed; fill a label + cert password.
  await expect(page.locator('.pair-step-enroll')).toBeVisible();
  await expect(page.locator('.pair-url')).toHaveText('https://192.168.1.50:4174');
  await page.locator('#pair-label-input').fill('My phone');
  await page.locator('#pair-pw-input').fill('certpw1');

  // Generate & enroll — real 2048-bit keygen runs in-browser, so allow time.
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#pair-enroll-btn').click();

  // Success screen with the install help + a working download.
  await expect(page.locator('.pair-step-done')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.pair-success')).toContainText('enrolled');
  await expect(page.locator('.pair-install-help')).toContainText('iPhone');
  expect(completeCalls).toBe(1);

  await page.locator('#pair-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('hotsheet-my-phone.p12');
});

test('/pair: an invalid pasted code is rejected with a friendly message (HS-9033)', async ({ page }) => {
  await page.goto('/pair');
  await expect(page.locator('#pair-root')).toBeVisible();
  await openManualEntry(page);
  await page.locator('#pair-paste-input').fill('not a pairing code');
  await page.locator('#pair-paste-btn').click();
  await expect(page.locator('.pair-error')).toContainText("doesn't look like a Hot Sheet pairing code");
  // Still on the start step (no enroll form).
  await expect(page.locator('.pair-step-enroll')).toHaveCount(0);
});
