/**
 * HS-7826 — Visibility groupings: pure helpers shared by the in-memory
 * state in `dashboardHiddenTerminals.ts`, the persistence layer in
 * `persistedHiddenTerminals.ts`, and the UI in `hideTerminalDialog.tsx`.
 *
 * A grouping is a named visibility configuration: `{ id, name, hiddenIds }`.
 * Each project maintains a list of groupings + an active id. Toggling a row
 * in the Show / Hide Terminals dialog flips the row in the *active*
 * grouping. The dashboard / drawer-grid filter uses the active grouping's
 * `hiddenIds` to decide which tiles to drop.
 *
 * Pre-HS-7826 there was a flat per-project `Set<terminalId>`; that maps
 * onto a single grouping with `id: 'default'`, `name: 'Default'`. The
 * Default grouping is always present, never deletable, and identifiable
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
  hiddenIds: string[];
}

/** State for one project: ordered list of groupings + active id. The
 *  Default grouping is always present at index 0 unless reorder moves it. */
export interface ProjectVisibilityState {
  groupings: VisibilityGrouping[];
  activeId: string;
}

/** Build the initial state for a project that has no persisted groupings —
 *  a single Default grouping seeded with `seedHiddenIds` (typically the
 *  legacy `hidden_terminals` array on first hydrate, otherwise empty). */
export function initialProjectState(seedHiddenIds: readonly string[] = []): ProjectVisibilityState {
  return {
    groupings: [{
      id: DEFAULT_GROUPING_ID,
      name: DEFAULT_GROUPING_NAME,
      hiddenIds: [...seedHiddenIds],
    }],
    activeId: DEFAULT_GROUPING_ID,
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

/** Return the active grouping (always defined — falls back to the first
 *  grouping if `activeId` doesn't match any, or to a synthesized empty
 *  Default if the list is somehow empty). */
export function getActiveGrouping(state: ProjectVisibilityState): VisibilityGrouping {
  if (state.groupings.length === 0) {
    return { id: DEFAULT_GROUPING_ID, name: DEFAULT_GROUPING_NAME, hiddenIds: [] };
  }
  const found = state.groupings.find(g => g.id === state.activeId);
  return found ?? state.groupings[0];
}

/** Add a new grouping with the given (trimmed) name. Returns the new
 *  state + the new grouping. Pure: input state is not mutated. */
export function addGrouping(
  state: ProjectVisibilityState,
  rawName: string,
): { state: ProjectVisibilityState; grouping: VisibilityGrouping } {
  const name = rawName.trim() === '' ? 'New grouping' : rawName.trim();
  const id = generateGroupingId(state.groupings);
  return addGroupingWithId(state, id, name);
}

/** HS-7826 follow-up — variant of `addGrouping` that uses a caller-provided
 *  id, so the same grouping can be added under the same id across multiple
 *  per-project states (the cross-project fan-out the global Show / Hide
 *  Terminals dialog needs to keep its tab bar consistent). When the id is
 *  already present in `state`, the call is a no-op. */
export function addGroupingWithId(
  state: ProjectVisibilityState,
  id: string,
  rawName: string,
): { state: ProjectVisibilityState; grouping: VisibilityGrouping } {
  const name = rawName.trim() === '' ? 'New grouping' : rawName.trim();
  const existing = state.groupings.find(g => g.id === id);
  if (existing !== undefined) {
    return { state, grouping: existing };
  }
  const grouping: VisibilityGrouping = { id, name, hiddenIds: [] };
  return {
    state: {
      groupings: [...state.groupings, grouping],
      activeId: state.activeId,
    },
    grouping,
  };
}

/** Rename a grouping by id. No-op when id is missing or name is unchanged
 *  after trimming. The Default grouping CAN be renamed (its id is the
 *  invariant — name is just a label) so the user can reflect a different
 *  project context. */
export function renameGrouping(
  state: ProjectVisibilityState,
  id: string,
  rawName: string,
): ProjectVisibilityState {
  const name = rawName.trim();
  if (name === '') return state;
  const target = state.groupings.find(g => g.id === id);
  if (target === undefined || target.name === name) return state;
  const groupings = state.groupings.map(g => g.id === id ? { ...g, name } : g);
  return { groupings, activeId: state.activeId };
}

/** Delete a grouping by id. Refuses to delete the Default grouping —
 *  returns the input unchanged. When the active grouping is deleted,
 *  activeId falls back to Default. */
export function deleteGrouping(state: ProjectVisibilityState, id: string): ProjectVisibilityState {
  if (id === DEFAULT_GROUPING_ID) return state;
  if (!state.groupings.some(g => g.id === id)) return state;
  const groupings = state.groupings.filter(g => g.id !== id);
  const activeId = state.activeId === id ? DEFAULT_GROUPING_ID : state.activeId;
  return { groupings, activeId };
}

/** Reorder groupings by moving `fromId` to the slot currently occupied by
 *  `toId`. Default can be moved away from the start — the user might
 *  prefer a custom grouping at index 0. */
export function reorderGroupings(
  state: ProjectVisibilityState,
  fromId: string,
  toId: string,
): ProjectVisibilityState {
  if (fromId === toId) return state;
  const fromIdx = state.groupings.findIndex(g => g.id === fromId);
  const toIdx = state.groupings.findIndex(g => g.id === toId);
  if (fromIdx === -1 || toIdx === -1) return state;
  const next = [...state.groupings];
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return { groupings: next, activeId: state.activeId };
}

/** Set the active grouping. No-op when id doesn't match any grouping. */
export function setActiveGroupingId(state: ProjectVisibilityState, id: string): ProjectVisibilityState {
  if (state.activeId === id) return state;
  if (!state.groupings.some(g => g.id === id)) return state;
  return { groupings: state.groupings, activeId: id };
}

/** Toggle a terminal's hidden state in a specific grouping. Pure helper —
 *  caller updates the wrapping ProjectVisibilityState. Returns the new
 *  grouping (or the same one when no change). */
export function toggleHiddenInGrouping(
  grouping: VisibilityGrouping,
  terminalId: string,
  hide: boolean,
): VisibilityGrouping {
  const has = grouping.hiddenIds.includes(terminalId);
  if (hide && has) return grouping;
  if (!hide && !has) return grouping;
  if (hide) return { ...grouping, hiddenIds: [...grouping.hiddenIds, terminalId] };
  return { ...grouping, hiddenIds: grouping.hiddenIds.filter(id => id !== terminalId) };
}

/** Update a single grouping (matched by id) with a transformer; returns
 *  the new state. Convenience for the common "find-by-id, swap" flow. */
export function updateGroupingById(
  state: ProjectVisibilityState,
  id: string,
  transform: (g: VisibilityGrouping) => VisibilityGrouping,
): ProjectVisibilityState {
  const target = state.groupings.find(g => g.id === id);
  if (target === undefined) return state;
  const replacement = transform(target);
  if (replacement === target) return state;
  const groupings = state.groupings.map(g => g.id === id ? replacement : g);
  return { groupings, activeId: state.activeId };
}

/** Tolerant parser for the persisted shape. Accepts either the new
 *  `{ groupings, activeId }` shape (from /file-settings.visibility_groupings)
 *  OR the legacy flat `string[]` shape (from /file-settings.hidden_terminals)
 *  and returns a normalised ProjectVisibilityState. Unknown shapes / parse
 *  errors fall through to the empty-Default initial state. */
export function parsePersistedState(
  rawGroupings: unknown,
  rawActiveId: unknown,
  legacyHiddenTerminals?: readonly string[],
): ProjectVisibilityState {
  // 1. Try the new shape first.
  const parsed = normaliseGroupings(rawGroupings);
  if (parsed !== null && parsed.length > 0) {
    const activeId = typeof rawActiveId === 'string' && parsed.some(g => g.id === rawActiveId)
      ? rawActiveId
      : (parsed[0].id);
    return { groupings: parsed, activeId };
  }
  // 2. Fall back to the legacy flat list (HS-7825 → HS-7826 migration).
  if (legacyHiddenTerminals !== undefined && legacyHiddenTerminals.length > 0) {
    return initialProjectState(legacyHiddenTerminals);
  }
  // 3. Empty Default.
  return initialProjectState();
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
    const obj = item as Partial<VisibilityGrouping>;
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (seen.has(obj.id)) continue;
    const name = typeof obj.name === 'string' && obj.name.trim() !== '' ? obj.name : DEFAULT_GROUPING_NAME;
    const hiddenIds = Array.isArray(obj.hiddenIds)
      ? obj.hiddenIds.filter((s): s is string => typeof s === 'string' && s !== '')
      : [];
    seen.add(obj.id);
    out.push({ id: obj.id, name, hiddenIds });
  }
  // Defense in depth: ensure Default exists. If the persisted list had it
  // and was filtered out, this won't fire; if it never had Default, prepend
  // a fresh empty one so the invariant ("Default always present") holds.
  if (!out.some(g => g.id === DEFAULT_GROUPING_ID)) {
    out.unshift({ id: DEFAULT_GROUPING_ID, name: DEFAULT_GROUPING_NAME, hiddenIds: [] });
  }
  return out;
}

/** Filter every grouping's `hiddenIds` to drop ids that are no longer in
 *  the configured-terminal set. Pure helper used by the file-settings
 *  PATCH handler when `terminals[]` changes (HS-7829 generalisation).
 *  Returns null when no prune is needed; otherwise returns the new
 *  groupings array (preserving order + activeId-relevant ids). */
export function pruneStaleIdsInGroupings(
  groupings: readonly VisibilityGrouping[],
  configuredIds: ReadonlySet<string>,
): VisibilityGrouping[] | null {
  const hasStale = groupings.some(g => g.hiddenIds.some(id => !configuredIds.has(id)));
  if (!hasStale) return null;
  return groupings.map(g => {
    const keptIds = g.hiddenIds.filter(id => configuredIds.has(id));
    return keptIds.length === g.hiddenIds.length ? g : { ...g, hiddenIds: keptIds };
  });
}
