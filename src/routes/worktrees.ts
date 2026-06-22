/**
 * HS-8935 — git worktree management routes (docs/89-git-worktrees.md Phase B).
 * Operates on the ACTIVE project: the repo root is derived from the project's
 * data dir, and created worktrees are made followers of that project's
 * `.hotsheet` (HS-8934). Wire shapes live in `src/api/worktrees.ts`.
 */
import { Hono } from 'hono';

import {
  CreateWorktreeReqSchema, RemoveWorktreeReqSchema,
} from '../api/worktrees.js';
import { isGitRepo } from '../gitignore.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { createWorktree, listWorktrees, removeWorktree } from '../worktrees.js';
import { projectRootFromDataDir } from './git.js';
import { parseBody } from './validation.js';

export const worktreeRoutes = new Hono<AppEnv>();

/** GET /api/worktrees — list the active project's git worktrees. */
worktreeRoutes.get('/worktrees', async (c) => {
  const repoRoot = projectRootFromDataDir(c.get('dataDir'));
  if (!isGitRepo(repoRoot)) return c.json({ error: 'Not a git repository' }, 400);
  try {
    return c.json(await listWorktrees(repoRoot));
  } catch (e) {
    return c.json({ error: getErrorMessage(e) }, 500);
  }
});

/** POST /api/worktrees — create a worktree as a follower of this project. */
worktreeRoutes.post('/worktrees', async (c) => {
  const dataDir = c.get('dataDir');
  const repoRoot = projectRootFromDataDir(dataDir);
  if (!isGitRepo(repoRoot)) return c.json({ error: 'Not a git repository' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(CreateWorktreeReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  try {
    const info = await createWorktree(repoRoot, dataDir, parsed.data);
    return c.json(info);
  } catch (e) {
    return c.json({ error: getErrorMessage(e) }, 500);
  }
});

/** POST /api/worktrees/remove — remove a worktree (optionally force / delete branch). */
worktreeRoutes.post('/worktrees/remove', async (c) => {
  const repoRoot = projectRootFromDataDir(c.get('dataDir'));
  if (!isGitRepo(repoRoot)) return c.json({ error: 'Not a git repository' }, 400);
  const raw: unknown = await c.req.json();
  const parsed = parseBody(RemoveWorktreeReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  try {
    await removeWorktree(repoRoot, parsed.data.path, {
      force: parsed.data.force,
      deleteBranch: parsed.data.deleteBranch,
    });
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: getErrorMessage(e) }, 500);
  }
});
