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
  activeId: string;
}

/** Build the empty initial state — a single Default grouping with no
 *  hidden ids in any project. */
export function initialGlobalState(): GlobalVisibilityState {
  return {
    groupings: [{
      id: DEFAULT_GROUPING_ID,
      name: DEFAULT_GROUPING_NAME,
      hiddenByProject: {},
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
export function getActiveGrouping(state: GlobalVisibilityState): VisibilityGrouping {
  if (state.groupings.length === 0) {
    return { id: DEFAULT_GROUPING_ID, name: DEFAULT_GROUPING_NAME, hiddenByProject: {} };
  }
  const found = state.groupings.find(g => g.id === state.activeId);
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
    state: { groupings: [...state.groupings, grouping], activeId: state.activeId },
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
  return { groupings, activeId: state.activeId };
}

/** Delete a grouping by id. Refuses to delete the Default grouping. When
 *  the active grouping is deleted, activeId falls back to Default. */
export function deleteGrouping(state: GlobalVisibilityState, id: string): GlobalVisibilityState {
  if (id === DEFAULT_GROUPING_ID) return state;
  if (!state.groupings.some(g => g.id === id)) return state;
  const groupings = state.groupings.filter(g => g.id !== id);
  const activeId = state.activeId === id ? DEFAULT_GROUPING_ID : state.activeId;
  return { groupings, activeId };
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
  return { groupings: next, activeId: state.activeId };
}

/** Set the active grouping. No-op when id doesn't match any grouping. */
export function setActiveGroupingId(state: GlobalVisibilityState, id: string): GlobalVisibilityState {
  if (state.activeId === id) return state;
  if (!state.groupings.some(g => g.id === id)) return state;
  return { groupings: state.groupings, activeId: id };
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
  return { groupings, activeId: state.activeId };
}

/** Tolerant parser for the persisted shape returned by
 *  `GET /api/dashboard/global-config` under `dashboard.visibilityGroupings`.
 *  Unknown shapes / parse errors fall through to the empty-Default state. */
export function parsePersistedState(
  rawGroupings: unknown,
  rawActiveId: unknown,
): GlobalVisibilityState {
  const parsed = normaliseGroupings(rawGroupings);
  if (parsed === null || parsed.length === 0) return initialGlobalState();
  const activeId = typeof rawActiveId === 'string' && parsed.some(g => g.id === rawActiveId)
    ? rawActiveId
    : parsed[0].id;
  return { groupings: parsed, activeId };
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
