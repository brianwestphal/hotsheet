/**
 * HS-8754 — Announcer playback speed (rate multiplier, 1 = normal).
 *
 * Mirrors `telemetryCostMode.ts`: a synchronously-cached read of a single
 * global-config field so the TTS path can pick up the rate without awaiting an
 * HTTP fetch. It's a *global* setting (a listening preference, not
 * project-specific) and is also adjustable live from the PIP — both the PIP's
 * speed control and the Settings → Experimental → Announcer control write here.
 */
import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';

/** Allowed speed range; the UI offers discrete steps within it. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const DEFAULT_RATE = 1;

/** Discrete steps offered by the UI selectors. */
export const RATE_STEPS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;

let rate = DEFAULT_RATE;

/** Clamp an arbitrary number into the supported range. */
export function clampRate(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATE;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, value));
}

/** Cached read — synchronous so the player/TTS path needs no await. */
export function getAnnouncerSpeechRate(): number {
  return rate;
}

/** Fetch from `/api/global-config` into the cache. Best-effort. */
export async function loadAnnouncerSpeechRate(): Promise<void> {
  try {
    const cfg = await getGlobalConfig();
    if (typeof cfg.announcerSpeechRate === 'number') rate = clampRate(cfg.announcerSpeechRate);
  } catch { /* keep cached value */ }
}

/** Persist + update the cache so the next utterance uses the new rate. */
export async function setAnnouncerSpeechRate(value: number): Promise<void> {
  rate = clampRate(value);
  document.dispatchEvent(new CustomEvent('hotsheet:announcer-rate-changed'));
  await updateGlobalConfig({ announcerSpeechRate: rate });
}

/** **TEST ONLY** — set the cache without round-tripping the API. */
export function _setAnnouncerSpeechRateForTesting(value: number): void {
  rate = clampRate(value);
}
