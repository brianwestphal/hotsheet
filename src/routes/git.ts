import { Hono } from 'hono';

import { readFileSettings } from '../file-settings.js';
import { join } from 'path';

import { getGitRoot } from '../gitignore.js';
import { getGitStatusFiles, runGitFetch } from '../git/status.js';
import { dropGitStatusCache, ensureGitWatcher, getCachedGitStatus } from '../git/watcher.js';
import { openInFileManager } from '../open-in-file-manager.js';
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
  if (status === null) return c.json(null);

  // HS-7956 — Phase 3 popover requests `?files=true` to additionally pull
  // per-bucket file lists (capped at 200 per bucket; truncation flagged
  // for "…and N more" UI). Skipping the cache here because the file lists
  // aren't part of the cached `GitStatus` and are only requested when the
  // popover is open (rare event vs. every poll bump). Adds one extra `git
  // status -z` shell-out per click.
  if (c.req.query('files') === 'true') {
    const files = getGitStatusFiles(projectRoot);
    return c.json({ ...status, files });
  }
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

// HS-7956 — reveal a file from the git-status file list in the OS file
// manager. Joined against the project's git root so the client can pass
// the relative path it received from `getGitStatusFiles`. Defensively
// skips paths that escape the git root (`..` traversal) — opening
// arbitrary system paths would be a privilege boundary leak.
gitRoutes.post('/git/reveal', async (c) => {
  const dataDir = c.get('dataDir');
  const projectRoot = projectRootFromDataDir(dataDir);
  const gitRoot = getGitRoot(projectRoot) ?? projectRoot;
  const body = await c.req.json().catch(() => null) as { path?: unknown } | null;
  const rel = body !== null && typeof body.path === 'string' ? body.path : '';
  if (rel === '' || rel.includes('..') || rel.startsWith('/')) {
    return c.json({ ok: false, error: 'Invalid path' }, 400);
  }
  const abs = join(gitRoot, rel);
  await openInFileManager(abs);
  return c.json({ ok: true });
});
