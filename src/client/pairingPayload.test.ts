/**
 * HS-9026 — the QR pairing payload encodes the token + reachable URL the phone
 * needs (and trims the URL, since it comes from an operator-edited field).
 */
import { describe, expect, it } from 'vitest';

import { pairingPayload } from './pairingPayload.js';

describe('pairingPayload', () => {
  it('encodes a versioned, kind-tagged {token, url} JSON object', () => {
    const parsed: unknown = JSON.parse(pairingPayload('tok-123', 'https://192.168.1.50:4174'));
    expect(parsed).toEqual({ v: 1, kind: 'hotsheet-pair', token: 'tok-123', url: 'https://192.168.1.50:4174' });
  });

  it('trims surrounding whitespace from the operator-entered URL', () => {
    const parsed = JSON.parse(pairingPayload('t', '  https://host:4174  ')) as { url: string };
    expect(parsed.url).toBe('https://host:4174');
  });
});
