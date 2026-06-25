/**
 * HS-9026 — the QR payload the desktop encodes and the phone parses for mTLS
 * device pairing (docs/94 §94.4.2 Phase 2). Standalone + pure so the encoding is
 * unit-testable without the DOM / api import graph that `devicesPairing.tsx`
 * pulls in. The phone reads `token` + `url`, generates a keypair + CSR, and POSTs
 * `{ token, csrPem, label }` to `/api/auth/pair/complete`.
 */
export function pairingPayload(token: string, url: string): string {
  return JSON.stringify({ v: 1, kind: 'hotsheet-pair', token, url: url.trim() });
}
