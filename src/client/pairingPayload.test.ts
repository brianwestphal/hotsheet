/**
 * HS-9026 — the QR pairing payload encodes the token + reachable URL the phone
 * needs (and trims the URL, since it comes from an operator-edited field).
 */
import { describe, expect, it } from 'vitest';

import { pairingPayload, parsePairingPayload } from './pairingPayload.js';

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

describe('parsePairingPayload (HS-9033 — the device end)', () => {
  it('round-trips an encoded payload (scan → parse)', () => {
    const parsed = parsePairingPayload(pairingPayload('tok-xyz', 'https://192.168.1.50:4174'));
    expect(parsed).toEqual({ v: 1, kind: 'hotsheet-pair', token: 'tok-xyz', url: 'https://192.168.1.50:4174' });
  });

  it('tolerates surrounding whitespace (a pasted code with trailing newline)', () => {
    expect(parsePairingPayload(`  ${pairingPayload('t', 'https://h:4174')}\n`)?.token).toBe('t');
  });

  it('returns null for non-JSON text', () => {
    expect(parsePairingPayload('not a code')).toBeNull();
    expect(parsePairingPayload('')).toBeNull();
  });

  it('returns null for a foreign QR (valid JSON, wrong kind/version)', () => {
    expect(parsePairingPayload(JSON.stringify({ v: 1, kind: 'wifi', token: 't', url: 'u' }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ v: 2, kind: 'hotsheet-pair', token: 't', url: 'u' }))).toBeNull();
  });

  it('returns null when token or url is missing/empty', () => {
    expect(parsePairingPayload(JSON.stringify({ v: 1, kind: 'hotsheet-pair', url: 'u' }))).toBeNull();
    expect(parsePairingPayload(JSON.stringify({ v: 1, kind: 'hotsheet-pair', token: '', url: 'u' }))).toBeNull();
  });
});
