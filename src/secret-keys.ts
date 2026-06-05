/**
 * HS-8751 — global API-key registry. A single, machine-global list of named
 * secrets (Anthropic API keys, Google TTS keys, …) that every project can
 * choose from, instead of re-entering a key per project.
 *
 * Storage is split so secrets never touch config files or git:
 *   - **metadata** `{ id, type, name }` → `~/.hotsheet/config.json` under `keys`
 *     (via `global-config.ts`), so the list is shared across all projects.
 *   - **value** → the OS keychain (`keychain.ts`) under plugin id `keys`,
 *     account = the key's `id`.
 *
 * A project picks a key by id (e.g. the announcer's per-project
 * `announcer_ai_key_id` setting); `resolveKeyValueByType` falls back to the
 * first key of the requested type when no selection has been made. See
 * docs/79-api-keys.md.
 */
import { randomUUID } from 'crypto';

import { readGlobalConfig, writeGlobalConfig } from './global-config.js';
import { keychainDelete, keychainGet, keychainSet } from './keychain.js';
import type { KeyType, SecretKeyMeta } from './routes/validation.js';

/** Keychain plugin id the registry stores values under (`com.hotsheet.plugin.keys`). */
const KEYS_PLUGIN_ID = 'keys';

/** All key metadata (no values), in insertion order. */
export function listKeyMetas(): SecretKeyMeta[] {
  return readGlobalConfig().keys ?? [];
}

/** Create a key: generate an id, persist metadata + store the value in the
 *  keychain. Returns the new metadata (never the value). */
export async function createKey(type: KeyType, name: string, value: string): Promise<SecretKeyMeta> {
  const now = new Date().toISOString();
  const meta: SecretKeyMeta = { id: randomUUID(), type, name, created_at: now, updated_at: now };
  writeGlobalConfig({ keys: [...listKeyMetas(), meta] });
  await keychainSet(KEYS_PLUGIN_ID, meta.id, value);
  return meta;
}

/** Update a key's metadata (type/name) and, when a non-empty `value` is given,
 *  overwrite its keychain secret. A blank/omitted `value` leaves the secret
 *  untouched (the UI is write-only; it never round-trips the stored value).
 *  Returns the updated metadata, or null if no key has that id. */
export async function updateKey(
  id: string,
  updates: { type?: KeyType; name?: string; value?: string },
): Promise<SecretKeyMeta | null> {
  const keys = listKeyMetas();
  const idx = keys.findIndex(k => k.id === id);
  if (idx === -1) return null;

  const updated: SecretKeyMeta = {
    ...keys[idx],
    ...(updates.type !== undefined ? { type: updates.type } : {}),
    ...(updates.name !== undefined ? { name: updates.name } : {}),
    // HS-8760 — any edit (rename or value replacement) bumps the "Updated …" stamp.
    updated_at: new Date().toISOString(),
  };
  const next = [...keys];
  next[idx] = updated;
  writeGlobalConfig({ keys: next });

  if (updates.value !== undefined && updates.value !== '') {
    await keychainSet(KEYS_PLUGIN_ID, id, updates.value);
  }
  return updated;
}

/** Remove a key's metadata + its keychain secret. Returns false if unknown id. */
export async function deleteKey(id: string): Promise<boolean> {
  const keys = listKeyMetas();
  if (!keys.some(k => k.id === id)) return false;
  writeGlobalConfig({ keys: keys.filter(k => k.id !== id) });
  await keychainDelete(KEYS_PLUGIN_ID, id);
  return true;
}

/** The stored secret for a key id, or null if absent/unavailable. */
export async function getKeyValue(id: string): Promise<string | null> {
  return keychainGet(KEYS_PLUGIN_ID, id);
}

/**
 * Resolve a usable secret for `type`. Prefer `selectedId` when it names a key
 * of the right type; otherwise default to the **first** key of that type (the
 * "default to the first key of the corresponding type if no selection has been
 * made" rule). Returns the value + chosen metadata, or null when no key of the
 * type exists or its value can't be read.
 */
export async function resolveKeyValueByType(
  type: KeyType,
  selectedId?: string,
): Promise<{ value: string; meta: SecretKeyMeta } | null> {
  // The filter stays type-general even though `KeyType` is a single value today
  // (HS-8763 dropped Google TTS); re-adding a type is a one-line enum change and
  // this resolver should keep working unchanged.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const ofType = listKeyMetas().filter(k => k.type === type);
  if (ofType.length === 0) return null;
  const chosen = (selectedId !== undefined && ofType.find(k => k.id === selectedId)) || ofType[0];
  const value = await getKeyValue(chosen.id);
  return value === null ? null : { value, meta: chosen };
}
