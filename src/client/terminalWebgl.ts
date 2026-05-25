/**
 * HS-8488 — terminal renderer selection: WebGL (default) → DOM (fallback).
 *
 * xterm renders via the DOM renderer unless a renderer addon is loaded. We
 * load `@xterm/addon-webgl` by default for smoother output under heavy
 * activity (long `claude` sessions, full-screen TUIs, fast log spam), and fall
 * back to the DOM renderer when:
 *   - the user opts out (`terminalWebglOptOut` global setting, surfaced as the
 *     Settings → General "Use software rendering for terminals" checkbox),
 *   - WebGL2 isn't available (old browser / blacklisted GPU — `getContext`
 *     returns null or the addon constructor throws), or
 *   - WebGL is force-disabled (the e2e seam — see `isWebglForceDisabled`).
 * Canvas (`@xterm/addon-canvas`) is deliberately NOT an option: the DOM
 * renderer keeps the live `<span>`-per-cell tree intact for the planned
 * domotion-svg demo capture, which a single `<canvas>` can't provide.
 *
 * The opt-out lives in `~/.hotsheet/config.json` (global / machine-level, like
 * the CLI-tool + diagnostics settings — terminal rendering is a machine
 * preference, not per-project). Mirrors the `globalDiagnostics.ts`
 * cached-accessor pattern: hydrated once at app boot, read synchronously by
 * `terminalCheckout.tsx::createEntry`, updated by the Settings toggle.
 */
import { api } from './api.js';

let terminalWebglOptOut = false;

/** Synchronous read of the cached opt-out (createEntry needs a sync decision). */
export function isTerminalWebglOptOut(): boolean {
  return terminalWebglOptOut;
}

/** Hydrate the cached opt-out from `/api/global-config`. Best-effort — a
 *  network failure leaves the default (`false`, i.e. WebGL on). Called once at
 *  app boot alongside `loadGlobalDiagnostics`. */
export async function loadTerminalWebglOptOut(): Promise<void> {
  try {
    const cfg = await api<{ terminalWebglOptOut?: boolean }>('/global-config');
    terminalWebglOptOut = cfg.terminalWebglOptOut === true;
  } catch { /* keep cached value */ }
}

/** Write the new value through to `/api/global-config` and update the cache so
 *  the next `createEntry` sees it. Used by the Settings → General toggle.
 *  (Existing terminals keep their current renderer until re-created — noted in
 *  the §22 docs + the setting's helper text.) */
export async function setTerminalWebglOptOut(value: boolean): Promise<void> {
  terminalWebglOptOut = value;
  await api('/global-config', { method: 'PATCH', body: { terminalWebglOptOut: value } });
}

// HS-8488 — WebGL2 capability probe, cached (a canvas + getContext per call is
// wasteful, and the answer doesn't change within a session). Used by both the
// renderer decision below AND the Settings toggle's visibility gate (the row
// is hidden when WebGL2 is unavailable so the user isn't shown an inert
// toggle).
let webgl2Available: boolean | null = null;
export function isWebgl2Available(): boolean {
  if (webgl2Available !== null) return webgl2Available;
  try {
    const canvas = document.createElement('canvas');
    webgl2Available = canvas.getContext('webgl2') !== null;
  } catch {
    webgl2Available = false;
  }
  return webgl2Available;
}

/**
 * HS-8488 — e2e force-DOM seam. Headless Chromium ships SwiftShader WebGL2, so
 * without this the WebGL renderer would load under Playwright and leave
 * `.xterm-rows` (which the terminal e2e specs scrape, plus DOM-only assertions
 * like OSC 8 link hrefs + decoration glyphs that have no buffer-read
 * equivalent) unpopulated. The coverage fixture sets
 * `window.__HOTSHEET_DISABLE_WEBGL__ = true` via `addInitScript` so e2e stays
 * on the DOM renderer. Also doubles as a manual escape hatch.
 */
function isWebglForceDisabled(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { __HOTSHEET_DISABLE_WEBGL__?: boolean }).__HOTSHEET_DISABLE_WEBGL__ === true;
}

/**
 * HS-8488 — should a freshly-created terminal load the WebGL renderer addon?
 * WebGL is the default; this returns false (→ DOM renderer) when force-disabled
 * (e2e), the user opted out, or WebGL2 isn't available. The addon constructor
 * can still throw on a blacklisted GPU even when this returns true — the caller
 * catches that and falls back to DOM. Pure-ish (reads the cached opt-out + the
 * cached capability probe); no addon side effects.
 */
export function shouldUseWebglRenderer(): boolean {
  if (isWebglForceDisabled()) return false;
  if (isTerminalWebglOptOut()) return false;
  return isWebgl2Available();
}

/**
 * HS-8619 — per-consumer renderer decision for the §54 terminal checkout.
 * `webglDesired` is the entry-level static gate (`shouldUseWebglRenderer()`
 * captured at creation); `scaled` is the current top-of-stack consumer's flag
 * (true for the §25 dashboard / §36 drawer-grid tiles + magnified overlay,
 * which CSS-`transform: scale(...)` the xterm). WebGL renders to a
 * fixed-resolution `<canvas>` that raster-scales badly under a CSS transform,
 * so a scaled consumer must use the DOM renderer. Returns true only when WebGL
 * is desired AND the consumer is not scaled. Pure — the single guard that
 * keeps WebGL out of CSS-scaled tile contexts.
 */
export function webglWantedForConsumer(webglDesired: boolean, scaled: boolean): boolean {
  return webglDesired && !scaled;
}

/** **TEST ONLY** — set the cached opt-out without round-tripping the API. */
export function _setTerminalWebglOptOutForTesting(value: boolean): void {
  terminalWebglOptOut = value;
}

/** **TEST ONLY** — force the cached WebGL2-availability probe result (or
 *  `null` to re-probe on next read). */
export function _setWebgl2AvailableForTesting(value: boolean | null): void {
  webgl2Available = value;
}
