/**
 * HS-8725 (load resilience, docs/75 §75.6 Phase 3) — active-project tracking.
 *
 * "Foreground" / "active" = a project a client is currently looking at, signalled
 * implicitly by its `/api/poll` long-poll (the poll is always scoped to the
 * project the webview is showing, via the `X-Hotsheet-Secret` middleware). The
 * poll route calls `markProjectActive(dataDir)` on every wake; the git watcher
 * reads `isProjectActive(dataDir)` to decide whether a `.git` change should do
 * proactive refresh work (wake the poll + pre-warm git status) or just bust the
 * cache and wait to be refreshed lazily when the user switches to that tab.
 *
 * Why this matters: with N project tabs open, a per-project watcher firing
 * proactive refresh on every `.git` nudge is O(N) background work on the shared
 * event loop. Scoping the proactive work to the actively-viewed project collapses
 * it toward O(1) regardless of how many projects are registered — the scaling
 * lever of the load-resilience epic.
 *
 * Keyed by `dataDir` (the canonical project identity used across the server).
 * Recency-based so it works for the single-webview case today AND the
 * multiple-simultaneous-clients future (§46): any project polled within the TTL
 * is active, which is naturally the union of every connected client's view.
 */

/** A project polled within this window counts as active. Must comfortably
 *  exceed the `/api/poll` 30 s long-poll timeout (consecutive polls refresh the
 *  timestamp every ≤30 s) so an actively-viewed project never lapses between
 *  polls. */
const ACTIVE_TTL_MS = 90_000;

const lastActiveAt = new Map<string, number>();

/** Record that a client is actively viewing this project (called from the
 *  `/api/poll` route on every wake). */
export function markProjectActive(dataDir: string): void {
  lastActiveAt.set(dataDir, Date.now());
}

/**
 * Is this project actively being viewed by some client?
 *
 * Returns `true` as a safe default when NO project has ever been marked active
 * (e.g. right after boot, or a client that never polls) so behavior never
 * regresses below today's "refresh everything" baseline. Once any project has
 * reported, only projects polled within `ACTIVE_TTL_MS` are active.
 */
export function isProjectActive(dataDir: string): boolean {
  if (lastActiveAt.size === 0) return true;
  const at = lastActiveAt.get(dataDir);
  if (at === undefined) return false;
  return Date.now() - at < ACTIVE_TTL_MS;
}

/** Test-only — drop all tracking so cases don't bleed into each other. */
export function _resetActiveProjectsForTests(): void {
  lastActiveAt.clear();
}
