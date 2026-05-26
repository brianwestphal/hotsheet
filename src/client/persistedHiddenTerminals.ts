/**
 * HS-7825 / HS-7826 / HS-8290 — persistence layer for visibility groupings.
 * See docs/39-visibility-groupings.md.
 *
 * Wraps the in-memory module (`dashboardHiddenTerminals.ts`) so the rest of
 * the codebase can keep using its public API verbatim. The persistence
 * layer subscribes to changes and fires a single debounced PATCH to the
 * global config endpoint (`/api/global-config`) under
 * `dashboard.visibilityGroupings` + `dashboard.activeVisibilityGroupingId`.
 *
 * **HS-8290 reshape.** Pre-HS-8290 each project had its own copy of the
 * groupings stored under `visibility_groupings` in
 * `.hotsheet/settings.json`, so this module ran a per-project debounce
 * loop. Post-HS-8290 there is exactly one source of truth in
 * `~/.hotsheet/config.json`; this module's debounce is a single global
 * timer.
 *
 * Dynamic terminals (`dyn-*` ids) are intentionally NOT persisted — their
 * lifetime is per-session.
 */

import { getGlobalConfig, updateGlobalConfig } from '../api/index.js';
import type { GlobalConfig } from '../global-config.js';
import {
  getGlobalVisibilityState,
  hydratePersistedGlobalState,
  isConfiguredTerminalId,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import {
  DASHBOARD_SCOPE,
  DEFAULT_GROUPING_ID,
  parsePersistedState,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersisted: string | null = null;

const DEBOUNCE_MS = 250;

let subscriptionUnsub: (() => void) | null = null;
let pagehideRegistered = false;

/**
 * Sanitise + sort each grouping's hidden ids so the serialised payload is
 * byte-stable when the user's effective state hasn't changed (no-op
 * writes short-circuit). Drops dynamic terminal ids and empty
 * per-project entries.
 */
export function computePersistedGroupings(groupings: readonly VisibilityGrouping[]): VisibilityGrouping[] {
  return groupings.map(g => {
    const hiddenByProject: Record<string, string[]> = {};
    for (const [secret, ids] of Object.entries(g.hiddenByProject)) {
      const filtered = ids.filter(isConfiguredTerminalId).sort();
      if (filtered.length > 0) hiddenByProject[secret] = filtered;
    }
    return { id: g.id, name: g.name, hiddenByProject };
  });
}

function scheduleWrite(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeNow();
  }, DEBOUNCE_MS);
}

async function writeNow(): Promise<void> {
  const state = getGlobalVisibilityState();
  const persistedGroupings = computePersistedGroupings(state.groupings);
  // HS-8434 — type the PATCH body against the shared schema so a key
  // added here without a matching schema entry is a compile error. This
  // is exactly the gate HS-8424 needed: HS-8406 added
  // `activeVisibilityGroupingIdByScope` to this literal but the server
  // `DashboardConfigSchema` was untouched, so every PATCH 400'd silently.
  const payload: Partial<GlobalConfig> = {
    dashboard: {
      visibilityGroupings: persistedGroupings,
      // HS-8406 — per-scope active grouping selections (`'dashboard'`
      // for the §25 dashboard, `'project:<secret>'` for each project's
      // §36 drawer-grid). Pre-fix the persisted shape was a single
      // scalar `activeVisibilityGroupingId`; `parsePersistedState`
      // migrates legacy payloads into the dashboard scope, and we keep
      // writing the scalar form alongside the new map for one release
      // so a downgrade-then-upgrade flow doesn't lose the dashboard's
      // pick.
      activeVisibilityGroupingIdByScope: state.activeIdByScope,
      activeVisibilityGroupingId: state.activeIdByScope[DASHBOARD_SCOPE] ?? DEFAULT_GROUPING_ID,
    },
  };
  const serialised = JSON.stringify(payload);
  if (lastPersisted === serialised) return;
  lastPersisted = serialised;
  try {
    await updateGlobalConfig(payload);
  } catch {
    // Best-effort. The change is still in memory; next toggle will
    // schedule another write attempt.
  }
}

/**
 * Initialise the persistence layer: fetch the global dashboard config to
 * seed in-memory state, then subscribe to subsequent changes to write
 * them back.
 *
 * **HS-8293** — idempotent in the strict sense: once the subscription
 * is wired the function bails immediately and does NOT re-fetch /
 * re-hydrate. Pre-fix, `refreshProjectTabs` (called on every poll
 * cycle) re-ran this function and the hydrate clobbered in-memory
 * toggles the user had just made, which then short-circuited the
 * pending debounced PATCH because `lastPersisted` already matched the
 * post-hydrate state. Initial state belongs to whichever caller wins
 * the race; subsequent callers must not stomp on live in-memory edits.
 */
export async function initPersistedHiddenTerminals(): Promise<void> {
  if (subscriptionUnsub !== null) return;
  try {
    const cfg = await getGlobalConfig();
    const dashboard = cfg.dashboard ?? {};
    const state = parsePersistedState(
      dashboard.visibilityGroupings,
      dashboard.activeVisibilityGroupingId,
      dashboard.activeVisibilityGroupingIdByScope,
    );
    hydratePersistedGlobalState(state);
    // Stash the canonical serialised value so the first change-driven
    // PATCH doesn't immediately re-write the same payload.
    const persistedGroupings = computePersistedGroupings(state.groupings);
    lastPersisted = JSON.stringify({
      dashboard: {
        visibilityGroupings: persistedGroupings,
        activeVisibilityGroupingIdByScope: state.activeIdByScope,
        activeVisibilityGroupingId: state.activeIdByScope[DASHBOARD_SCOPE] ?? DEFAULT_GROUPING_ID,
      },
    });
  } catch {
    // Network / older server — leave the in-memory state alone.
  }

  subscriptionUnsub = subscribeToHiddenChanges(() => {
    scheduleWrite();
  });
  registerPageHideFlushOnce();
}

/**
 * HS-8424 — best-effort flush on `pagehide`. Pre-fix a 250 ms debounce
 * + no unload-safe flush meant a visibility toggle made within ~250 ms
 * of quitting Hot Sheet (Cmd+Q from the keyboard, traffic-light close,
 * Tauri's auto-relaunch on update install) silently dropped: the
 * `setTimeout` was cleared by the WebView teardown before its
 * `writeNow()` ran, and the user's next launch reverted to the
 * pre-toggle state.
 *
 * `fetch(..., { keepalive: true })` is the modern unload-safe primitive
 * — unlike `navigator.sendBeacon` it supports PATCH (the `/global-config`
 * endpoint is PATCH-only). The browser dispatches the request to the
 * network stack synchronously and lets it complete after the page
 * unloads. 64 KB body cap; the visibility-groupings payload is
 * comfortably under that.
 *
 * Idempotent registration — the listener is only attached once per
 * module instance. `_resetForTests` does NOT remove the listener
 * (happy-dom cleans up the window between test files); the
 * `pagehideRegistered` flag short-circuits any re-registration if
 * tests re-init within the same window.
 */
function registerPageHideFlushOnce(): void {
  if (pagehideRegistered) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('pagehide', () => {
    flushPendingViaKeepalive();
  });
  pagehideRegistered = true;
}

/**
 * HS-8424 — synchronously dispatch the pending debounced write via
 * `fetch(..., { keepalive: true })` so the WebView's teardown doesn't
 * abort it. No-op when no write is pending (`writeTimer === null`).
 * Mirrors `writeNow()`'s payload exactly; updates `lastPersisted` so a
 * subsequent normal `writeNow()` short-circuits on the same payload.
 *
 * Exported for the unit test.
 */
export function flushPendingViaKeepalive(): void {
  if (writeTimer === null) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  const state = getGlobalVisibilityState();
  const persistedGroupings = computePersistedGroupings(state.groupings);
  // HS-8434 — see writeNow() comment.
  const payload: Partial<GlobalConfig> = {
    dashboard: {
      visibilityGroupings: persistedGroupings,
      activeVisibilityGroupingIdByScope: state.activeIdByScope,
      activeVisibilityGroupingId: state.activeIdByScope[DASHBOARD_SCOPE] ?? DEFAULT_GROUPING_ID,
    },
  };
  const serialised = JSON.stringify(payload);
  if (lastPersisted === serialised) return;
  lastPersisted = serialised;
  try {
    void fetch('/api/global-config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: serialised,
      keepalive: true,
    });
  } catch { /* swallow — best-effort unload flush */ }
}

/** Test-only — flush the pending debounced write synchronously. */
export function _flushForTests(): void {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
    void writeNow();
  }
}

/** Test-only — drop cached state so a fresh init starts clean. */
export function _resetForTests(): void {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = null;
  lastPersisted = null;
  if (subscriptionUnsub !== null) {
    subscriptionUnsub();
    subscriptionUnsub = null;
  }
}

export { DEFAULT_GROUPING_ID };
