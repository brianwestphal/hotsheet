/**
 * HS-8781 — "Verbally announce permission checks" preference.
 *
 * Mirrors `announcerSpeechRate.ts`: a synchronously-cached read of a single
 * global-config field so the permission-popup path can decide whether to speak
 * without awaiting an HTTP fetch. It's a *global* listening preference (not
 * project-specific) and is **on by default** — `undefined` in the stored config
 * means enabled, so a fresh install narrates permission checks out of the box.
 */
import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';

const DEFAULT_ENABLED = true;

// Start at the default; `loadAnnouncerSpeakPermissions()` hydrates the real
// value at boot. Tracked separately so the permission path reads synchronously.
let enabled = DEFAULT_ENABLED;

/** Cached read — synchronous so the permission-popup path needs no await. */
export function getAnnouncerSpeakPermissions(): boolean {
  return enabled;
}

/** Fetch from `/api/global-config` into the cache. Best-effort; default ON. */
export async function loadAnnouncerSpeakPermissions(): Promise<void> {
  try {
    const cfg = await getGlobalConfig();
    // Default ON: only an explicit `false` disables it.
    enabled = cfg.announcerSpeakPermissions !== false;
  } catch { /* keep cached value */ }
}

/** Persist + update the cache so the next permission check honors the choice. */
export async function setAnnouncerSpeakPermissions(value: boolean): Promise<void> {
  enabled = value;
  await updateGlobalConfig({ announcerSpeakPermissions: value });
}

/** **TEST ONLY** — set the cache without round-tripping the API. */
export function _setAnnouncerSpeakPermissionsForTesting(value: boolean): void {
  enabled = value;
}
