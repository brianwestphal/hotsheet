/**
 * HS-7825 / HS-7826 — persistence layer for the visibility groupings (and
 * the legacy flat hidden_terminals shape it superseded). See
 * docs/38-terminal-visibility.md + docs/39-visibility-groupings.md.
 *
 * Wraps the in-memory module (`dashboardHiddenTerminals.ts`) so the rest
 * of the codebase can keep using the public API verbatim. The persistence
 * layer subscribes to changes and fires a debounced PATCH per project to
 * write the configured-id subset of the project's groupings to
 * `.hotsheet/settings.json` under `visibility_groupings` (HS-7826) +
 * `active_visibility_grouping_id`. A legacy `hidden_terminals` array is
 * also written, mirroring the active grouping's hiddenIds, so older
 * clients reading the same settings.json still see the user's filter.
 *
 * Dynamic terminals (`dyn-*` ids) are intentionally NOT persisted — their
 * lifetime is per-session, so persisting them would mean stale ids
 * accumulating in settings.json forever.
 *
 * Initial hydration runs once at app boot via `initPersistedHiddenTerminals`
 * which fetches every registered project's `/file-settings` and seeds the
 * in-memory map via `hydratePersistedStateForProject` (or, when only the
 * legacy shape is present, the back-compat `hydratePersistedHiddenForProject`).
 */

import { apiWithSecret } from './api.js';
import {
  getActiveGroupingId,
  getProjectVisibilityState,
  hydratePersistedStateForProject,
  isConfiguredTerminalId,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import type { ProjectInfo } from './state.js';
import {
  DEFAULT_GROUPING_ID,
  parsePersistedState,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

// Per-project debounced write timers. Keyed by project secret.
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Last-written serialised payload per project so we can short-circuit
// no-op writes (e.g. tab switch back to the same active grouping).
const lastPersisted = new Map<string, string>();

const DEBOUNCE_MS = 250;

let subscriptionUnsub: (() => void) | null = null;
let knownSecrets: ReadonlySet<string> = new Set();

/**
 * Filter every grouping's `hiddenIds` to drop dynamic-terminal ids before
 * persistence. Pure: input is the in-memory groupings array, output is a
 * new array with sanitised ids and stable sort order so unchanged
 * payloads serialise byte-equally.
 */
export function computePersistedGroupings(groupings: readonly VisibilityGrouping[]): VisibilityGrouping[] {
  return groupings.map(g => {
    const ids = g.hiddenIds.filter(isConfiguredTerminalId).sort();
    return { id: g.id, name: g.name, hiddenIds: ids };
  });
}

/** Mirror of the active grouping's hiddenIds, also written under the
 *  legacy `hidden_terminals` key so older clients reading the same
 *  settings.json still see the user's filter (no migration step needed
 *  on downgrade). Sorted for serialised stability. */
function legacyMirrorIds(groupings: readonly VisibilityGrouping[], activeId: string): string[] {
  if (groupings.length === 0) return [];
  const active = groupings.find(g => g.id === activeId) ?? groupings[0];
  return active.hiddenIds.filter(isConfiguredTerminalId).sort();
}

function scheduleWrite(secret: string): void {
  const existing = writeTimers.get(secret);
  if (existing !== undefined) clearTimeout(existing);
  writeTimers.set(secret, setTimeout(() => {
    writeTimers.delete(secret);
    void writeNow(secret);
  }, DEBOUNCE_MS));
}

async function writeNow(secret: string): Promise<void> {
  const state = getProjectVisibilityState(secret);
  const persistedGroupings = computePersistedGroupings(state.groupings);
  const legacyIds = legacyMirrorIds(persistedGroupings, state.activeId);
  const payload = {
    visibility_groupings: persistedGroupings,
    active_visibility_grouping_id: state.activeId,
    hidden_terminals: legacyIds,
  };
  const serialised = JSON.stringify(payload);
  if (lastPersisted.get(secret) === serialised) return; // no-op
  lastPersisted.set(secret, serialised);
  try {
    await apiWithSecret('/file-settings', secret, { method: 'PATCH', body: payload });
  } catch {
    // Best-effort. The change is still in memory; next toggle will
    // schedule another write attempt.
  }
}

/**
 * Initialise the persistence layer: fetch each known project's
 * `/file-settings` to seed the in-memory map, then subscribe to subsequent
 * changes to write them back. Idempotent. The change subscription is
 * attached only once.
 */
export async function initPersistedHiddenTerminals(projects: ProjectInfo[]): Promise<void> {
  knownSecrets = new Set(projects.map(p => p.secret));
  await Promise.all(projects.map(async (p) => {
    if (lastPersisted.has(p.secret)) return; // already hydrated this session
    try {
      const fs = await apiWithSecret<{
        visibility_groupings?: unknown;
        active_visibility_grouping_id?: unknown;
        hidden_terminals?: string[] | string;
      }>('/file-settings', p.secret);
      const legacy = readLegacyHiddenTerminals(fs.hidden_terminals);
      const state = parsePersistedState(fs.visibility_groupings, fs.active_visibility_grouping_id, legacy);
      hydratePersistedStateForProject(p.secret, state);
      // Stash the canonical serialised value so the change subscription
      // doesn't immediately PATCH back the same payload.
      const persistedGroupings = computePersistedGroupings(state.groupings);
      const legacyIds = legacyMirrorIds(persistedGroupings, state.activeId);
      lastPersisted.set(p.secret, JSON.stringify({
        visibility_groupings: persistedGroupings,
        active_visibility_grouping_id: state.activeId,
        hidden_terminals: legacyIds,
      }));
    } catch {
      // Network / older server — leave the in-memory state alone.
    }
  }));

  if (subscriptionUnsub === null) {
    subscriptionUnsub = subscribeToHiddenChanges(() => {
      for (const secret of knownSecrets) scheduleWrite(secret);
    });
  }
}

function readLegacyHiddenTerminals(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string' && s !== '');
  if (typeof raw === 'string' && raw !== '') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string' && s !== '');
    } catch { /* ignore */ }
  }
  return undefined;
}

/** Test-only — flush every pending debounced write synchronously. */
export function _flushForTests(): void {
  for (const [secret, timer] of writeTimers) {
    clearTimeout(timer);
    writeTimers.delete(secret);
    void writeNow(secret);
  }
}

/** Test-only — drop every cached state so a fresh init starts clean. */
export function _resetForTests(): void {
  for (const t of writeTimers.values()) clearTimeout(t);
  writeTimers.clear();
  lastPersisted.clear();
  knownSecrets = new Set();
  if (subscriptionUnsub !== null) {
    subscriptionUnsub();
    subscriptionUnsub = null;
  }
}

// Re-export for back-compat with the HS-7825 test that imported
// `computePersistedIds` (the flat-list variant). New callers should use
// `computePersistedGroupings`. The flat helper now reads the active
// grouping's ids and is kept as a thin shim for the HS-7825 unit test.
export function computePersistedIds(allHidden: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of allHidden) if (isConfiguredTerminalId(id)) out.push(id);
  out.sort();
  return out;
}

// Mark the active-id helper as exported for the tests in
// persistedHiddenTerminals.test.ts.
export { getActiveGroupingId };
// Mark the default-grouping sentinel re-export so callers don't have to
// also import from visibilityGroupings.
export { DEFAULT_GROUPING_ID };
