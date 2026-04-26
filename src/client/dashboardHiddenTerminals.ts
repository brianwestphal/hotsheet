/**
 * HS-7661 / HS-7825 / HS-7826 — Hidden-terminal state for both the global
 * Terminal Dashboard (§25) and the per-project Drawer Terminal Grid (§36).
 *
 * **State shape (HS-7826).** Per-project list of named *visibility
 * groupings*; each grouping carries its own `hiddenIds` array. The `Default`
 * grouping is always present and acts as the post-HS-7825 single-grouping
 * compatibility surface — pre-HS-7826 callers that only know about a flat
 * "(secret, terminalId) → isHidden" world continue to work via the helpers
 * below, which delegate to whichever grouping is currently active.
 *
 * Subscribers (the dashboard, drawer-grid, dialog) receive change
 * notifications via `subscribeToHiddenChanges(handler)` for any change —
 * a row toggle, a tab switch, a grouping rename / delete / reorder, or a
 * persisted-state hydrate.
 *
 * **Persistence.** See docs/38-terminal-visibility.md (HS-7825) +
 * docs/39-visibility-groupings.md (HS-7826). The `persistedHiddenTerminals.ts`
 * module subscribes to changes and PATCHes the new shape
 * (`visibility_groupings` + `active_visibility_grouping_id`) plus a legacy
 * `hidden_terminals` for compatibility with older clients reading the same
 * settings.json.
 */

import {
  addGrouping as addGroupingPure,
  DEFAULT_GROUPING_ID,
  deleteGrouping as deleteGroupingPure,
  getActiveGrouping,
  initialProjectState,
  type ProjectVisibilityState,
  renameGrouping as renameGroupingPure,
  reorderGroupings as reorderGroupingsPure,
  setActiveGroupingId as setActiveGroupingIdPure,
  toggleHiddenInGrouping,
  updateGroupingById,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

const projectStates = new Map<string, ProjectVisibilityState>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const handler of subscribers) {
    try { handler(); } catch { /* swallow — subscriber callbacks are advisory */ }
  }
}

function getOrInit(secret: string): ProjectVisibilityState {
  const existing = projectStates.get(secret);
  if (existing !== undefined) return existing;
  const fresh = initialProjectState();
  projectStates.set(secret, fresh);
  return fresh;
}

/** Replace the per-project state and fire change notifications when the
 *  reference actually changed. Single source-of-truth for mutations. */
function setProjectState(secret: string, next: ProjectVisibilityState): void {
  const existing = projectStates.get(secret);
  if (existing === next) return;
  projectStates.set(secret, next);
  notify();
}

// ---------------------------------------------------------------------------
// Pre-HS-7826 single-grouping public API. Every helper delegates to the
// active grouping, so callers that don't know about groupings keep working.
// ---------------------------------------------------------------------------

/** True when this `(secret, terminalId)` pair is hidden in the active
 *  grouping for the project. */
export function isTerminalHidden(secret: string, terminalId: string): boolean {
  const state = projectStates.get(secret);
  if (state === undefined) return false;
  return getActiveGrouping(state).hiddenIds.includes(terminalId);
}

/** Return a fresh set of hidden terminal ids in the project's active
 *  grouping. Returned set is a copy — mutating it does NOT affect module
 *  state; use `setTerminalHidden` to make changes. */
export function getHiddenTerminals(secret: string): Set<string> {
  const state = projectStates.get(secret);
  if (state === undefined) return new Set();
  return new Set(getActiveGrouping(state).hiddenIds);
}

/** Toggle the hidden state for a `(secret, terminalId)` pair against the
 *  active grouping. */
export function setTerminalHidden(secret: string, terminalId: string, hide: boolean): void {
  const state = getOrInit(secret);
  const active = getActiveGrouping(state);
  const next = updateGroupingById(state, active.id, g => toggleHiddenInGrouping(g, terminalId, hide));
  setProjectState(secret, next);
}

/** Filter a TileEntry-like list down to visible-only ids in the project's
 *  active grouping. */
export function filterVisible<T extends { id: string }>(secret: string, entries: T[]): T[] {
  const state = projectStates.get(secret);
  if (state === undefined) return entries;
  const active = getActiveGrouping(state);
  if (active.hiddenIds.length === 0) return entries;
  const set = new Set(active.hiddenIds);
  return entries.filter(e => !set.has(e.id));
}

/** Clear all hidden state for one project's active grouping. (Other
 *  groupings are untouched — to clear EVERY grouping use `unhideAllEverywhere`
 *  or call this on the active grouping after switching.) */
export function unhideAllInProject(secret: string): void {
  const state = projectStates.get(secret);
  if (state === undefined) return;
  const active = getActiveGrouping(state);
  if (active.hiddenIds.length === 0) return;
  const next = updateGroupingById(state, active.id, g => ({ ...g, hiddenIds: [] }));
  setProjectState(secret, next);
}

/** Clear hidden state across every project's ACTIVE grouping. Used by the
 *  global Terminal Dashboard's "Show all" link. */
export function unhideAllEverywhere(): void {
  let changed = false;
  for (const [secret, state] of projectStates) {
    const active = getActiveGrouping(state);
    if (active.hiddenIds.length === 0) continue;
    const next = updateGroupingById(state, active.id, g => ({ ...g, hiddenIds: [] }));
    projectStates.set(secret, next);
    changed = true;
  }
  if (changed) notify();
}

/** Subscribe to hidden-state changes. Returns an unsubscribe function. */
export function subscribeToHiddenChanges(handler: () => void): () => void {
  subscribers.add(handler);
  return () => { subscribers.delete(handler); };
}

/** Total number of hidden terminals across every project's ACTIVE grouping. */
export function countHiddenAcrossAllProjects(): number {
  let total = 0;
  for (const state of projectStates.values()) total += getActiveGrouping(state).hiddenIds.length;
  return total;
}

/** Number of hidden terminals scoped to a single project's active grouping. */
export function countHiddenForProject(secret: string): number {
  const state = projectStates.get(secret);
  if (state === undefined) return 0;
  return getActiveGrouping(state).hiddenIds.length;
}

/**
 * HS-7823 — render or remove a small numeric badge on an eye-icon button to
 * indicate how many terminals are currently hidden in the relevant scope.
 */
export function applyHideButtonBadge(button: HTMLElement | null, count: number): void {
  if (button === null) return;
  let badge = button.querySelector<HTMLSpanElement>('.hide-btn-badge');
  if (count <= 0) {
    if (badge !== null) badge.remove();
    return;
  }
  if (badge === null) {
    badge = document.createElement('span');
    badge.className = 'hide-btn-badge';
    button.appendChild(badge);
  }
  const text = count > 99 ? '99+' : String(count);
  if (badge.textContent !== text) badge.textContent = text;
}

/** Clear ALL state — used by tests so each spec can start clean. */
export function _resetForTests(): void {
  projectStates.clear();
  subscribers.clear();
}

/**
 * HS-7825 — true when a terminal id refers to a *configured* (settings-
 * backed) terminal whose hidden state should be persisted. Dynamic
 * terminals (`dyn-*`) are intentionally NOT persisted.
 */
export function isConfiguredTerminalId(terminalId: string): boolean {
  return !terminalId.startsWith('dyn-');
}

/**
 * HS-7825 — hydrate the in-memory hidden set for a project from a flat
 * list of persisted ids. Used during app boot when ONLY the legacy
 * `hidden_terminals` key is present (pre-HS-7826 settings.json). Modern
 * callers use `hydratePersistedStateForProject` (below) which carries the
 * full groupings shape.
 */
export function hydratePersistedHiddenForProject(secret: string, ids: readonly string[]): void {
  const configuredIds = ids.filter(isConfiguredTerminalId);
  const next = initialProjectState(configuredIds);
  // Cheap equality dodge so we don't notify when nothing actually changed.
  const existing = projectStates.get(secret);
  if (existing !== undefined && projectStateEquals(existing, next)) return;
  setProjectState(secret, next);
}

/**
 * HS-7826 — hydrate the in-memory state for a project from a parsed
 * ProjectVisibilityState (typically returned by `parsePersistedState`
 * in `visibilityGroupings.ts`). The persistence layer calls this on
 * boot. Dynamic ids are filtered out of every grouping's hiddenIds.
 */
export function hydratePersistedStateForProject(
  secret: string,
  state: ProjectVisibilityState,
): void {
  const sanitised: ProjectVisibilityState = {
    groupings: state.groupings.map(g => ({
      ...g,
      hiddenIds: g.hiddenIds.filter(isConfiguredTerminalId),
    })),
    activeId: state.activeId,
  };
  const existing = projectStates.get(secret);
  if (existing !== undefined && projectStateEquals(existing, sanitised)) return;
  setProjectState(secret, sanitised);
}

function projectStateEquals(a: ProjectVisibilityState, b: ProjectVisibilityState): boolean {
  if (a.activeId !== b.activeId) return false;
  if (a.groupings.length !== b.groupings.length) return false;
  for (let i = 0; i < a.groupings.length; i++) {
    const ga = a.groupings[i];
    const gb = b.groupings[i];
    if (ga.id !== gb.id || ga.name !== gb.name) return false;
    if (ga.hiddenIds.length !== gb.hiddenIds.length) return false;
    // hiddenIds is set-like — compare without regard to order so a
    // re-hydrate from the same persisted Set in a different iteration
    // order doesn't fire a spurious notify.
    const setA = new Set(ga.hiddenIds);
    for (const id of gb.hiddenIds) if (!setA.has(id)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// HS-7826 — grouping management API.
// ---------------------------------------------------------------------------

/** Read the current state for a project. Returns a frozen empty-Default
 *  initial state when the project hasn't been seen yet (caller never has
 *  to null-check). The returned object is the live state — callers MUST
 *  NOT mutate it; use the helpers below to make changes. */
export function getProjectVisibilityState(secret: string): ProjectVisibilityState {
  return projectStates.get(secret) ?? initialProjectState();
}

/** List the project's groupings (display order). */
export function getGroupings(secret: string): VisibilityGrouping[] {
  return getProjectVisibilityState(secret).groupings;
}

/** Active grouping id for the project. */
export function getActiveGroupingId(secret: string): string {
  return getProjectVisibilityState(secret).activeId;
}

/** Switch the active grouping for the project. Fires the change
 *  subscription so the dashboard / drawer-grid filter re-applies. */
export function setActiveGroupingForProject(secret: string, id: string): void {
  const state = getOrInit(secret);
  const next = setActiveGroupingIdPure(state, id);
  setProjectState(secret, next);
}

/** Add a new grouping to the project. Returns the new grouping (so the
 *  caller can immediately switch to it / focus its tab). */
export function addGroupingForProject(secret: string, name: string): VisibilityGrouping {
  const state = getOrInit(secret);
  const { state: next, grouping } = addGroupingPure(state, name);
  setProjectState(secret, next);
  return grouping;
}

/** Rename a grouping. No-op when name doesn't change after trimming. */
export function renameGroupingForProject(secret: string, id: string, name: string): void {
  const state = getOrInit(secret);
  const next = renameGroupingPure(state, id, name);
  setProjectState(secret, next);
}

/** Delete a grouping (Default is refused; activeId falls back to Default
 *  when the deleted grouping was active). */
export function deleteGroupingForProject(secret: string, id: string): void {
  if (id === DEFAULT_GROUPING_ID) return;
  const state = getOrInit(secret);
  const next = deleteGroupingPure(state, id);
  setProjectState(secret, next);
}

/** Reorder groupings (drag-and-drop) — moves fromId into toId's slot. */
export function reorderGroupingsForProject(secret: string, fromId: string, toId: string): void {
  const state = getOrInit(secret);
  const next = reorderGroupingsPure(state, fromId, toId);
  setProjectState(secret, next);
}

/** Toggle a terminal's hidden state in a SPECIFIC grouping (not necessarily
 *  the active one). Used by the dialog when the user is on a non-active
 *  grouping's tab and toggles a row. */
export function setTerminalHiddenInGrouping(
  secret: string,
  groupingId: string,
  terminalId: string,
  hide: boolean,
): void {
  const state = getOrInit(secret);
  const next = updateGroupingById(state, groupingId, g => toggleHiddenInGrouping(g, terminalId, hide));
  setProjectState(secret, next);
}

/** Read whether a terminal is hidden in a SPECIFIC grouping (parallel to
 *  isTerminalHidden which reads the active one). */
export function isTerminalHiddenInGrouping(
  secret: string,
  groupingId: string,
  terminalId: string,
): boolean {
  const state = projectStates.get(secret);
  if (state === undefined) return false;
  const grouping = state.groupings.find(g => g.id === groupingId);
  return grouping?.hiddenIds.includes(terminalId) === true;
}

/** Clear hidden state in a SPECIFIC grouping (used by the dialog's "Show
 *  all" link when the user is on a non-active tab). */
export function unhideAllInGrouping(secret: string, groupingId: string): void {
  const state = getOrInit(secret);
  const next = updateGroupingById(state, groupingId, g => g.hiddenIds.length === 0 ? g : ({ ...g, hiddenIds: [] }));
  setProjectState(secret, next);
}
