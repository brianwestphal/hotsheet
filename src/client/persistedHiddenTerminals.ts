/**
 * HS-7825 / HS-7826 / HS-8290 — persistence layer for visibility groupings.
 * See docs/39-visibility-groupings.md.
 *
 * Wraps the in-memory module (`dashboardHiddenTerminals.ts`) so the rest of
 * the codebase can keep using its public API verbatim. The persistence
 * layer subscribes to changes and fires a single debounced PATCH to the
 * global config endpoint (`/api/dashboard/global-config`) under
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

import { api } from './api.js';
import {
  getGlobalVisibilityState,
  hydratePersistedGlobalState,
  isConfiguredTerminalId,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import {
  DEFAULT_GROUPING_ID,
  parsePersistedState,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersisted: string | null = null;

const DEBOUNCE_MS = 250;

let subscriptionUnsub: (() => void) | null = null;

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
  const payload = {
    dashboard: {
      visibilityGroupings: persistedGroupings,
      activeVisibilityGroupingId: state.activeId,
    },
  };
  const serialised = JSON.stringify(payload);
  if (lastPersisted === serialised) return;
  lastPersisted = serialised;
  try {
    await api('/dashboard/global-config', { method: 'PATCH', body: payload });
  } catch {
    // Best-effort. The change is still in memory; next toggle will
    // schedule another write attempt.
  }
}

/**
 * Initialise the persistence layer: fetch the global dashboard config to
 * seed in-memory state, then subscribe to subsequent changes to write
 * them back. Idempotent — subsequent calls re-fetch but skip the
 * subscription wiring.
 */
export async function initPersistedHiddenTerminals(): Promise<void> {
  try {
    const cfg = await api<{
      dashboard?: {
        visibilityGroupings?: unknown;
        activeVisibilityGroupingId?: unknown;
      };
    }>('/dashboard/global-config');
    const dashboard = cfg.dashboard ?? {};
    const state = parsePersistedState(dashboard.visibilityGroupings, dashboard.activeVisibilityGroupingId);
    hydratePersistedGlobalState(state);
    // Stash the canonical serialised value so the first change-driven
    // PATCH doesn't immediately re-write the same payload.
    const persistedGroupings = computePersistedGroupings(state.groupings);
    lastPersisted = JSON.stringify({
      dashboard: {
        visibilityGroupings: persistedGroupings,
        activeVisibilityGroupingId: state.activeId,
      },
    });
  } catch {
    // Network / older server — leave the in-memory state alone.
  }

  if (subscriptionUnsub === null) {
    subscriptionUnsub = subscribeToHiddenChanges(() => {
      scheduleWrite();
    });
  }
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
