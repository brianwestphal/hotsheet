// HS-9308 (docs/112 §112.6) — the reusable Hot Sheet pairing-QR camera scanner,
// extracted from the device `/pair` page (HS-9097) so both it and the "Add remote
// server" dialog share ONE `@zxing/browser` decode loop. Decodes QR frames until a
// valid `hotsheet-pair` payload (`{token, url}`) appears; ignores stray codes
// (Wi-Fi/URL QRs parse to null). Best-effort — any failure (no camera, permission
// denied) is surfaced via `onError` so the caller can fall back to manual entry.

import type { IScannerControls } from '@zxing/browser';
import { BrowserQRCodeReader } from '@zxing/browser';

import { toElement } from './dom.js';
import { type PairingPayload, parsePairingPayload } from './pairingPayload.js';

/** Whether this browser can open a camera at all. `@zxing/browser` is a pure-JS
 *  decoder (works in Firefox, older iOS, Android), so the only gate on an in-page
 *  scan is `getUserMedia`. */
export function canScanQr(): boolean {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return typeof md?.getUserMedia === 'function';
}

/** A running scan — call `stop()` to release the camera. */
export interface ScanHandle {
  stop: () => void;
}

/**
 * Start scanning `mountInto` for a Hot Sheet pairing QR. On the first valid
 * payload, `onPayload` fires and the camera stops. `onError` fires (once) if the
 * camera can't open. Returns a handle so the caller can stop early (dialog close).
 * Exposed shape mirrors the `/pair` page so the e2e fake-camera test (HS-9097)
 * pattern carries over.
 */
export function startPairingQrScan(
  mountInto: HTMLElement,
  onPayload: (payload: PairingPayload) => void,
  onError?: (message: string) => void,
): ScanHandle {
  const video = toElement(<video className="qr-scan-video" muted></video>) as unknown as HTMLVideoElement;
  video.playsInline = true; // inline playback on iOS (attribute casing varies; set the prop)
  video.muted = true;
  mountInto.replaceChildren(video);

  const reader = new BrowserQRCodeReader();
  // A holder object (not a bare `let`) so the post-stop guard isn't narrowed to a
  // constant — `done` is mutated across async decode callbacks.
  const scan: { done: boolean; controls: IScannerControls | null } = { done: false, controls: null };
  const stop = (): void => { scan.done = true; scan.controls?.stop(); };

  void (async () => {
    try {
      scan.controls = await reader.decodeFromConstraints(
        { video: { facingMode: 'environment' } },
        video,
        (result) => {
          if (scan.done || result === undefined) return; // most frames report no code — keep scanning
          const payload = parsePairingPayload(result.getText());
          if (payload !== null) { stop(); onPayload(payload); }
          // A non-Hot-Sheet QR (a Wi-Fi/URL code) parses to null — ignore + keep scanning.
        },
      );
      // The decoder may have stopped synchronously (payload found before this
      // resolves); honor that so we don't leave the camera running.
      if (scan.done) scan.controls.stop();
    } catch {
      onError?.('Camera unavailable or permission denied.');
    }
  })();

  return { stop };
}
