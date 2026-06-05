/**
 * HS-8751 — global API-key registry. Metadata round-trips through a temp
 * `~/.hotsheet/config.json` (real `global-config.ts` fs path, via a mocked
 * `homedir`); the secret value goes through an in-memory keychain stub.
 */
import { rmSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tempHome = join(os.tmpdir(), `hs-secret-keys-test-${process.pid}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

// In-memory keychain so no real OS keychain is touched.
const store = new Map<string, string>();
vi.mock('./keychain.js', () => ({
  keychainSet: vi.fn((plugin: string, account: string, value: string) => { store.set(`${plugin}/${account}`, value); return Promise.resolve(true); }),
  keychainGet: vi.fn((plugin: string, account: string) => Promise.resolve(store.get(`${plugin}/${account}`) ?? null)),
  keychainDelete: vi.fn((plugin: string, account: string) => { store.delete(`${plugin}/${account}`); return Promise.resolve(true); }),
}));

const {
  createKey, deleteKey, getKeyValue, listKeyMetas, resolveKeyValueByType, updateKey,
} = await import('./secret-keys.js');

beforeEach(() => {
  store.clear();
  try { rmSync(join(tempHome, '.hotsheet'), { recursive: true, force: true }); } catch { /* ignore */ }
});
afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('secret-keys registry (HS-8751)', () => {
  it('create persists metadata (no value) + stores the value in the keychain', async () => {
    const meta = await createKey('anthropic_api_key', 'Personal', 'sk-ant-123');
    expect(meta).toMatchObject({ type: 'anthropic_api_key', name: 'Personal' });
    expect(meta.id).toBeTruthy();

    // Metadata is in the config; the value is NOT.
    const metas = listKeyMetas();
    expect(metas).toHaveLength(1);
    expect(JSON.stringify(metas)).not.toContain('sk-ant-123');
    expect(await getKeyValue(meta.id)).toBe('sk-ant-123');
  });

  it('update renames / retypes; a blank value leaves the secret untouched', async () => {
    const meta = await createKey('anthropic_api_key', 'Old', 'sk-old');
    const updated = await updateKey(meta.id, { name: 'New', value: '' });
    expect(updated?.name).toBe('New');
    expect(await getKeyValue(meta.id)).toBe('sk-old'); // unchanged

    await updateKey(meta.id, { value: 'sk-new' });
    expect(await getKeyValue(meta.id)).toBe('sk-new');

    expect(await updateKey('no-such-id', { name: 'x' })).toBeNull();
  });

  it('delete removes both metadata and the keychain secret', async () => {
    const meta = await createKey('anthropic_api_key', 'Personal', 'sk-123');
    expect(await deleteKey(meta.id)).toBe(true);
    expect(listKeyMetas()).toHaveLength(0);
    expect(await getKeyValue(meta.id)).toBeNull();
    expect(await deleteKey(meta.id)).toBe(false); // already gone
  });

  it('resolveKeyValueByType: defaults to the first key of the type', async () => {
    const first = await createKey('anthropic_api_key', 'First', 'sk-first');
    await createKey('anthropic_api_key', 'Second', 'sk-second');

    const resolved = await resolveKeyValueByType('anthropic_api_key');
    expect(resolved?.value).toBe('sk-first');
    expect(resolved?.meta.id).toBe(first.id);
  });

  it('resolveKeyValueByType: honors a valid selection, falls back when it is gone', async () => {
    await createKey('anthropic_api_key', 'First', 'sk-first');
    const second = await createKey('anthropic_api_key', 'Second', 'sk-second');

    expect((await resolveKeyValueByType('anthropic_api_key', second.id))?.value).toBe('sk-second');
    // Unknown id → fall back to first of type.
    expect((await resolveKeyValueByType('anthropic_api_key', 'bogus'))?.value).toBe('sk-first');
  });

  it('resolveKeyValueByType: null when no key of the type exists', async () => {
    expect(await resolveKeyValueByType('anthropic_api_key')).toBeNull();
  });

  // HS-8760 — provenance timestamps for the API Keys row label.
  it('stamps created_at on create and bumps updated_at on every update', async () => {
    const meta = await createKey('anthropic_api_key', 'Personal', 'sk-1');
    expect(meta.created_at).toBeTruthy();
    expect(meta.updated_at).toBe(meta.created_at); // equal at creation

    const renamed = await updateKey(meta.id, { name: 'Work' });
    expect(renamed?.created_at).toBe(meta.created_at); // creation stamp preserved
    expect(renamed?.updated_at).toBeTruthy();
    // updated_at moves forward (or stays equal within the same millisecond) and
    // is never before the creation stamp.
    expect(new Date(renamed!.updated_at!).getTime()).toBeGreaterThanOrEqual(new Date(meta.created_at!).getTime());
  });
});
