/**
 * HS-9697 (docs/89 §89.7) — adopt a git worktree as a follower of the CURRENT project
 * from the UI. The server owns the git enumeration + validation; the actual wiring is
 * `makeFollower` (the same primitive `hotsheet --follow` uses, HS-9688).
 *
 * `GET /worktree/adoptable` lists this repo's worktrees minus the owner's own root and
 * minus ones already following this owner. `POST /worktree/adopt` validates the target
 * is a real worktree of this repo (no arbitrary path) then wires it. Both resolve the
 * repo from the active project's dataDir.
 */
import { Hono } from 'hono';
import { join, resolve } from 'path';

import { AdoptWorktreeReqSchema } from '../api/worktree.js';
import { readFileSettings } from '../file-settings.js';
import { listWorktreePaths } from '../git/runner.js';
import { makeFollower } from '../makeFollower.js';
import type { AppEnv } from '../types.js';
import { projectRootFromDataDir } from './git.js';

export const worktreeRoutes = new Hono<AppEnv>();

/** Worktrees of the active project's repo that can be adopted as followers: every
 *  worktree except the owner's own root and ones already pointing at this owner. */
worktreeRoutes.get('/worktree/adoptable', async (c) => {
  const dataDir = c.get('dataDir');
  const ownerRoot = resolve(projectRootFromDataDir(dataDir));
  const ownerDataDir = resolve(dataDir);

  let paths: { path: string }[];
  try {
    paths = await listWorktreePaths(ownerRoot);
  } catch {
    return c.json({ worktrees: [] }); // not a git repo / git unavailable
  }

  const worktrees = paths
    .filter((p) => resolve(p.path) !== ownerRoot) // exclude the owner's own checkout
    .filter((p) => {
      // Exclude ones already following THIS owner (nothing to adopt).
      let pointer: string | undefined;
      try { pointer = readFileSettings(join(p.path, '.hotsheet')).authoritativeDataDir; }
      catch { pointer = undefined; }
      return pointer === undefined || resolve(pointer) !== ownerDataDir;
    })
    .map((p) => ({ path: resolve(p.path) }));

  return c.json({ worktrees });
});

/** Adopt one worktree as a follower of the current project. Validates the target is a
 *  real worktree of this repo (not an arbitrary path) and not the owner itself. */
worktreeRoutes.post('/worktree/adopt', async (c) => {
  const dataDir = c.get('dataDir');
  const ownerRoot = resolve(projectRootFromDataDir(dataDir));

  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = AdoptWorktreeReqSchema.safeParse(rawBody);
  const target = parsed.success && parsed.data.worktree !== undefined ? resolve(parsed.data.worktree) : '';
  if (target === '') return c.json({ ok: false, error: 'Missing worktree path' }, 400);
  if (target === ownerRoot) return c.json({ ok: false, error: 'That is the owner project itself, not a worktree to adopt.' }, 400);

  // No arbitrary cwd — the target must be a real worktree of THIS repo.
  let paths: { path: string }[];
  try {
    paths = await listWorktreePaths(ownerRoot);
  } catch {
    return c.json({ ok: false, error: 'Not a git repository (or git unavailable).' }, 400);
  }
  if (!paths.some((p) => resolve(p.path) === target)) {
    return c.json({ ok: false, error: 'Not a worktree of this repository.' }, 400);
  }

  try {
    makeFollower(target, dataDir);
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
  }
  return c.json({ ok: true });
});
