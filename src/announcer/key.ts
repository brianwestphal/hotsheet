/**
 * §78 Announcer (HS-8745) — AI API key resolution, mirroring the glassbox
 * env → keychain pattern. The key authenticates the server-side summarization
 * call. Stored in the OS keychain (§20) under the `announcer` plugin id; an
 * `ANTHROPIC_API_KEY` env var overrides for dev / CI. A config-file tier could
 * be added later; for now env + keychain cover desktop and CLI.
 */
import { keychainDelete, keychainGet, keychainSet } from '../keychain.js';

const PLUGIN_ID = 'announcer';
const KEY_ACCOUNT = 'anthropic_api_key';

/** Resolve the Anthropic API key: env var first, then the OS keychain. */
export async function resolveAnnouncerKey(): Promise<string | null> {
  const env = process.env.ANTHROPIC_API_KEY;
  if (env !== undefined && env !== '') return env;
  return keychainGet(PLUGIN_ID, KEY_ACCOUNT);
}

/** Store the Anthropic API key in the OS keychain. */
export async function setAnnouncerKey(value: string): Promise<boolean> {
  return keychainSet(PLUGIN_ID, KEY_ACCOUNT, value);
}

/** Remove the stored Anthropic API key from the keychain. */
export async function deleteAnnouncerKey(): Promise<boolean> {
  return keychainDelete(PLUGIN_ID, KEY_ACCOUNT);
}

/** Whether a key is resolvable (env or keychain) without revealing it. */
export async function hasAnnouncerKey(): Promise<boolean> {
  return (await resolveAnnouncerKey()) !== null;
}
