/**
 * HS-9026 / HS-9033 — the QR payload the desktop encodes and the phone parses for
 * mTLS device pairing (docs/94 §94.4.2 Phase 2). Standalone + pure so the
 * encoding round-trip is unit-testable without the DOM / api import graph that
 * `devicesPairing.tsx` / the device page pull in. The phone reads `token` + `url`,
 * generates a keypair + CSR, and POSTs `{ token, csrPem, label }` to
 * `/api/auth/pair/complete`.
 */
import { z } from 'zod';

/** The decoded QR payload shape. `kind`/`v` pin the payload so a stray QR (a
 *  Wi-Fi/URL code) is rejected rather than half-parsed. */
export const PairingPayloadSchema = z.object({
  v: z.literal(1),
  kind: z.literal('hotsheet-pair'),
  token: z.string().min(1),
  url: z.string().min(1),
});
export type PairingPayload = z.infer<typeof PairingPayloadSchema>;

export function pairingPayload(token: string, url: string): string {
  return JSON.stringify({ v: 1, kind: 'hotsheet-pair', token, url: url.trim() });
}

/**
 * Parse + validate a scanned/pasted QR payload. Returns the typed payload, or
 * null when the text isn't JSON or isn't a Hot Sheet pairing code (wrong
 * `kind`/`v`, missing token/url). Never throws — the caller shows a friendly
 * "that's not a Hot Sheet pairing code" message on null.
 */
export function parsePairingPayload(text: string): PairingPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const parsed = PairingPayloadSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
