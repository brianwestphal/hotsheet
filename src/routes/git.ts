import { Hono } from 'hono';

import { readFileSettings } from '../file-settings.js';
import { runGitFetch } from '../git/status.js';
import { dropGitStatusCache, ensureGitWatcher, getCachedGitStatus } from '../git/watcher.js';
import type { AppEnv } from '../types.js';

/**
 * HS-7954 — Phase 1 git status route. `GET /api/git/status` returns
 * `GitStatus | null` for the active project. Null when (a) the project
 * isn't a git repo, OR (b) `git_tracking_enabled` is `false` in the
 * project's settings, OR (c) `git` isn't on PATH (in which case
 * `getGitStatus` returns null defensively).
 *
 * Setup-side effect: every successful read also calls `ensureGitWatcher`
 * so the on-`.git/index`-change push refresh is wired up. Idempotent.
 *
 * See docs/48-git-status-tracker.md.
 */
export const gitRoutes = new Hono<AppEnv>();

gitRoutes.get('/git/status', (c) => {
  const dataDir = c.get('dataDir');
  const projectRoot = projectRootFromDataDir(dataDir);

  // HS-7954 — `git_tracking_enabled` opt-out lives in per-project settings
  // (default true). When the user explicitly disables, return null so the
  // chip stays hidden.
  const settings = readFileSettings(dataDir);
  if (settings.git_tracking_enabled === false) {
    return c.json(null);
  }

  // Idempotently set up the file-watcher on first read; the watcher's
  // change events drop the cache + bump the change version so subsequent
  // poll wakes pick up the new state.
  ensureGitWatcher(projectRoot);

  const status = getCachedGitStatus(projectRoot);
  return c.json(status);
});

/** Pure: convert a `<project>/.hotsheet` dataDir to its project root. The
 *  Hot Sheet `dataDir` is always the `.hotsheet` subdir of a project root,
 *  so peeling the trailing `.hotsheet` segment off gets us back to the
 *  project the user actually committed git from. */
export function projectRootFromDataDir(dataDir: string): string {
  return dataDir.replace(/[\\/]\.hotsheet\/?$/, '');
}

// HS-7955 — manual fetch endpoint. Runs `git fetch --quiet
// --no-write-fetch-head` against the upstream of the current branch (no-op
// when no upstream — returns ok:false with a friendly hint). Drops the
// status cache on success so the next /git/status call sees the new
// ahead/behind numbers. Always returns 200 — the `ok` field carries the
// success signal so the client doesn't have to special-case HTTP status.
gitRoutes.post('/git/fetch', (c) => {
  const dataDir = c.get('dataDir');
  const projectRoot = projectRootFromDataDir(dataDir);
  const settings = readFileSettings(dataDir);
  if (settings.git_tracking_enabled === false) {
    return c.json({ ok: false, lastFetchedAt: null, error: 'git tracking disabled in settings' });
  }
  const result = runGitFetch(projectRoot);
  if (result.ok) dropGitStatusCache(projectRoot);
  return c.json(result);
});
