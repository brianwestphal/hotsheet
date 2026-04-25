/**
 * HS-7661 — Hidden-terminal state for both the global Terminal Dashboard
 * (§25) and the per-project Drawer Terminal Grid (§36).
 *
 * State shape: a Map keyed by project secret → Set of hidden terminal ids
 * within that project. Composite scoping ({secret, terminalId}) is required
 * because terminal ids collide across projects (every project has a
 * `default` terminal).
 *
 * Subscribers (the dashboard and drawer-grid render paths) get notified
 * via `subscribe(handler)` whenever the hidden set for any project
 * changes, so they can re-render their tile lists.
 *
 * Persistence (HS-7825) — see docs/38-terminal-visibility.md.
 * Configured-terminal hidden state is persisted PER PROJECT to the
 * `hidden_terminals` key in `.hotsheet/settings.json`; dynamic-terminal
 * (`dyn-*`) hidden state remains session-only. This file's own state is
 * still the source of truth at runtime — the persistence layer is a thin
 * wrapper around `setTerminalHidden` / `unhideAllInProject` that fires a
 * debounced PATCH when a configured-id flips. Initial hydration happens
 * in `initPersistedHiddenTerminals()` (called from app boot).
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

/** Total number of hidden terminals across every project (HS-7823 — drives
 *  the dashboard eye-icon badge count). */
export function countHiddenAcrossAllProjects(): number {
  let total = 0;
  for (const set of hidden.values()) total += set.size;
  return total;
}

/** Number of hidden terminals scoped to a single project (HS-7823 — drives
 *  the drawer-grid eye-icon badge count). */
export function countHiddenForProject(secret: string): number {
  return hidden.get(secret)?.size ?? 0;
}

/**
 * HS-7823 — render or remove a small numeric badge on an eye-icon button to
 * indicate how many terminals are currently hidden in the relevant scope.
 * Idempotent: writing 0 (or a negative) removes the badge entirely. The
 * badge element is `<span class="hide-btn-badge">{n}</span>` and lives
 * inside the button so existing button-level styles (display, margin) keep
 * working.
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
  hidden.clear();
  subscribers.clear();
}

/**
 * HS-7825 — true when a terminal id refers to a *configured* (settings-
 * backed) terminal whose hidden state should be persisted across sessions.
 * Dynamic terminals (created via POST /api/terminal/create) use the
 * `dyn-` prefix and are intentionally NOT persisted — they're a per-session
 * concept whose lifetime ends with the PTY anyway.
 */
export function isConfiguredTerminalId(terminalId: string): boolean {
  return !terminalId.startsWith('dyn-');
}

/**
 * HS-7825 — hydrate the in-memory hidden set for a project from a list of
 * persisted ids (typically from `/file-settings.hidden_terminals`). Skips
 * notification by default — caller may want to populate state for several
 * projects in a single batch and trigger one render at the end.
 *
 * Treats the persisted list as authoritative for *configured* ids only —
 * any `dyn-` prefixed entries are silently dropped (defense in depth in
 * case the persistence layer ever races a dynamic terminal toggle).
 */
export function hydratePersistedHiddenForProject(secret: string, ids: readonly string[]): void {
  const filtered = ids.filter(isConfiguredTerminalId);
  if (filtered.length === 0) {
    if (hidden.has(secret)) {
      hidden.delete(secret);
      notify();
    }
    return;
  }
  const next = new Set(filtered);
  const existing = hidden.get(secret);
  // Cheap structural equality so we don't fire notify for a no-op.
  if (existing !== undefined && existing.size === next.size) {
    let same = true;
    for (const id of next) if (!existing.has(id)) { same = false; break; }
    if (same) return;
  }
  hidden.set(secret, next);
  notify();
}
