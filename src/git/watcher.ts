import { existsSync, type FSWatcher, watch as fsWatch } from 'fs';
import { join } from 'path';

import { isProjectActive } from '../activeProjects.js';
import { getGitRoot, isGitRepo } from '../gitignore.js';
import { getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';
import { getGitStatus,type GitStatus } from './status.js';

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
 * HS-9109 — we watch the **`.git` directory**, NOT the individual `index` /
 * `HEAD` files. git updates the index atomically: it writes `.git/index.lock`
 * then *renames* it over `.git/index`, which REPLACES the file's inode. An
 * `fs.watch` bound to the file path keeps watching the now-orphaned old inode,
 * so it fires (at most) once and then goes silent — the chip stopped updating on
 * subsequent stages/commits until a `window.focus` / project-switch refetch (the
 * reported "doesn't update until switching tabs" bug). A directory watch survives
 * the rename because the directory's inode is stable; we filter the reported
 * filename down to the two entries we care about.
 *
 * `.git/index.lock` is filtered out (we only act on `index` / `HEAD`). Hot
 * Sheet's own status reads run with `GIT_OPTIONAL_LOCKS=0` (see `src/git/status.ts`)
 * so they never write the index — they can't self-trigger this watcher.
 */

const CACHE_TTL_MS = 500;

interface CachedEntry {
  status: GitStatus | null;
  resolvedAt: number;
}

const cache = new Map<string, CachedEntry>();

/** HS-8723 — in-flight de-duplication. The (now async) `getGitStatus` shells
 *  out to git over several hundred ms. A single `.git` change wakes the poll
 *  for EVERY open tab, and each tab refetches `/api/git/status` for its
 *  project; without this map, N concurrent reads of the same project would
 *  each spawn their own git chain. Keying the pending Promise here collapses
 *  that burst to ONE git run per project — the rest await the same result. */
const inFlight = new Map<string, Promise<GitStatus | null>>();

/**
 * Cached read of the git status. Within `CACHE_TTL_MS` of the last
 * resolution, returns the cached value synchronously. Otherwise awaits a
 * single in-flight `getGitStatus` (shared across concurrent callers) and
 * caches the result.
 */
export async function getCachedGitStatus(projectRoot: string): Promise<GitStatus | null> {
  const entry = cache.get(projectRoot);
  const now = Date.now();
  if (entry !== undefined && now - entry.resolvedAt < CACHE_TTL_MS) {
    return entry.status;
  }
  // Coalesce concurrent misses onto one git run.
  const pending = inFlight.get(projectRoot);
  if (pending !== undefined) return pending;
  const p = (async () => {
    try {
      const status = await getGitStatus(projectRoot);
      cache.set(projectRoot, { status, resolvedAt: Date.now() });
      return status;
    } finally {
      inFlight.delete(projectRoot);
    }
  })();
  inFlight.set(projectRoot, p);
  return p;
}

/** Test-only — clear the cache so each test starts from a clean slate. */
export function _resetGitStatusCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  lastSig.clear(); // HS-9111
}

/** HS-7955 — drop the cached entry for one project. Called from the
 *  `POST /api/git/fetch` route after a successful fetch so the next
 *  `/git/status` read picks up the updated ahead/behind numbers
 *  immediately rather than serving the pre-fetch cached value. HS-8723 —
 *  also drop any in-flight read so a pre-fetch result can't repopulate the
 *  cache with stale ahead/behind after the drop. */
export function dropGitStatusCache(projectRoot: string): void {
  cache.delete(projectRoot);
  inFlight.delete(projectRoot);
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

// ---------------------------------------------------------------------------
// HS-9111 — foreground working-tree poll (docs/48 §48.3.3)
// ---------------------------------------------------------------------------
//
// The `.git`-directory watcher above only fires on `index` / `HEAD` writes
// (stage / commit / branch-switch). A **working-tree-only** edit — a tracked
// file modified, or a new untracked file created — touches neither, so the
// chip's unstaged / untracked counts wouldn't refresh until the next
// `window.focus` / project-switch refetch.
//
// We deliberately do NOT recursively watch the working tree: `fs.watch(...,
// {recursive:true})` isn't supported on Linux, and on macOS it would fan out a
// huge event volume from `node_modules` / `dist` / build output. Instead we
// poll `git status` at a low frequency for the **foreground** project(s) only
// (the same `isProjectActive` gate the watcher's proactive path uses) and bump
// the version when the working-tree signature changes. `git status` already
// honors `.gitignore`, so `node_modules` / `dist` never register — no central
// exclusion list to maintain. Cost is bounded: one cheap (cached/coalesced)
// `git status` per foreground project every few seconds.

const WORKING_TREE_POLL_MS = 4000;

/** Last-observed working-tree signature per project root. Lets the poll fire
 *  ONLY on an actual change, and lets the `.git`-watcher path (which already
 *  reads fresh status on its pre-warm) update the baseline so the poll doesn't
 *  redundantly re-notify a stage/commit the watcher already caught. */
const lastSig = new Map<string, string>();

let workingTreePoller: ReturnType<typeof setInterval> | null = null;

/** Collapse a `GitStatus` to a compact change-signature. A working-tree edit
 *  moves `unstaged` / `untracked` (a stage/commit moves `staged` / `branch` /
 *  ahead-behind); any field change ⇒ a new signature ⇒ a refresh. */
function gitStatusSignature(status: GitStatus | null): string {
  if (status === null) return 'null';
  return [
    status.branch, status.detached ? 1 : 0, status.ahead, status.behind,
    status.staged, status.unstaged, status.untracked, status.conflicted,
  ].join('|');
}

/**
 * One working-tree poll pass: for each foreground project, read git status and
 * bump the version + fan out to subscribers when its signature changed since the
 * last observation. The first observation of a project only establishes the
 * baseline (the chip already shows current state from its own fetch / the
 * project-switch refetch), so we never fire spuriously on startup.
 */
export async function pollWorkingTreesOnce(): Promise<void> {
  for (const root of [...watchers.keys()]) {
    // Foreground-scoped (HS-8725 parity): a background project the user isn't
    // looking at refreshes lazily on switch, so N open projects don't fan out
    // O(N) `git status` runs every tick.
    if (!isProjectActive(join(root, '.hotsheet'))) continue;
    let status: GitStatus | null;
    try {
      status = await getCachedGitStatus(root);
    } catch {
      continue;
    }
    const sig = gitStatusSignature(status);
    const prev = lastSig.get(root);
    lastSig.set(root, sig);
    if (prev === undefined || prev === sig) continue; // baseline or unchanged
    const entry = watchers.get(root);
    if (entry === undefined) continue;
    entry.version++;
    for (const sub of subscribers) {
      try { sub(root); } catch { /* swallow */ }
    }
  }
}

/** Start the shared low-frequency working-tree poll loop (idempotent). The
 *  interval is unref'd so it never keeps the process alive on its own. */
function ensureWorkingTreePoller(): void {
  if (workingTreePoller !== null) return;
  workingTreePoller = setInterval(() => { void pollWorkingTreesOnce(); }, WORKING_TREE_POLL_MS);
  workingTreePoller.unref();
}

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
      inFlight.delete(projectRoot); // HS-8723 — a read in flight when git changed is pre-change; force a fresh run
      e2.version++;
      // HS-8725 (load resilience, docs/75 §75.6 Phase 3) — foreground-scoped
      // refresh. The cache bust + version bump above ALWAYS happen so a later
      // tab-switch to this project refetches fresh. But the PROACTIVE work —
      // waking the poll (so the client re-renders) and pre-warming git status —
      // only runs for the actively-viewed project. A background project the user
      // isn't looking at refreshes lazily on switch (the chip's on-demand
      // `getCachedGitStatus` fetch), so N open projects' `.git` nudges don't fan
      // out into O(N) proactive work on the shared loop. Safe default: when no
      // client has reported a foreground yet, `isProjectActive` returns true so
      // behavior matches the pre-Phase-3 baseline.
      if (!isProjectActive(join(projectRoot, '.hotsheet'))) return;
      for (const sub of subscribers) {
        try { sub(projectRoot); } catch { /* swallow */ }
      }
      // HS-8724 (load resilience, docs/75 §75.6 Phase 2) — submit the cache
      // pre-warm through the central scheduler so the refresh runs under the
      // shared concurrency/fairness budget at GIT_STATUS priority. Deferrable:
      // a stale chip for a beat under load is fine. The in-flight coalescing
      // (HS-8723) means a client poll that arrives mid-warm shares this same git
      // run rather than spawning its own.
      void getBackgroundScheduler().submit({
        key: `git-refresh:${projectRoot}`,
        priority: PRIORITY.GIT_STATUS,
        projectKey: projectRoot,
        deferUnderLag: true,
        // HS-9111 — refresh the working-tree-poll baseline from the same fresh
        // read, so the poll doesn't redundantly re-notify the stage/commit/branch
        // change this watcher already fanned out.
        run: () => getCachedGitStatus(projectRoot).then((s) => { lastSig.set(projectRoot, gitStatusSignature(s)); }),
      });
    }, WATCHER_DEBOUNCE_MS);
  };

  // HS-9109 — watch the `.git` directory and filter the reported filename to the
  // entries that move git state for the chip. `index` covers stage/commit (it's
  // rewritten on both); `HEAD` covers branch switch + commit. We deliberately do
  // NOT fire on `index.lock` (transient) or other `.git` churn. A null filename
  // (rare — some network filesystems don't report it) falls back to firing, since
  // we can't tell what changed; the 250 ms debounce + 500 ms cache bound the cost.
  const RELEVANT = new Set(['index', 'HEAD']);
  try {
    const handle = fsWatch(gitDir, (_event, filename) => {
      if (filename === null || RELEVANT.has(filename)) fireDebounced();
    });
    // An `fs.watch` handle is an EventEmitter — without an `error` listener an
    // emitted error THROWS (unhandled). The `.git` dir being removed (repo
    // deleted / worktree pruned) or an FD-limit (`EMFILE`) emits one; swallow it
    // (the HS-9111 poll still refreshes the chip on its cadence).
    handle.on('error', () => { /* degraded mode — poll-fallback covers it */ });
    handles.push(handle);
  } catch {
    // fs.watch isn't supported on every filesystem (e.g. some FUSE
    // mounts). Degraded mode — focus-refetch on the client still works.
  }
  watchers.set(projectRoot, { watchers: handles, version: 0, debounce: null });
  // HS-9111 — drive the low-frequency working-tree poll (even if fs.watch above
  // failed, the poll still catches working-tree + index changes on its cadence).
  ensureWorkingTreePoller();
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
  inFlight.delete(projectRoot);
  lastSig.delete(projectRoot); // HS-9111
}

/** Tear down EVERY watcher. Called from the graceful-shutdown pipeline. */
export function disposeAllGitWatchers(): void {
  for (const root of [...watchers.keys()]) disposeGitWatcher(root);
  subscribers.clear();
  // HS-9111 — stop the shared working-tree poll once nothing is watched.
  if (workingTreePoller !== null) { clearInterval(workingTreePoller); workingTreePoller = null; }
  lastSig.clear();
}
