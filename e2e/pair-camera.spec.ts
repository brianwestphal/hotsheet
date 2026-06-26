/**
 * HS-9097 — end-to-end test for the `/pair` page's in-browser camera scan, now
 * powered by `@zxing/browser` (replacing the patchy native `BarcodeDetector`, so
 * the scan works on every browser including Firefox / older iOS). Previously the
 * camera path was manual-only (docs/manual-test-plan.md §7); ZXing being a
 * pure-JS decoder lets us drive it for real here.
 *
 * We feed a genuine QR code into the page through Chromium's fake video-capture
 * device: `qrY4m.ts` renders a pairing payload's QR straight into a Y4M frame,
 * and the browser is launched with `--use-file-for-fake-video-capture` pointed at
 * it. The page's real `getUserMedia` → ZXing decode → enroll transition then runs
 * with no physical camera. The platform-specific `.p12` cert install stays manual.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pairingPayload } from '../src/client/pairingPayload.js';
import { expect, test } from './coverage-fixture.js';
import { writeQrY4m } from './qrY4m.js';

// Generate the fake-camera Y4M at collection time — the file must exist on disk
// before the browser launches with `--use-file-for-fake-video-capture`.
const CAM_TOKEN = 'e2e-cam-token-1';
const CAM_URL = 'https://192.168.1.77:4174';
const Y4M_PATH = join(mkdtempSync(join(tmpdir(), 'hs-pair-cam-')), 'qr.y4m');
writeQrY4m(pairingPayload(CAM_TOKEN, CAM_URL), Y4M_PATH);

test.use({
  permissions: ['camera'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${Y4M_PATH}`,
    ],
  },
});

test('/pair: in-page camera scan decodes the QR via ZXing → enroll step (HS-9097)', async ({ page }) => {
  await page.goto('/pair');
  await expect(page.locator('#pair-root')).toBeVisible();

  // With a camera available (the fake device), the scan button is offered.
  const scanBtn = page.locator('#pair-scan-btn');
  await expect(scanBtn).toBeVisible();
  await scanBtn.click();

  // ZXing opens the fake camera, decodes the looped QR frame, and the page
  // advances to the enroll step echoing the URL encoded in the QR — proving the
  // full getUserMedia → decode → parse → renderEnroll path ran for real.
  await expect(page.locator('.pair-step-enroll')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.pair-url')).toHaveText(CAM_URL);
});
