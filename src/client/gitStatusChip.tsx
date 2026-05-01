import { api } from './api.js';
import { byIdOrNull, toElement } from './dom.js';
import { repositionGitStatusPopover, toggleGitStatusPopover } from './gitStatusPopover.js';
import { getActiveProject } from './state.js';

/**
 * HS-7954 — sidebar git status chip. Subscribes to (a) the existing
 * `/api/poll` long-poll's version-bump stream so a `.git/index` change
 * (commit / stage / branch switch — picked up by `src/git/watcher.ts`)
 * triggers an immediate refetch + re-render, and (b) `window.focus` so
 * the user alt-tabbing back from a terminal after `git commit` sees the
 * fresh state without a manual reload.
 *
 * Phase 1 fields displayed: branch, total uncommitted count (sum of
 * staged / unstaged / untracked / conflicted). Tints (left-to-right
 * precedence): conflicted \> dirty \> clean. The remote-tracking
 * (ahead / behind) glyphs + amber/blue tints are HS-7955 territory and
 * silently no-op here.
 *
 * See docs/48-git-status-tracker.md §48.4.
 */

interface GitStatusJson {
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  lastFetchedAt: number | null;
}

let chipEl: HTMLElement | null = null;
let branchEl: HTMLElement | null = null;
let countsEl: HTMLElement | null = null;
let lastStatus: GitStatusJson | null = null;
/**
 * HS-7993 — secret of the project whose status is currently shown by the
 * chip. Mismatched against `getActiveProject()?.secret` at the top of every
 * refresh; when they differ the cached value for the new project (or null)
 * is swapped in IMMEDIATELY before the API call so the user never sees the
 * previous project's stale state during the in-flight gap.
 */
let lastStatusSecret: string | null = null;
/**
 * HS-7993 — per-project status cache so a project switch is instant for any
 * project the user has visited at least once in the session. The active
 * project's entry is freshened by every successful API call. Session-only
 * (cleared on full reload) — fine because the worst case is one cold fetch
 * per project at startup.
 */
const lastStatusBySecret = new Map<string, GitStatusJson | null>();
/**
 * HS-7993 — coalesce concurrent refreshes WITHIN the same project (e.g.
 * window.focus + a poll-version-bump landing in the same tick). Cross-
 * project refreshes get their own entry because `/git/status` is per-
 * project; coalescing across projects would have the user staring at the
 * old project's data while a stale request finishes.
 */
const inFlightByKey = new Map<string, Promise<void>>();

/** Public — call once at app boot to wire the chip. */
export function initGitStatusChip(): void {
  chipEl = byIdOrNull('sidebar-git-chip');
  if (chipEl === null) return;
  branchEl = chipEl.querySelector<HTMLElement>('.sidebar-git-branch');
  countsEl = chipEl.querySelector<HTMLElement>('.sidebar-git-counts');

  // Initial fetch + re-paint.
  void refresh();

  // Re-fetch on window focus (user often alt-tabs back from a terminal
  // after `git commit` and expects to see the change).
  window.addEventListener('focus', () => { void refresh(); });

  // HS-7956 — click the chip to toggle the expanded popover.
  chipEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (chipEl !== null) toggleGitStatusPopover(chipEl);
  });
  // Keep the popover anchored on window resize.
  window.addEventListener('resize', repositionGitStatusPopover);
}

/** Public — call from the existing poll loop on every version bump so
 *  a .git/index change picked up by the server-side watcher → notifyChange()
 *  → poll wake → this refetch chain stays connected without a dedicated
 *  long-poll endpoint. */
export function refreshGitStatusChip(): void {
  void refresh();
}

/**
 * Pure: pick the value to display when the active project just switched.
 * Returns the cached status for `newSecret` (or null on first visit), so
 * the chip can repaint synchronously before the async API refresh lands.
 * Exported for testability — the rest of `refresh()` is DOM/network-bound.
 *
 * HS-7993 — see `docs/48-git-status-tracker.md` §48.6.
 */
export function pickDisplayStatusOnProjectSwitch(
  newSecret: string | null,
  cache: ReadonlyMap<string, GitStatusJson | null>,
): GitStatusJson | null {
  if (newSecret === null) return null;
  return cache.has(newSecret) ? cache.get(newSecret) ?? null : null;
}

async function refresh(): Promise<void> {
  if (chipEl === null) return;
  const currentSecret = getActiveProject()?.secret ?? null;

  // HS-7993 — instant project switch. When the active project changed since
  // we last rendered, swap to the cached value for the new project (or
  // null when first visit) before firing the API call. Without this, the
  // chip would keep showing the previous project's branch + dirty count
  // for the duration of the round-trip — exactly the "doesn't seem to
  // update when switching projects" complaint.
  if (currentSecret !== lastStatusSecret) {
    lastStatusSecret = currentSecret;
    lastStatus = pickDisplayStatusOnProjectSwitch(currentSecret, lastStatusBySecret);
    render();
  }

  // Coalesce concurrent refreshes for the SAME project. A switch to a
  // different project gets its own request because `/git/status` is
  // per-project — sharing the in-flight promise would resolve the new
  // request with the old project's response.
  const flightKey = currentSecret ?? '__none__';
  const existing = inFlightByKey.get(flightKey);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    try {
      const data = await api<GitStatusJson | null>('/git/status');
      // Stamp the per-project cache. `api()` captures the active project
      // secret at URL-build time, so even if the user switched mid-flight
      // the response still belongs to `currentSecret`.
      if (currentSecret !== null) lastStatusBySecret.set(currentSecret, data);
      // Only re-render when the chip is still on the same project — if
      // the user already switched away we'd flicker the new project's
      // chip with the old project's data.
      const nowSecret = getActiveProject()?.secret ?? null;
      if (nowSecret === currentSecret) {
        lastStatus = data;
        render();
      }
    } catch {
      // Network error — don't tear down the existing chip; keep the last
      // good state and try again on the next trigger.
    } finally {
      inFlightByKey.delete(flightKey);
    }
  })();
  inFlightByKey.set(flightKey, promise);
  return promise;
}

/** Pure: compute the tint class for a status. Exported for tests. */
export function tintForStatus(status: GitStatusJson): 'clean' | 'dirty' | 'conflicted' | 'ahead' | 'behind' {
  if (status.conflicted > 0) return 'conflicted';
  // Phase 2 (HS-7955) populates upstream/ahead/behind. Until then the
  // remote precedence tints never trigger.
  if (status.behind > 0) return 'behind';
  if (status.ahead > 0) return 'ahead';
  if (status.staged + status.unstaged + status.untracked > 0) return 'dirty';
  return 'clean';
}

/** Pure: compute the count string ("3" / "+1 / 12" / etc.) for the chip's
 *  right-side badge. Empty string when everything's zero (the clean state).
 *  Exported for tests. */
export function countsLabel(status: GitStatusJson): string {
  const local = status.staged + status.unstaged + status.untracked + status.conflicted;
  return local > 0 ? String(local) : '';
}

/** Pure: compute the ahead/behind glyph cluster for the chip ("↑3↓1" /
 *  "↑3" / "↓1" / "" when both zero). Exported for tests. HS-7955. */
export function aheadBehindLabel(status: GitStatusJson): string {
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`↑${status.ahead}`);
  if (status.behind > 0) parts.push(`↓${status.behind}`);
  return parts.join(' ');
}

/** Pure: compute the tooltip body. Exported for tests. HS-7955 extends to
 *  include the upstream + ahead/behind + last-fetched-relative when an
 *  upstream is configured. */
export function tooltipForStatus(status: GitStatusJson, nowMs: number = Date.now()): string {
  const parts: string[] = [];
  if (status.staged > 0) parts.push(`${status.staged} staged`);
  if (status.unstaged > 0) parts.push(`${status.unstaged} unstaged`);
  if (status.untracked > 0) parts.push(`${status.untracked} untracked`);
  if (status.conflicted > 0) parts.push(`${status.conflicted} conflicted`);
  if (parts.length === 0) parts.push('clean');
  const local = `${status.branch}: ${parts.join(', ')}`;
  // Phase 2 (HS-7955): ahead / behind / last-fetched relative.
  const remote: string[] = [];
  if (status.upstream !== null) {
    if (status.ahead > 0) remote.push(`${status.ahead} ahead`);
    if (status.behind > 0) remote.push(`${status.behind} behind`);
    if (remote.length === 0) remote.push('up to date');
    if (status.lastFetchedAt !== null) {
      remote.push(`last fetched ${formatRelativeTime(nowMs - status.lastFetchedAt)}`);
    }
    return `${local}\n${remote.join(', ')} (${status.upstream})`;
  }
  return local;
}

/** Pure: format a millisecond duration as a friendly relative-time string
 *  ("just now" / "5 minutes ago" / "2 hours ago" / "3 days ago"). */
export function formatRelativeTime(deltaMs: number): string {
  if (deltaMs < 60_000) return 'just now';
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function render(): void {
  if (chipEl === null) return;
  if (lastStatus === null) {
    chipEl.style.display = 'none';
    return;
  }
  chipEl.style.display = '';
  if (branchEl !== null) branchEl.textContent = lastStatus.branch;

  // HS-7955 — ahead/behind glyphs sit between the branch + the local
  // counts. Sub-element is created lazily on first render so Phase 1's
  // existing markup doesn't need a rebuild.
  let aheadBehindEl = chipEl.querySelector<HTMLElement>('.sidebar-git-aheadbehind');
  if (aheadBehindEl === null && countsEl !== null) {
    aheadBehindEl = toElement(<span className="sidebar-git-aheadbehind"></span>);
    countsEl.parentElement?.insertBefore(aheadBehindEl, countsEl);
  }
  if (aheadBehindEl !== null) {
    const ab = aheadBehindLabel(lastStatus);
    aheadBehindEl.textContent = ab;
    aheadBehindEl.style.display = ab === '' ? 'none' : '';
  }

  if (countsEl !== null) {
    const label = countsLabel(lastStatus);
    countsEl.textContent = label;
    countsEl.style.display = label === '' ? 'none' : '';
  }
  // Tint via class — clear all known tint classes first then add the
  // resolved one so transitions between states don't accumulate stale
  // tints.
  for (const cls of ['clean', 'dirty', 'conflicted', 'ahead', 'behind']) {
    chipEl.classList.remove(`is-${cls}`);
  }
  chipEl.classList.add(`is-${tintForStatus(lastStatus)}`);
  chipEl.title = tooltipForStatus(lastStatus);
}

/** HS-7955 — Phase 2: trigger a `git fetch` from the chip. The Phase 3
 *  popover (HS-7956) hosts a proper button; for now this is exposed for
 *  the tooltip / future toolbar to call. Resolves with the FetchResult. */
export interface FetchResult {
  ok: boolean;
  lastFetchedAt: number | null;
  error: string;
}

export async function triggerGitFetch(): Promise<FetchResult> {
  try {
    const result = await api<FetchResult>('/git/fetch', { method: 'POST' });
    // Whether the fetch succeeded or not, refresh the chip so the user sees
    // the new ahead/behind numbers (or the unchanged-with-error state).
    void refresh();
    return result;
  } catch (err) {
    return { ok: false, lastFetchedAt: null, error: err instanceof Error ? err.message : 'Network error' };
  }
}
