/**
 * §78 Announcer — AI API key resolution.
 *
 * HS-8751: the key is no longer stored per-project under the `announcer`
 * keychain id. Instead each project *selects* a named key from the global
 * registry (`src/secret-keys.ts`) via the per-project `announcer_ai_key_id`
 * setting; with no selection it defaults to the first `anthropic_api_key` in
 * the registry. An `ANTHROPIC_API_KEY` env var still overrides everything for
 * dev / CI. See docs/79-api-keys.md.
 */
import { getSettings, updateSetting } from '../db/queries.js';
import { resolveKeyValueByType } from '../secret-keys.js';

/** Per-project setting naming which registry key (by id) this project uses. */
export const ANNOUNCER_KEY_ID_SETTING = 'announcer_ai_key_id';

async function selectedKeyId(): Promise<string | undefined> {
  // Record<string,string> index → string; empty string (or a missing key at
  // runtime) means "no selection", so fall through to the type default.
  const id = (await getSettings())[ANNOUNCER_KEY_ID_SETTING];
  return id ? id : undefined;
}

/** Resolve the Anthropic API key: env var first, then the project's selected
 *  registry key (or the first Anthropic key if none is selected). */
export async function resolveAnnouncerKey(): Promise<string | null> {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env !== undefined && env !== '') return env;
  const resolved = await resolveKeyValueByType('anthropic_api_key', await selectedKeyId());
  return resolved === null ? null : resolved.value;
}

/** Whether a key is resolvable (env or a selected/default registry key). */
export async function hasAnnouncerKey(): Promise<boolean> {
  return (await resolveAnnouncerKey()) !== null;
}

/** The currently-selected registry key id for this project (null = use default). */
export async function getAnnouncerKeyId(): Promise<string | null> {
  return (await selectedKeyId()) ?? null;
}

/** Set (or clear, with null) the project's selected registry key id. */
export async function setAnnouncerKeyId(keyId: string | null): Promise<void> {
  await updateSetting(ANNOUNCER_KEY_ID_SETTING, keyId ?? '');
}
