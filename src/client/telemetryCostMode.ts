/**
 * HS-8497 — billing model for telemetry cost display.
 *
 * Mirrors the `src/client/globalDiagnostics.ts` pattern: synchronous
 * cached read of a single global-config field so per-tick cost-display
 * decisions (the per-tab cost chip, the drawer banner, the dashboard
 * banner) don't have to await an HTTP fetch.
 *
 * The field is stored globally in `~/.hotsheet/config.json` under
 * `telemetryCostMode` because the user's billing relationship with
 * Anthropic is identity-level, not per-project.
 *
 * - `'api'` (default) — the OpenTelemetry `claude_code.cost.usage`
 *   metric reflects the real pay-per-token API cost the user is
 *   charged. The cost UI shows dollar amounts unchanged.
 * - `'subscription'` — the user is on Claude Pro/Max (flat monthly
 *   fee). The metric value is an API-equivalent estimate, not an
 *   amount the user actually pays. The per-tab cost chip is hidden;
 *   the drawer + dashboard surface a clarifying notice.
 */
import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';

type CostMode = 'api' | 'subscription';

let costMode: CostMode = 'api';
let loaded = false;

/** Read the cached value. Synchronous — callers (the per-tab cost
 *  chip render path) need a sync decision per tick. */
export function getTelemetryCostMode(): CostMode {
  return costMode;
}

/** Fetch the value from `/api/global-config` and update the cache.
 *  Best-effort — a network failure leaves the cached value unchanged
 *  (default `'api'` until the first successful load). */
export async function loadTelemetryCostMode(): Promise<void> {
  try {
    const cfg = await getGlobalConfig();
    costMode = cfg.telemetryCostMode === 'subscription' ? 'subscription' : 'api';
    loaded = true;
  } catch { /* keep cached value */ }
}

/** Write the new value through to `/api/global-config` and update
 *  the cache so the gate flips synchronously on the next tick. Used
 *  by the Settings → Telemetry → Billing-model select. */
export async function setTelemetryCostMode(value: CostMode): Promise<void> {
  costMode = value;
  loaded = true;
  await updateGlobalConfig({ telemetryCostMode: value });
}

/** **TEST ONLY** — set the cached value without round-tripping the API. */
export function _setTelemetryCostModeForTesting(value: CostMode): void {
  costMode = value;
  loaded = true;
}

/** **TEST ONLY** — has the value been loaded from the server at least once? */
export function _telemetryCostModeLoadedForTesting(): boolean {
  return loaded;
}
