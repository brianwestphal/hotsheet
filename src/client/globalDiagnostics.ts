/**
 * HS-8446 — global diagnostics opt-in.
 *
 * Single boolean stored in `~/.hotsheet/config.json` under `diagnosticsEnabled`
 * that gates both noisier diagnostic UI surfaces:
 *
 *  1. The slow-server banner (`serverBusyChip.tsx`, HS-8175 / HS-8226).
 *     Pre-fix the banner could fire during normal use whenever any HTTP
 *     request happened to cross the 3 s threshold — most users found
 *     this distracting rather than informative, since the banner is
 *     primarily useful when actively investigating event-loop blocks.
 *  2. The HS-8054 UI-hang toast (`longTaskObserver.tsx`). Pre-HS-8446
 *     this had its own per-project `diagnostics_freeze_toast_enabled`
 *     key; collapsed into the single global flag here so power users
 *     opt into "diagnostic UI" once per machine instead of per project.
 *
 * The freeze-log entries (`POST /api/diagnostics/freeze` →
 * `<dataDir>/freeze.log`) continue to fire regardless of this flag —
 * the gate only suppresses the in-window UI surfaces. That way a user
 * who notices a hang AFTER it happened can still grep `freeze.log`
 * for the entry.
 *
 * The cached value is loaded once at app boot (`app.tsx::loadInitialState`)
 * and updated by the Settings → Experimental → Diagnostics checkbox
 * (`settingsDialog.tsx`). Reads are synchronous so the per-tick gate in
 * `serverBusyChip.setBannerVisible` doesn't need to await anything.
 */
import { api } from './api.js';

let diagnosticsEnabled = false;
let loaded = false;

/** Read the cached value. Synchronous — callers (the slow-server banner
 *  state machine, the longtask observer) need a sync decision per tick. */
export function isDiagnosticsEnabled(): boolean {
  return diagnosticsEnabled;
}

/** Fetch the value from `/api/global-config` and update the cache.
 *  Best-effort — a network failure leaves the cached value unchanged
 *  (default `false` until the first successful load). */
export async function loadGlobalDiagnostics(): Promise<void> {
  try {
    const cfg = await api<{ diagnosticsEnabled?: boolean }>('/global-config');
    diagnosticsEnabled = cfg.diagnosticsEnabled === true;
    loaded = true;
  } catch { /* keep cached value */ }
}

/** Write the new value through to `/api/global-config` and update the
 *  cache so the gate flips synchronously on the next tick. Used by the
 *  Settings → Experimental → Diagnostics checkbox. */
export async function setDiagnosticsEnabled(value: boolean): Promise<void> {
  diagnosticsEnabled = value;
  loaded = true;
  await api('/global-config', { method: 'PATCH', body: { diagnosticsEnabled: value } });
}

/** **TEST ONLY** — set the cached value without round-tripping the API.
 *  Mirrors the `_reset…ForTesting` convention used elsewhere in client
 *  modules. */
export function _setDiagnosticsEnabledForTesting(value: boolean): void {
  diagnosticsEnabled = value;
  loaded = true;
}

/** **TEST ONLY** — has the value been loaded from the server at least once? */
export function _diagnosticsLoadedForTesting(): boolean {
  return loaded;
}
