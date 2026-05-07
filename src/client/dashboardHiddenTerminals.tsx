/**
 * HS-7661 / HS-7825 / HS-7826 / HS-8290 — Hidden-terminal state for both
 * the global Terminal Dashboard (§25) and the per-project Drawer Terminal
 * Grid (§36).
 *
 * **State shape (HS-8290).** Single global `GlobalVisibilityState` —
 * `{ groupings: VisibilityGrouping[], activeId: string }` — held in a
 * module-private variable. Each grouping's `hiddenByProject: Record<secret, string[]>`
 * is the per-project hidden-id store; the grouping list itself + active id
 * are global. Pre-HS-8290 each project had its own `ProjectVisibilityState`
 * stored under `visibility_groupings` in `.hotsheet/settings.json`, which
 * required a cross-project fan-out machinery to keep duplicated grouping
 * lists aligned (§39.7). HS-8290 collapses that into one source of truth.
 *
 * The Default grouping is always present and acts as the post-HS-7825
 * single-grouping compatibility surface — pre-HS-7826 callers that only
 * know about a flat `(secret, terminalId) → isHidden` world continue to
 * work via the helpers below, which delegate to whichever grouping is
 * currently active.
 *
 * Subscribers (the dashboard, drawer-grid, dialog) receive change
 * notifications via `subscribeToHiddenChanges(handler)` for any change —
 * a row toggle, a tab switch, a grouping rename / delete / reorder, or a
 * persisted-state hydrate.
 *
 * **Persistence.** See docs/39-visibility-groupings.md (HS-8290 rewrite).
 * The `persistedHiddenTerminals.ts` module subscribes to changes and
 * PATCHes the global config endpoint
 * (`/api/dashboard/global-config` body `{ dashboard: { visibilityGroupings, activeVisibilityGroupingId } }`).
 */

import { toElement } from './dom.js';
import {
  addGrouping as addGroupingPure,
  DEFAULT_GROUPING_ID,
  deleteGrouping as deleteGroupingPure,
  getActiveGrouping,
  getHiddenIdsForProject,
  type GlobalVisibilityState,
  initialGlobalState,
  pruneStaleIdsInGroupings,
  renameGrouping as renameGroupingPure,
  reorderGroupings as reorderGroupingsPure,
  setActiveGroupingId as setActiveGroupingIdPure,
  toggleHiddenInGrouping,
  updateGroupingById,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

let globalState: GlobalVisibilityState = initialGlobalState();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const handler of subscribers) {
    try { handler(); } catch { /* swallow — subscriber callbacks are advisory */ }
  }
}

/** Replace the global state and fire change notifications when the
 *  reference actually changed. Single source-of-truth for mutations. */
function setGlobalState(next: GlobalVisibilityState): void {
  if (globalState === next) return;
  globalState = next;
  notify();
}

// ---------------------------------------------------------------------------
// Pre-HS-7826 single-grouping public API. Every helper delegates to the
// active grouping.
// ---------------------------------------------------------------------------

/** True when this `(secret, terminalId)` pair is hidden in the active
 *  grouping. */
export function isTerminalHidden(secret: string, terminalId: string): boolean {
  const active = getActiveGrouping(globalState);
  return getHiddenIdsForProject(active, secret).includes(terminalId);
}

/** Return a fresh set of hidden terminal ids for `secret` in the active
 *  grouping. Returned set is a copy — mutating it does NOT affect module
 *  state; use `setTerminalHidden` to make changes. */
export function getHiddenTerminals(secret: string): Set<string> {
  const active = getActiveGrouping(globalState);
  return new Set(getHiddenIdsForProject(active, secret));
}

/** Toggle the hidden state for a `(secret, terminalId)` pair against the
 *  active grouping. */
export function setTerminalHidden(secret: string, terminalId: string, hide: boolean): void {
  const active = getActiveGrouping(globalState);
  const next = updateGroupingById(globalState, active.id, g => toggleHiddenInGrouping(g, secret, terminalId, hide));
  setGlobalState(next);
}

/** Filter a TileEntry-like list down to visible-only ids in `secret`'s
 *  active-grouping hidden set. */
export function filterVisible<T extends { id: string }>(secret: string, entries: T[]): T[] {
  const active = getActiveGrouping(globalState);
  const ids = getHiddenIdsForProject(active, secret);
  if (ids.length === 0) return entries;
  const set = new Set(ids);
  return entries.filter(e => !set.has(e.id));
}

/** Clear all hidden state for ONE project's active grouping. */
export function unhideAllInProject(secret: string): void {
  const active = getActiveGrouping(globalState);
  if (getHiddenIdsForProject(active, secret).length === 0) return;
  const next = updateGroupingById(globalState, active.id, g => {
    if ((g.hiddenByProject[secret] ?? []).length === 0) return g;
    const nextByProject: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(g.hiddenByProject)) {
      if (k !== secret) nextByProject[k] = v;
    }
    return { ...g, hiddenByProject: nextByProject };
  });
  setGlobalState(next);
}

/** Clear hidden state across EVERY project in the active grouping. Used
 *  by the global Terminal Dashboard's "Show all" link. */
export function unhideAllEverywhere(): void {
  const active = getActiveGrouping(globalState);
  if (Object.keys(active.hiddenByProject).length === 0) return;
  const next = updateGroupingById(globalState, active.id, g => ({ ...g, hiddenByProject: {} }));
  setGlobalState(next);
}

/** Subscribe to hidden-state changes. Returns an unsubscribe function. */
export function subscribeToHiddenChanges(handler: () => void): () => void {
  subscribers.add(handler);
  return () => { subscribers.delete(handler); };
}

/** Total number of hidden terminals across every project in the active
 *  grouping. */
export function countHiddenAcrossAllProjects(): number {
  const active = getActiveGrouping(globalState);
  let total = 0;
  for (const ids of Object.values(active.hiddenByProject)) total += ids.length;
  return total;
}

/** Number of hidden terminals scoped to a single project's active grouping. */
export function countHiddenForProject(secret: string): number {
  const active = getActiveGrouping(globalState);
  return getHiddenIdsForProject(active, secret).length;
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
    badge = toElement(<span className="hide-btn-badge" />) as HTMLSpanElement;
    button.appendChild(badge);
  }
  const text = count > 99 ? '99+' : String(count);
  if (badge.textContent !== text) badge.textContent = text;
}

/** Clear ALL state — used by tests so each spec can start clean. */
export function _resetForTests(): void {
  globalState = initialGlobalState();
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
 * HS-8290 — hydrate the global state from a parsed `GlobalVisibilityState`
 * (typically returned by `parsePersistedState` reading
 * `dashboard.visibilityGroupings` + `dashboard.activeVisibilityGroupingId`
 * from the global config endpoint). Dynamic ids are filtered out of every
 * grouping's per-project hidden lists. Idempotent — equal-by-content
 * hydrates short-circuit so subscribers don't fire spuriously.
 */
export function hydratePersistedGlobalState(state: GlobalVisibilityState): void {
  const sanitised: GlobalVisibilityState = {
    groupings: state.groupings.map(g => {
      const cleaned: Record<string, string[]> = {};
      for (const [secret, ids] of Object.entries(g.hiddenByProject)) {
        const kept = ids.filter(isConfiguredTerminalId);
        if (kept.length > 0) cleaned[secret] = kept;
      }
      return { ...g, hiddenByProject: cleaned };
    }),
    activeId: state.activeId,
  };
  if (globalStateEquals(globalState, sanitised)) return;
  setGlobalState(sanitised);
}

function globalStateEquals(a: GlobalVisibilityState, b: GlobalVisibilityState): boolean {
  if (a.activeId !== b.activeId) return false;
  if (a.groupings.length !== b.groupings.length) return false;
  for (let i = 0; i < a.groupings.length; i++) {
    const ga = a.groupings[i];
    const gb = b.groupings[i];
    if (ga.id !== gb.id || ga.name !== gb.name) return false;
    const aSecrets = Object.keys(ga.hiddenByProject);
    const bSecrets = Object.keys(gb.hiddenByProject);
    if (aSecrets.length !== bSecrets.length) return false;
    const bSecretSet = new Set(bSecrets);
    for (const secret of aSecrets) {
      if (!bSecretSet.has(secret)) return false;
      const aIds = ga.hiddenByProject[secret];
      const bIds = gb.hiddenByProject[secret];
      if (aIds.length !== bIds.length) return false;
      const setA = new Set(aIds);
      for (const id of bIds) if (!setA.has(id)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// HS-7826 grouping management API. Post-HS-8290 these are global (no
// `secret` parameter on grouping CRUD).
// ---------------------------------------------------------------------------

/** Read the current global state. Live state — callers MUST NOT mutate;
 *  use the helpers below to make changes. */
export function getGlobalVisibilityState(): GlobalVisibilityState {
  return globalState;
}

/** List the global groupings (display order). */
export function getGroupings(): VisibilityGrouping[] {
  return globalState.groupings;
}

/** Active grouping id. */
export function getActiveGroupingId(): string {
  return globalState.activeId;
}

/** Switch the active grouping. Fires the change subscription so the
 *  dashboard / drawer-grid filter re-applies. */
export function setActiveGrouping(id: string): void {
  setGlobalState(setActiveGroupingIdPure(globalState, id));
}

/** Add a new grouping. Returns the new grouping (so the caller can
 *  immediately switch to it / focus its tab). */
export function addGrouping(name: string): VisibilityGrouping {
  const { state: next, grouping } = addGroupingPure(globalState, name);
  setGlobalState(next);
  return grouping;
}

/** Rename a grouping. No-op when name doesn't change after trimming. */
export function renameGrouping(id: string, name: string): void {
  setGlobalState(renameGroupingPure(globalState, id, name));
}

/** Delete a grouping (Default is refused; activeId falls back to Default
 *  when the deleted grouping was active). */
export function deleteGrouping(id: string): void {
  if (id === DEFAULT_GROUPING_ID) return;
  setGlobalState(deleteGroupingPure(globalState, id));
}

/** Reorder groupings (drag-and-drop) — moves fromId into toId's slot. */
export function reorderGroupings(fromId: string, toId: string): void {
  setGlobalState(reorderGroupingsPure(globalState, fromId, toId));
}

/** Toggle a terminal's hidden state in a SPECIFIC grouping (not necessarily
 *  the active one) for a SPECIFIC project. Used by the dialog when the
 *  user is on a non-active grouping's tab and toggles a row. */
export function setTerminalHiddenInGrouping(
  secret: string,
  groupingId: string,
  terminalId: string,
  hide: boolean,
): void {
  const next = updateGroupingById(globalState, groupingId, g => toggleHiddenInGrouping(g, secret, terminalId, hide));
  setGlobalState(next);
}

/** Read whether a terminal is hidden in a SPECIFIC grouping (parallel to
 *  isTerminalHidden which reads the active one). */
export function isTerminalHiddenInGrouping(
  secret: string,
  groupingId: string,
  terminalId: string,
): boolean {
  const grouping = globalState.groupings.find(g => g.id === groupingId);
  if (grouping === undefined) return false;
  return getHiddenIdsForProject(grouping, secret).includes(terminalId);
}

/** Clear hidden state for `secret` in a SPECIFIC grouping. */
export function unhideAllInGrouping(secret: string, groupingId: string): void {
  const next = updateGroupingById(globalState, groupingId, g => {
    if (!Object.prototype.hasOwnProperty.call(g.hiddenByProject, secret)) return g;
    if (g.hiddenByProject[secret].length === 0) return g;
    const nextByProject: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(g.hiddenByProject)) {
      if (k !== secret) nextByProject[k] = v;
    }
    return { ...g, hiddenByProject: nextByProject };
  });
  setGlobalState(next);
}

/** Clear hidden state across EVERY project in a SPECIFIC grouping. */
export function unhideAllEverywhereInGrouping(groupingId: string): void {
  const next = updateGroupingById(globalState, groupingId, g => {
    if (Object.keys(g.hiddenByProject).length === 0) return g;
    return { ...g, hiddenByProject: {} };
  });
  setGlobalState(next);
}

/** HS-8063 — hide every supplied terminal id for `secret` in a SPECIFIC
 *  grouping. Used by the dialog's "Hide All" button. Idempotent. */
export function hideAllInGrouping(
  secret: string,
  groupingId: string,
  terminalIds: readonly string[],
): void {
  if (terminalIds.length === 0) return;
  const next = updateGroupingById(globalState, groupingId, g => {
    let updated = g;
    for (const id of terminalIds) {
      updated = toggleHiddenInGrouping(updated, secret, id, true);
    }
    return updated;
  });
  setGlobalState(next);
}

/**
 * HS-8016 — drop any id from every grouping's `hiddenByProject[secret]`
 * that's not in `knownIds`. Called whenever a fresh `/terminal/list`
 * round-trip lands so the eye-icon count badge stops reflecting terminals
 * that no longer exist. Notifies subscribers exactly once when at least
 * one grouping actually changed.
 */
export function pruneHiddenForProject(secret: string, knownIds: readonly string[]): void {
  const knownSet = new Set(knownIds);
  const pruned = pruneStaleIdsInGroupings(globalState.groupings, secret, knownSet);
  if (pruned === null) return;
  setGlobalState({ groupings: pruned, activeId: globalState.activeId });
}

/**
 * HS-7949 follow-up — mark a freshly-added terminal id as hidden in every
 * non-Default grouping for one project. Mirrors the rule that pre-HS-8290
 * lived server-side in `addNewTerminalsToNonDefaultGroupings`. Without
 * this, a freshly-added terminal pops up in every named grouping.
 *
 * No-op when there are no non-Default groupings or the id is already
 * hidden in every non-Default grouping. Exported for unit tests.
 */
export function hideNewTerminalInNonDefaultGroupings(secret: string, terminalId: string): void {
  const groupings = globalState.groupings.map(g => {
    if (g.id === DEFAULT_GROUPING_ID) return g;
    const current = g.hiddenByProject[secret] ?? [];
    if (current.includes(terminalId)) return g;
    return {
      ...g,
      hiddenByProject: { ...g.hiddenByProject, [secret]: [...current, terminalId] },
    };
  });
  const anyChanged = groupings.some((g, i) => g !== globalState.groupings[i]);
  if (!anyChanged) return;
  setGlobalState({ groupings, activeId: globalState.activeId });
}
