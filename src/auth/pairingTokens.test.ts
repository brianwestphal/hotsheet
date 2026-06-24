/**
 * HS-8996 — pairing-token store: single-use, short-TTL, per-project, with an
 * injected clock for the expiry cases.
 */
import { describe, expect, it } from 'vitest';

import { PAIRING_TOKEN_TTL_MS, PairingTokenStore } from './pairingTokens.js';

function storeAt(start = 1_000): { store: PairingTokenStore; advance: (ms: number) => void } {
  let now = start;
  const store = new PairingTokenStore(() => now);
  return { store, advance: (ms: number) => { now += ms; } };
}

describe('PairingTokenStore', () => {
  it('issues a token bound to a project with a TTL-based expiry', () => {
    const { store } = storeAt(1_000);
    const { token, expiresAt } = store.issue('/proj/.hotsheet');
    expect(token).toBeTruthy();
    expect(expiresAt).toBe(1_000 + PAIRING_TOKEN_TTL_MS);
  });

  it('consumes a valid token once (single-use) and returns its data dir', () => {
    const { store } = storeAt();
    const { token } = store.issue('/proj/.hotsheet');
    expect(store.consume(token)).toEqual({ dataDir: '/proj/.hotsheet' });
    expect(store.consume(token)).toBeNull(); // replay rejected
  });

  it('rejects an unknown token', () => {
    const { store } = storeAt();
    expect(store.consume('nope')).toBeNull();
  });

  it('rejects (and removes) an expired token', () => {
    const { store, advance } = storeAt(1_000);
    const { token } = store.issue('/proj/.hotsheet');
    advance(PAIRING_TOKEN_TTL_MS + 1);
    expect(store.consume(token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('keeps tokens distinct per project', () => {
    const { store } = storeAt();
    const a = store.issue('/a/.hotsheet');
    const b = store.issue('/b/.hotsheet');
    expect(store.consume(a.token)).toEqual({ dataDir: '/a/.hotsheet' });
    expect(store.consume(b.token)).toEqual({ dataDir: '/b/.hotsheet' });
  });

  it('size() prunes expired tokens', () => {
    const { store, advance } = storeAt(0);
    store.issue('/a/.hotsheet');
    store.issue('/b/.hotsheet');
    expect(store.size()).toBe(2);
    advance(PAIRING_TOKEN_TTL_MS + 1);
    expect(store.size()).toBe(0);
  });
});
