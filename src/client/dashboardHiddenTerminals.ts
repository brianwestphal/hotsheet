/**
 * HS-7661 — Hidden-terminal state for both the global Terminal Dashboard
 * (§25) and the per-project Drawer Terminal Grid (§36).
 *
 * Session-only — wipes on page reload (per the user's feedback answer
 * "1. c"). The deliberately-volatile choice means the user can hide tiles
 * to declutter the current view without committing to a permanent setting,
 * and a fresh page load resets to "show everything" — discoverable by
 * default. If the user wants persistence we'd add a `/file-settings` key
 * later.
 *
 * State shape: a Map keyed by project secret → Set of hidden terminal ids
 * within that project. Composite scoping ({secret, terminalId}) is required
 * because terminal ids collide across projects (every project has a
 * `default` terminal).
 *
 * Subscribers (the dashboard and drawer-grid render paths) get notified
 * via `subscribe(handler)` whenever the hidden set for any project
 * changes, so they can re-render their tile lists.
 */

const hidden = new Map<string, Set<string>>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const handler of subscribers) {
    try { handler(); } catch { /* swallow — subscriber callbacks are advisory */ }
  }
}

/** True when this `(secret, terminalId)` pair has been hidden in the
 *  current session. */
export function isTerminalHidden(secret: string, terminalId: string): boolean {
  return hidden.get(secret)?.has(terminalId) === true;
}

/** Return a fresh set of hidden terminal ids for this project. Returned
 *  set is a copy — mutating it does NOT affect module state; callers
 *  should use `setTerminalHidden` to make changes. */
export function getHiddenTerminals(secret: string): Set<string> {
  const set = hidden.get(secret);
  return set === undefined ? new Set() : new Set(set);
}

/** Toggle the hidden state for a `(secret, terminalId)` pair.
 *  Adding to an empty set creates the per-project entry; removing the
 *  last id deletes the entry so `hidden` doesn't accumulate empty sets. */
export function setTerminalHidden(secret: string, terminalId: string, hide: boolean): void {
  let set = hidden.get(secret);
  if (hide) {
    if (set === undefined) {
      set = new Set();
      hidden.set(secret, set);
    }
    if (set.has(terminalId)) return; // no-op
    set.add(terminalId);
  } else {
    if (set === undefined || !set.has(terminalId)) return; // no-op
    set.delete(terminalId);
    if (set.size === 0) hidden.delete(secret);
  }
  notify();
}

/** Filter a TileEntry-like list down to visible-only ids for one project. */
export function filterVisible<T extends { id: string }>(secret: string, entries: T[]): T[] {
  const set = hidden.get(secret);
  if (set === undefined || set.size === 0) return entries;
  return entries.filter(e => !set.has(e.id));
}

/** Clear all hidden state for one project (used by "Show all" links). */
export function unhideAllInProject(secret: string): void {
  if (!hidden.has(secret)) return;
  hidden.delete(secret);
  notify();
}

/** Clear hidden state across every project. Used by the global
 *  Terminal Dashboard's all-projects "Show all" link. */
export function unhideAllEverywhere(): void {
  if (hidden.size === 0) return;
  hidden.clear();
  notify();
}

/** Subscribe to hidden-state changes. Returns an unsubscribe function. */
export function subscribeToHiddenChanges(handler: () => void): () => void {
  subscribers.add(handler);
  return () => { subscribers.delete(handler); };
}

/** Clear ALL state — used by tests so each spec can start clean. */
export function _resetForTests(): void {
  hidden.clear();
  subscribers.clear();
}
