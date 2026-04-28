import { api } from './api.js';

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
 * precedence): conflicted > dirty > clean. The remote-tracking
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
let inFlight = false;
let inFlightPromise: Promise<void> | null = null;

/** Public — call once at app boot to wire the chip. */
export function initGitStatusChip(): void {
  chipEl = document.getElementById('sidebar-git-chip');
  if (chipEl === null) return;
  branchEl = chipEl.querySelector<HTMLElement>('.sidebar-git-branch');
  countsEl = chipEl.querySelector<HTMLElement>('.sidebar-git-counts');

  // Initial fetch + re-paint.
  void refresh();

  // Re-fetch on window focus (user often alt-tabs back from a terminal
  // after `git commit` and expects to see the change).
  window.addEventListener('focus', () => { void refresh(); });
}

/** Public — call from the existing poll loop on every version bump so
 *  a .git/index change picked up by the server-side watcher → notifyChange()
 *  → poll wake → this refetch chain stays connected without a dedicated
 *  long-poll endpoint. */
export function refreshGitStatusChip(): void {
  void refresh();
}

async function refresh(): Promise<void> {
  if (chipEl === null) return;
  // Coalesce concurrent refresh requests (e.g. focus + poll-bump within
  // the same tick) so we don't multi-spawn the API call.
  if (inFlight && inFlightPromise !== null) return inFlightPromise;
  inFlight = true;
  inFlightPromise = (async () => {
    try {
      const data = await api<GitStatusJson | null>('/git/status');
      lastStatus = data;
      render();
    } catch {
      // Network error — don't tear down the existing chip; keep the last
      // good state and try again on the next trigger.
    } finally {
      inFlight = false;
      inFlightPromise = null;
    }
  })();
  return inFlightPromise;
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
    aheadBehindEl = document.createElement('span');
    aheadBehindEl.className = 'sidebar-git-aheadbehind';
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
