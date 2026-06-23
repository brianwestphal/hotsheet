/**
 * HS-8863 — distributed worker launch routes (docs/90 §90.5 / §90.7). Operates on
 * the ACTIVE project: the repo root + owner `.hotsheet` come from the project's
 * data dir, and a launched worker runs in a follower worktree of that project.
 * Wire shapes live in `src/api/workers.ts`. The durable pool/scale layer is
 * HS-8962.
 */
import { Hono } from 'hono';

import { LaunchWorkerReqSchema } from '../api/workers.js';
import { isGitRepo } from '../gitignore.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { prepareWorker } from '../workers/launchWorker.js';
import { projectRootFromDataDir } from './git.js';
import { parseBody } from './validation.js';

export const workerRoutes = new Hono<AppEnv>();

/** POST /api/workers/launch — prepare a worker in an isolated worktree of this
 *  project and return the launch spec (cwd + command). */
workerRoutes.post('/workers/launch', async (c) => {
  const dataDir = c.get('dataDir');
  const repoRoot = projectRootFromDataDir(dataDir);
  if (!isGitRepo(repoRoot)) return c.json({ error: 'Not a git repository' }, 400);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(LaunchWorkerReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  try {
    const spec = await prepareWorker(repoRoot, dataDir, parsed.data);
    return c.json(spec);
  } catch (e) {
    return c.json({ error: getErrorMessage(e) }, 400);
  }
});
