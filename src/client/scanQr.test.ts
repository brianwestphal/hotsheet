// @vitest-environment happy-dom
// HS-9308 — the camera-availability gate for the shared QR scanner (docs/112 §112.6).
// The @zxing decode loop needs a real camera (covered by the HS-9097 e2e
// fake-camera pattern); `canScanQr` — the only gate on showing the "Scan QR"
// button — is unit-testable.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { canScanQr } from './scanQr.js';

describe('canScanQr', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('true when navigator.mediaDevices.getUserMedia exists', () => {
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: () => Promise.resolve({}) } });
    expect(canScanQr()).toBe(true);
  });

  it('false when mediaDevices is absent (older/locked-down browsers)', () => {
    vi.stubGlobal('navigator', {});
    expect(canScanQr()).toBe(false);
  });

  it('false when getUserMedia is not a function', () => {
    vi.stubGlobal('navigator', { mediaDevices: {} });
    expect(canScanQr()).toBe(false);
  });
});
