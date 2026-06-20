/**
 * §78 Announcer — the **Apple Foundation Models** provider, backed by the
 * `apple-fm` npm package (HS-8907, replacing the previously hand-maintained
 * Swift helper at `src-tauri/apple-fm-helper/main.swift`).
 *
 * `apple-fm` bundles a signed + notarized Swift helper that wraps Apple's
 * on-device `FoundationModels` and exposes a small Node API: `probe()` reports
 * availability and `generate({system, prompt, schema})` runs one generation with
 * **guided/structured output** that's guaranteed to conform to a JSON Schema
 * (the on-device equivalent of the Anthropic path's `output_config`). The server
 * calls it directly, so on-device narration works in BOTH the manual "Listen"
 * path and the live-mode generator (no client round-trip).
 *
 * Helper resolution is `apple-fm`'s concern: `APPLE_FM_BIN`, then its bundled
 * `bin/apple-fm-helper`, then `PATH`. In dev that's found in `node_modules`
 * automatically (no build step); the Tauri build copies the bundled helper into
 * the app and points `APPLE_FM_BIN` at it (see docs/tauri-architecture.md).
 * Off-platform (non-macOS / not Apple Silicon / Apple Intelligence off),
 * `probe()` reports unavailable and the caller falls back to Anthropic / local.
 * Everything here is pure Node and unit-tested with injected `probe`/`generate`.
 */
import { generate as realGenerate, probe as realProbe } from 'apple-fm';

/** The `apple-fm` surface this module uses — injectable so the helper is never
 *  spawned in tests and the availability matrix is testable on Linux CI. */
export type AppleProbe = typeof realProbe;
export type AppleGenerate = typeof realGenerate;

let probeFn: AppleProbe = realProbe;
let generateFn: AppleGenerate = realGenerate;
/** Cached availability — the OS-model state changes rarely within a session. */
let availabilityCache: boolean | null = null;

/**
 * HS-8909 — bound how long a single on-device generation may run before we give
 * up and let the caller's fallback take over. Apple's on-device model has a tiny
 * ~4096-token context window; when the announcer's system prompt + guided-output
 * schema + material exceed it, FoundationModels still **prefills the whole
 * oversized context before erroring**, so the `contextWindowExceeded` failure
 * takes ~70 s (measured on macOS 26.5 / M-series) — whereas a request that fits
 * returns in ~10–18 s. The token cost is dominated by the injected guided-output
 * schema, which `apple-fm`'s char/4 `estimateTokens` can't see, so a pre-flight
 * token check would be unreliable. A wall-clock cap is schema-agnostic and robust:
 * it lets real successes through with headroom and turns the ~70 s doomed-call
 * wait into a fast(er) failure that the HS-8805/8891 fallback picks up. 30 s ≈
 * 1.7× the slowest observed success. The default `apple-fm` timeout is 120 s.
 */
export const APPLE_GENERATE_TIMEOUT_MS = 30_000;

/**
 * Whether on-device Apple Foundation Models can be used right now: `apple-fm`'s
 * `probe()` checks the platform (macOS on Apple Silicon), that Apple Intelligence
 * is enabled, and that the model is downloaded. A probe failure (helper missing /
 * spawn error) counts as unavailable. Cached after the first check.
 */
export async function isAppleFoundationAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;
  availabilityCache = await probeAvailability();
  return availabilityCache;
}

async function probeAvailability(): Promise<boolean> {
  try {
    return (await probeFn()).available;
  } catch {
    // Off-platform `probe()` resolves `{available:false}` rather than throwing;
    // a throw here would be an unexpected helper/spawn failure → unavailable.
    return false;
  }
}

/**
 * Run one on-device summarization via guided generation. `schema` is the
 * `{entries:[…]}` JSON Schema the caller also enforces on the Anthropic path; the
 * returned string is the guaranteed-conforming JSON, which the caller validates
 * with the shared zod schema (the same way it validates the Anthropic output).
 * Rejects (propagating `apple-fm`'s error) when the on-device run fails — the
 * caller's fallback (HS-8805 / HS-8891) handles it.
 */
export async function runAppleFoundationSummarize(system: string, material: string, schema: unknown): Promise<string> {
  // HS-8909 — cap the call so an over-context request fails fast (and falls back)
  // instead of prefilling a doomed oversized context for ~70 s.
  return generateFn({ system, prompt: material, schema }, { timeoutMs: APPLE_GENERATE_TIMEOUT_MS });
}

/** **TEST ONLY** — inject fake `apple-fm` `probe` / `generate` implementations. */
export function _setAppleFoundationForTesting(opts: { probe?: AppleProbe; generate?: AppleGenerate }): void {
  if (opts.probe !== undefined) probeFn = opts.probe;
  if (opts.generate !== undefined) generateFn = opts.generate;
  availabilityCache = null;
}

/** **TEST ONLY** — clear the availability cache + restore real `apple-fm` wiring. */
export function _resetAppleFoundationForTesting(): void {
  probeFn = realProbe;
  generateFn = realGenerate;
  availabilityCache = null;
}
