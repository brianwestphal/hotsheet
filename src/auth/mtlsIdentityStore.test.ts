// HS-9314 — device mTLS identity keychain store (write/read/delete round-trip).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteMtlsIdentity, readMtlsIdentity, writeMtlsIdentity } from './mtlsIdentityStore.js';

// In-memory keychain keyed by `${pluginId}\0${key}`, so the round-trip is
// exercised without touching the real OS keychain.
const store = new Map<string, string>();
vi.mock('../keychain.js', () => ({
  keychainSet: vi.fn((pluginId: string, key: string, value: string) => {
    store.set(`${pluginId}\0${key}`, value);
    return Promise.resolve(true);
  }),
  keychainGet: vi.fn((pluginId: string, key: string) => Promise.resolve(store.get(`${pluginId}\0${key}`) ?? null)),
  keychainDelete: vi.fn((pluginId: string, key: string) => Promise.resolve(store.delete(`${pluginId}\0${key}`))),
}));

const ORIGIN = 'https://host:4174';
const IDENTITY = { cert: '-----CERT-----', key: '-----KEY-----', ca: '-----CA-----' };

describe('mtlsIdentityStore', () => {
  beforeEach(() => { store.clear(); });

  it('writes then reads the same identity back (round-trip)', async () => {
    expect(await writeMtlsIdentity(ORIGIN, IDENTITY)).toBe(true);
    expect(await readMtlsIdentity(ORIGIN)).toEqual(IDENTITY);
  });

  it('stores under the com.hotsheet.plugin.mtls / origin scheme the Rust reader expects', async () => {
    await writeMtlsIdentity(ORIGIN, IDENTITY);
    // account = origin; the raw value is the JSON blob mtls_keychain.rs parses.
    expect(store.get(`mtls\0${ORIGIN}`)).toBe(JSON.stringify(IDENTITY));
  });

  it('returns null for an absent origin', async () => {
    expect(await readMtlsIdentity('https://never:1')).toBeNull();
  });

  it('returns null for a malformed / incomplete stored blob', async () => {
    store.set(`mtls\0${ORIGIN}`, '{"cert":"c","key":"","ca":"a"}'); // empty key → schema rejects
    expect(await readMtlsIdentity(ORIGIN)).toBeNull();
    store.set(`mtls\0${ORIGIN}`, 'not json');
    expect(await readMtlsIdentity(ORIGIN)).toBeNull();
  });

  it('delete removes the stored identity', async () => {
    await writeMtlsIdentity(ORIGIN, IDENTITY);
    expect(await deleteMtlsIdentity(ORIGIN)).toBe(true);
    expect(await readMtlsIdentity(ORIGIN)).toBeNull();
  });
});
