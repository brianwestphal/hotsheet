/**
 * HS-8863 — distributed worker launch routes (docs/90 §90.5 / §90.7). Operates on
 * the ACTIVE project: the repo root + owner `.hotsheet` come from the project's
 * data dir, and a launched worker runs in a follower worktree of that project.
 * Wire shapes live in `src/api/workers.ts`. The durable pool/scale layer is
 * HS-8962.
 */
import { Hono } from 'hono';

import {
  LaunchWorkerReqSchema, RegisterWorkerReqSchema, SetTargetReqSchema,
WorkerRefSchema,
  type WorkerSlotView, } from '../api/workers.js';
import { getClaims } from '../db/claims.js';
import { isGitRepo } from '../gitignore.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { prepareWorker } from '../workers/launchWorker.js';
import {
  getPoolState, registerWorker, removeWorker, requestDrain,
  requestDrainAll, setTarget, type WorkerSlot,
} from '../workers/poolManager.js';
import { projectRootFromDataDir } from './git.js';
import { parseBody } from './validation.js';

export const workerRoutes = new Hono<AppEnv>();

/** Combine a registry slot with the live claims into the panel's view: a worker
 *  that holds a live claim is `working` (with that ticket); a drained/stopped slot
 *  shows its lifecycle state; otherwise `idle`. */
function toView(slot: WorkerSlot, claimByWorker: Map<string, { id: number; ticketNumber: string; title: string }>): WorkerSlotView {
  const claim = claimByWorker.get(slot.worker);
  const state = slot.stopped ? 'stopped'
    : slot.drain ? 'draining'
    : claim !== undefined ? 'working'
    : 'idle';
  return {
    label: slot.label, worker: slot.worker, worktreePath: slot.worktreePath,
    branch: slot.branch, terminalId: slot.terminalId, state,
    currentTicket: claim ?? null,
  };
}

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

// --- HS-8962 — worker-pool manager (docs/91 §91.2-91.5) ---

/** GET /api/workers/pool — the pool's workers + derived state (idle/working from
 *  the live claims, draining/stopped from the registry). */
workerRoutes.get('/workers/pool', async (c) => {
  const dataDir = c.get('dataDir');
  const claims = await getClaims();
  const claimByWorker = new Map(claims.map(cl => [cl.claimedBy, { id: cl.ticketId, ticketNumber: cl.ticketNumber, title: cl.title }]));
  const { targetN, workers } = getPoolState(dataDir);
  return c.json({ targetN, workers: workers.map(w => toView(w, claimByWorker)) });
});

/** POST /api/workers/pool/register — record a worker the panel just launched. */
workerRoutes.post('/workers/pool/register', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(RegisterWorkerReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const slot = registerWorker(c.get('dataDir'), parsed.data);
  return c.json(toView(slot, new Map()));
});

/** POST /api/workers/pool/drain — request graceful drain of one worker. */
workerRoutes.post('/workers/pool/drain', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(WorkerRefSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  if (!requestDrain(c.get('dataDir'), parsed.data.worker)) return c.json({ error: 'No such worker' }, 404);
  return c.json({ ok: true });
});

/** POST /api/workers/pool/drain-all — drain every active worker. */
workerRoutes.post('/workers/pool/drain-all', (c) => {
  requestDrainAll(c.get('dataDir'));
  return c.json({ ok: true });
});

/** POST /api/workers/pool/remove — unregister a worker after teardown. */
workerRoutes.post('/workers/pool/remove', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(WorkerRefSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  removeWorker(c.get('dataDir'), parsed.data.worker);
  return c.json({ ok: true });
});

/** POST /api/workers/pool/target — set the desired worker count (UI hint). */
workerRoutes.post('/workers/pool/target', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(SetTargetReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  setTarget(c.get('dataDir'), parsed.data.targetN);
  return c.json({ ok: true });
});
