/**
 * HS-7826 → HS-8290 — Visibility groupings: pure helpers shared by the
 * in-memory state in `dashboardHiddenTerminals.ts`, the persistence layer
 * in `persistedHiddenTerminals.ts`, and the UI in `hideTerminalDialog.tsx`.
 *
 * **HS-8290 reshape.** Pre-HS-8290 each project had its own
 * `ProjectVisibilityState` with `VisibilityGrouping.hiddenIds: string[]`,
 * stored under `visibility_groupings` in each project's settings.json.
 * Cross-project fan-out machinery (`addGroupingForProjectWithId`,
 * `generateGroupingIdAcrossProjects`, dialog-level `dialogScopes`)
 * existed only to keep the duplicated grouping lists aligned. Post-HS-8290
 * there is ONE global state living in `~/.hotsheet/config.json` under
 * `dashboard.visibilityGroupings`; each grouping owns a
 * `hiddenByProject: Record<secret, string[]>` map so per-project terminal
 * ids stay where they belong while the grouping list itself is global.
 *
 * The Default grouping is always present, never deletable, and identifiable
 * by `id === DEFAULT_GROUPING_ID`. New groupings get a runtime-generated
 * id with a `g-` prefix to avoid collisions with the sentinel.
 *
 * See docs/39-visibility-groupings.md.
 */

export const DEFAULT_GROUPING_ID = 'default';
export const DEFAULT_GROUPING_NAME = 'Default';

export interface VisibilityGrouping {
  id: string;
  name: string;
  /** secret → hiddenIds array (configured terminal ids only — dynamic
   *  `dyn-*` terminals are session-only and never persisted). */
  hiddenByProject: Record<string, string[]>;
}

/** Single global state: ordered list of groupings + active id. */
export interface GlobalVisibilityState {
  groupings: VisibilityGrouping[];
  /** HS-8406 — per-scope active grouping selection. Each surface that
   *  reads/writes the active grouping uses its own scope key:
   *  - `'dashboard'` for the §25 terminal dashboard
   *  - `'project:<secret>'` for a project's §36 drawer-grid + the
   *    drawer's hide-terminal dialog opened from that project's tab.
   *  Scopes missing from the map fall back to `DEFAULT_GROUPING_ID`.
   *  Pre-HS-8406 a single global `activeId: string` covered every
   *  surface, which meant flipping the grouping in a project's drawer
   *  also flipped it in the dashboard. */
  activeIdByScope: Record<string, string>;
}

/** Scope key for the §25 terminal dashboard. */
export const DASHBOARD_SCOPE = 'dashboard';

/** Scope key for a project's §36 drawer-grid + the drawer's
 *  hide-terminal dialog opened from that project's tab. */
export function projectScope(secret: string): string {
  return `project:${secret}`;
}

/** Build the empty initial state — a single Default grouping with no
 *  hidden ids in any project, no per-scope overrides (every scope falls
 *  back to Default). */
export function initialGlobalState(): GlobalVisibilityState {
  return {
    groupings: [{
      id: DEFAULT_GROUPING_ID,
      name: DEFAULT_GROUPING_NAME,
      hiddenByProject: {},
    }],
    activeIdByScope: {},
  };
}

/** Generate a unique id for a new grouping. Caller passes the existing list
 *  so the helper can avoid collisions (defensive — Date.now + random is
 *  effectively unique already, but cheap to verify). */
export function generateGroupingId(existing: readonly VisibilityGrouping[]): string {
  const taken = new Set(existing.map(g => g.id));
  for (let i = 0; i < 100; i++) {
    const candidate = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological: 100 collisions in a row. Fall through with a counter.
  let n = 0;
  while (taken.has(`g-fallback-${n}`)) n++;
  return `g-fallback-${n}`;
}

/** Read the active grouping id for a scope. Falls back to
 *  `DEFAULT_GROUPING_ID` when the scope has no override OR when the
 *  recorded override doesn't match any current grouping (e.g. the
 *  grouping was deleted from another surface). */
export function getActiveGroupingIdFor(state: GlobalVisibilityState, scopeKey: string): string {
  if (!Object.prototype.hasOwnProperty.call(state.activeIdByScope, scopeKey)) return DEFAULT_GROUPING_ID;
  const recorded = state.activeIdByScope[scopeKey];
  if (state.groupings.some(g => g.id === recorded)) return recorded;
  return DEFAULT_GROUPING_ID;
}

/** Return the active grouping for a scope (always defined — falls back
 *  to the Default grouping when missing, or to a synthesized empty
 *  Default if the list is somehow empty). */
export function getActiveGroupingFor(state: GlobalVisibilityState, scopeKey: string): VisibilityGrouping {
  if (state.groupings.length === 0) {
    return { id: DEFAULT_GROUPING_ID, name: DEFAULT_GROUPING_NAME, hiddenByProject: {} };
  }
  const id = getActiveGroupingIdFor(state, scopeKey);
  const found = state.groupings.find(g => g.id === id);
  return found ?? state.groupings[0];
}

/** Add a new grouping with the given (trimmed) name. Pure: input state is
 *  not mutated. */
export function addGrouping(
  state: GlobalVisibilityState,
  rawName: string,
): { state: GlobalVisibilityState; grouping: VisibilityGrouping } {
  const name = rawName.trim() === '' ? 'New grouping' : rawName.trim();
  const id = generateGroupingId(state.groupings);
  const grouping: VisibilityGrouping = { id, name, hiddenByProject: {} };
  return {
    state: { groupings: [...state.groupings, grouping], activeIdByScope: state.activeIdByScope },
    grouping,
  };
}

/** Rename a grouping by id. No-op when id is missing or name is unchanged
 *  after trimming. The Default grouping CAN be renamed. */
export function renameGrouping(
  state: GlobalVisibilityState,
  id: string,
  rawName: string,
): GlobalVisibilityState {
  const name = rawName.trim();
  if (name === '') return state;
  const target = state.groupings.find(g => g.id === id);
  if (target === undefined || target.name === name) return state;
  const groupings = state.groupings.map(g => g.id === id ? { ...g, name } : g);
  return { groupings, activeIdByScope: state.activeIdByScope };
}

/** Delete a grouping by id. Refuses to delete the Default grouping. Any
 *  scope whose recorded active id matches the deleted grouping has its
 *  override stripped (so it falls back to Default on next read). */
export function deleteGrouping(state: GlobalVisibilityState, id: string): GlobalVisibilityState {
  if (id === DEFAULT_GROUPING_ID) return state;
  if (!state.groupings.some(g => g.id === id)) return state;
  const groupings = state.groupings.filter(g => g.id !== id);
  const activeIdByScope: Record<string, string> = {};
  for (const [scope, gId] of Object.entries(state.activeIdByScope)) {
    if (gId !== id) activeIdByScope[scope] = gId;
  }
  return { groupings, activeIdByScope };
}

/** Reorder groupings by moving `fromId` to the slot currently occupied by
 *  `toId`. Default can be moved away from the start. */
export function reorderGroupings(
  state: GlobalVisibilityState,
  fromId: string,
  toId: string,
): GlobalVisibilityState {
  if (fromId === toId) return state;
  const fromIdx = state.groupings.findIndex(g => g.id === fromId);
  const toIdx = state.groupings.findIndex(g => g.id === toId);
  if (fromIdx === -1 || toIdx === -1) return state;
  const next = [...state.groupings];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return { groupings: next, activeIdByScope: state.activeIdByScope };
}

/** Set the active grouping for a specific scope. No-op when id doesn't
 *  match any grouping. Setting `DEFAULT_GROUPING_ID` strips the scope's
 *  override entry (the absence of an entry IS Default). */
export function setActiveGroupingIdFor(
  state: GlobalVisibilityState,
  scopeKey: string,
  id: string,
): GlobalVisibilityState {
  if (!state.groupings.some(g => g.id === id)) return state;
  const current = getActiveGroupingIdFor(state, scopeKey);
  if (current === id) return state;
  const activeIdByScope: Record<string, string> = {};
  for (const [scope, gId] of Object.entries(state.activeIdByScope)) {
    if (scope === scopeKey) continue;
    activeIdByScope[scope] = gId;
  }
  if (id !== DEFAULT_GROUPING_ID) activeIdByScope[scopeKey] = id;
  return { groupings: state.groupings, activeIdByScope };
}

/** Read the hidden ids for a grouping in a specific project. Returns an
 *  empty array when the project has no entry. */
export function getHiddenIdsForProject(grouping: VisibilityGrouping, secret: string): readonly string[] {
  return grouping.hiddenByProject[secret] ?? [];
}

/** Toggle a terminal's hidden state in a specific grouping for a specific
 *  project. Returns the new grouping (or the same one when no change). */
export function toggleHiddenInGrouping(
  grouping: VisibilityGrouping,
  secret: string,
  terminalId: string,
  hide: boolean,
): VisibilityGrouping {
  const current = grouping.hiddenByProject[secret] ?? [];
  const has = current.includes(terminalId);
  if (hide && has) return grouping;
  if (!hide && !has) return grouping;
  const next = hide ? [...current, terminalId] : current.filter(id => id !== terminalId);
  return {
    ...grouping,
    hiddenByProject: { ...grouping.hiddenByProject, [secret]: next },
  };
}

/** Update a single grouping (matched by id) with a transformer. Convenience
 *  for the common "find-by-id, swap" flow. */
export function updateGroupingById(
  state: GlobalVisibilityState,
  id: string,
  transform: (g: VisibilityGrouping) => VisibilityGrouping,
): GlobalVisibilityState {
  const target = state.groupings.find(g => g.id === id);
  if (target === undefined) return state;
  const replacement = transform(target);
  if (replacement === target) return state;
  const groupings = state.groupings.map(g => g.id === id ? replacement : g);
  return { groupings, activeIdByScope: state.activeIdByScope };
}

/** Tolerant parser for the persisted shape returned by
 *  `GET /api/global-config` under `dashboard.visibilityGroupings`.
 *  Unknown shapes / parse errors fall through to the empty-Default state.
 *
 *  HS-8406 — accepts both the new `activeIdByScope` map AND the legacy
 *  scalar `activeId`. When both are present the new map wins; when only
 *  the legacy value is present it migrates to
 *  `{ [DASHBOARD_SCOPE]: activeId }` (preserving the user's pre-fix
 *  dashboard pick — every project's drawer-grid scope falls back to
 *  Default on first read, which was the user-requested behavior). */
export function parsePersistedState(
  rawGroupings: unknown,
  rawActiveId: unknown,
  rawActiveIdByScope?: unknown,
): GlobalVisibilityState {
  const parsed = normaliseGroupings(rawGroupings);
  if (parsed === null || parsed.length === 0) return initialGlobalState();
  const activeIdByScope = normaliseActiveIdByScope(rawActiveIdByScope, rawActiveId, parsed);
  return { groupings: parsed, activeIdByScope };
}

function normaliseActiveIdByScope(
  rawByScope: unknown,
  rawLegacyId: unknown,
  groupings: readonly VisibilityGrouping[],
): Record<string, string> {
  const validIds = new Set(groupings.map(g => g.id));
  const out: Record<string, string> = {};

  // New shape wins when present + parseable.
  if (rawByScope !== null && typeof rawByScope === 'object' && !Array.isArray(rawByScope)) {
    for (const [scope, id] of Object.entries(rawByScope as Record<string, unknown>)) {
      if (typeof scope !== 'string' || scope === '') continue;
      if (typeof id !== 'string' || !validIds.has(id)) continue;
      // Drop redundant Default entries (absence IS Default — keeps the
      // payload byte-stable when the user reverts a non-Default pick).
      if (id === DEFAULT_GROUPING_ID) continue;
      out[scope] = id;
    }
    return out;
  }

  // Legacy scalar fallback: migrate to the dashboard scope.
  if (typeof rawLegacyId === 'string' && rawLegacyId !== '' && validIds.has(rawLegacyId)
      && rawLegacyId !== DEFAULT_GROUPING_ID) {
    out[DASHBOARD_SCOPE] = rawLegacyId;
  }
  return out;
}

function normaliseGroupings(raw: unknown): VisibilityGrouping[] | null {
  let value: unknown = raw;
  if (typeof value === 'string' && value !== '') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!Array.isArray(value)) return null;
  const out: VisibilityGrouping[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Partial<VisibilityGrouping> & { hiddenByProject?: unknown };
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (seen.has(obj.id)) continue;
    const name = typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : DEFAULT_GROUPING_NAME;
    const hiddenByProject = normaliseHiddenByProject(obj.hiddenByProject);
    seen.add(obj.id);
    out.push({ id: obj.id, name, hiddenByProject });
  }
  if (!out.some(g => g.id === DEFAULT_GROUPING_ID)) {
    out.unshift({ id: DEFAULT_GROUPING_ID, name: DEFAULT_GROUPING_NAME, hiddenByProject: {} });
  }
  return out;
}

function normaliseHiddenByProject(raw: unknown): Record<string, string[]> {
  if (raw === null || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [secret, ids] of Object.entries(raw)) {
    if (typeof secret !== 'string' || secret === '') continue;
    if (!Array.isArray(ids)) continue;
    const filtered = ids.filter((s): s is string => typeof s === 'string' && s !== '');
    if (filtered.length > 0) out[secret] = filtered;
  }
  return out;
}

/** Filter every grouping's `hiddenByProject[secret]` to drop ids that are
 *  no longer in the configured-terminal set for that project. Pure helper
 *  used by the client-side prune-on-/terminal/list path. Returns null when
 *  no prune is needed; otherwise returns the new groupings array. */
export function pruneStaleIdsInGroupings(
  groupings: readonly VisibilityGrouping[],
  secret: string,
  configuredIds: ReadonlySet<string>,
): VisibilityGrouping[] | null {
  const next = groupings.map(g => {
    if (!Object.prototype.hasOwnProperty.call(g.hiddenByProject, secret)) return g;
    const current = g.hiddenByProject[secret];
    if (current.length === 0) return g;
    const kept = current.filter(id => configuredIds.has(id));
    if (kept.length === current.length) return g;
    const nextByProject: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(g.hiddenByProject)) {
      if (k !== secret) nextByProject[k] = v;
    }
    if (kept.length > 0) nextByProject[secret] = kept;
    return { ...g, hiddenByProject: nextByProject };
  });
  // Identity-compare across the array — `.map` returns the same reference
  // when the callback returned `g`, so we can detect "did anything actually
  // change" without a separate flag (which TS can't track through closure).
  const anyChanged = next.some((g, i) => g !== groupings[i]);
  return anyChanged ? next : null;
}
