import { existsSync, type FSWatcher, watch as fsWatch } from 'fs';
import { join } from 'path';

import { getGitRoot, isGitRepo } from '../gitignore.js';
import { type GitStatus, getGitStatus } from './status.js';

/**
 * HS-7954 — git status cache + filesystem watcher.
 *
 * Two responsibilities glued together:
 *
 * 1. **500 ms result cache** so multiple clients hitting `/api/git/status`
 *    + the on-window-focus refetch + the on-version-bump refetch within the
 *    same tick don't multi-spawn `git status --porcelain`.
 * 2. **`.git/index` + `.git/HEAD` watcher** so a commit / stage / branch-
 *    switch made outside Hot Sheet (in the user's terminal) bumps a per-
 *    project version counter that the existing `/api/poll` long-poll
 *    forwards to subscribed clients. The clients then refetch
 *    `/api/git/status` and re-render the chip without the user needing to
 *    alt-tab / refresh.
 *
 * The watcher uses Node's built-in `fs.watch` (no chokidar dep). On
 * platforms where `fs.watch` is flaky for ref-pack rotations
 * (macOS most notably) the worst-case is a stale chip until the next
 * focus-refetch fires — acceptable degradation.
 *
 * `.git/index.lock` is filtered out: `git status` itself touches the
 * index-lock briefly while reading, which would otherwise trigger an
 * infinite "git status → mtime change → /poll wake → git status" loop.
 */

const CACHE_TTL_MS = 500;

interface CachedEntry {
  status: GitStatus | null;
  resolvedAt: number;
}

const cache = new Map<string, CachedEntry>();

/**
 * Cached read of the git status. Within `CACHE_TTL_MS` of the last
 * resolution, returns the cached value. Otherwise re-runs `getGitStatus`
 * and caches the result.
 */
export function getCachedGitStatus(projectRoot: string): GitStatus | null {
  const entry = cache.get(projectRoot);
  const now = Date.now();
  if (entry !== undefined && now - entry.resolvedAt < CACHE_TTL_MS) {
    return entry.status;
  }
  const status = getGitStatus(projectRoot);
  cache.set(projectRoot, { status, resolvedAt: now });
  return status;
}

/** Test-only — clear the cache so each test starts from a clean slate. */
export function _resetGitStatusCacheForTests(): void {
  cache.clear();
}

/** HS-7955 — drop the cached entry for one project. Called from the
 *  `POST /api/git/fetch` route after a successful fetch so the next
 *  `/git/status` read picks up the updated ahead/behind numbers
 *  immediately rather than serving the pre-fetch cached value. */
export function dropGitStatusCache(projectRoot: string): void {
  cache.delete(projectRoot);
}

// ---------------------------------------------------------------------------
// Watcher
// ---------------------------------------------------------------------------

interface WatcherEntry {
  /** The two `fs.watch` handles for `.git/index` and `.git/HEAD`. */
  watchers: FSWatcher[];
  /** Per-project monotonic counter — bumped on every detected change. */
  version: number;
  /** HS-7972 — pending debounce timer. macOS `fs.watch` fires multiple times
   *  for a single git operation (and occasionally spuriously when the
   *  channel server is busy); without this debounce a burst can trigger 10+
   *  `/api/poll` wakes per second, causing visible UI thrash (project tabs
   *  + ticket list + detail panel re-render every 100 ms). */
  debounce: NodeJS.Timeout | null;
}

/** HS-7972 — coalesce burst fs.watch events into a single notification.
 *  250 ms is short enough that a real `git commit` still feels instant in
 *  the chip but long enough that macOS' multi-event bursts collapse. */
const WATCHER_DEBOUNCE_MS = 250;

const watchers = new Map<string, WatcherEntry>();
const subscribers = new Set<(projectRoot: string) => void>();

/**
 * Subscribe to "git state changed" notifications. The callback fires with
 * the project root whose state moved. Returns an unsubscribe function.
 */
export function subscribeToGitChanges(handler: (projectRoot: string) => void): () => void {
  subscribers.add(handler);
  return () => { subscribers.delete(handler); };
}

/** Read the per-project change version. Useful for the long-poll layer to
 *  decide whether to wake. Returns 0 when no watcher has ever fired. */
export function getGitChangeVersion(projectRoot: string): number {
  return watchers.get(projectRoot)?.version ?? 0;
}

/**
 * Set up `.git/index` + `.git/HEAD` watchers for a project root. Idempotent
 * — calling twice for the same root reuses the existing watchers. No-op
 * when the project isn't a git repo OR `git` doesn't exist on PATH.
 */
export function ensureGitWatcher(projectRoot: string): void {
  if (watchers.has(projectRoot)) return;
  if (!isGitRepo(projectRoot)) return;
  const gitRoot = getGitRoot(projectRoot);
  if (gitRoot === null) return;
  const gitDir = join(gitRoot, '.git');
  if (!existsSync(gitDir)) return; // worktree / submodule with .git as a file — skip for v1

  const filenames = ['index', 'HEAD'];
  const handles: FSWatcher[] = [];

  // HS-7972 — debounced notify. fs.watch on macOS frequently fires multiple
  // events per single git operation (and is otherwise unreliable when the
  // user's terminal is touching the working tree). Without coalescing, a
  // burst can wake the long-poll 10× per second, triggering visible UI
  // thrash. 250 ms collapses bursts while keeping a real commit instant.
  const fireDebounced = () => {
    const entry = watchers.get(projectRoot);
    if (entry === undefined) return;
    if (entry.debounce !== null) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      const e2 = watchers.get(projectRoot);
      if (e2 === undefined) return;
      e2.debounce = null;
      cache.delete(projectRoot);
      e2.version++;
      for (const sub of subscribers) {
        try { sub(projectRoot); } catch { /* swallow */ }
      }
    }, WATCHER_DEBOUNCE_MS);
  };

  for (const file of filenames) {
    const target = join(gitDir, file);
    if (!existsSync(target)) continue;
    try {
      const handle = fsWatch(target, () => fireDebounced());
      handles.push(handle);
    } catch {
      // fs.watch isn't supported on every filesystem (e.g. some FUSE
      // mounts). Degraded mode — focus-refetch on the client still works.
    }
  }
  watchers.set(projectRoot, { watchers: handles, version: 0, debounce: null });
}

/** Tear down a project's watcher + drop its cache entry. Called on
 *  project removal. */
export function disposeGitWatcher(projectRoot: string): void {
  const entry = watchers.get(projectRoot);
  if (entry !== undefined) {
    for (const handle of entry.watchers) {
      try { handle.close(); } catch { /* ignore */ }
    }
    if (entry.debounce !== null) clearTimeout(entry.debounce);
    watchers.delete(projectRoot);
  }
  cache.delete(projectRoot);
}

/** Tear down EVERY watcher. Called from the graceful-shutdown pipeline. */
export function disposeAllGitWatchers(): void {
  for (const root of [...watchers.keys()]) disposeGitWatcher(root);
  subscribers.clear();
}
