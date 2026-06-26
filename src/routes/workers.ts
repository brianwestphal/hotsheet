/**
 * HS-8863 — distributed worker launch routes (docs/90 §90.5 / §90.7). Operates on
 * the ACTIVE project: the repo root + owner `.hotsheet` come from the project's
 * data dir, and a launched worker runs in a follower worktree of that project.
 * Wire shapes live in `src/api/workers.ts`. The durable pool/scale layer is
 * HS-8962.
 */
import { Hono } from 'hono';

import {
  IntegrateReqSchema,
  LaunchWorkerReqSchema, PartitionReqSchema, RegisterWorkerReqSchema,
  SetQueueOnlyReqSchema, SetTargetReqSchema,
  WorkerReadyReqSchema, WorkerRefSchema,
  type WorkerSlotView, } from '../api/workers.js';
import { getClaims } from '../db/claims.js';
import { readFileSettings } from '../file-settings.js';
import { isGitRepo } from '../gitignore.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { detectTargetBranch, integrateBranch, listReadyBranches } from '../workers/integrate.js';
import { prepareWorker } from '../workers/launchWorker.js';
import { partitionTickets } from '../workers/partition.js';
import {
  clearReadyByBranch, getPoolState, isSlotStale, readyCount, registerWorker,
  removeWorker, requestDrain, requestDrainAll, setQueueOnly, setReady, setTarget,
  type WorkerSlot,
} from '../workers/poolManager.js';
import { suggestWorkerCount } from '../workers/suggestN.js';
import { projectRootFromDataDir } from './git.js';
import { parseBody } from './validation.js';

export const workerRoutes = new Hono<AppEnv>();

/** Combine a registry slot with the live claims into the panel's view: a worker
 *  that holds a live claim is `working` (with that ticket); a drained/stopped slot
 *  shows its lifecycle state; a silent slot is `dead` (HS-8972); otherwise `idle`. */
function toView(slot: WorkerSlot, claimByWorker: Map<string, { id: number; ticketNumber: string; title: string }>): WorkerSlotView {
  const claim = claimByWorker.get(slot.worker);
  const state = slot.stopped ? 'stopped'
    : slot.drain ? 'draining'
    : isSlotStale(slot) ? 'dead'
    : claim !== undefined ? 'working'
    : 'idle';
  return {
    label: slot.label, worker: slot.worker, worktreePath: slot.worktreePath,
    branch: slot.branch, terminalId: slot.terminalId, state,
    currentTicket: claim ?? null,
    queueOnly: slot.queueOnly,
    ready: slot.ready, readyBranch: slot.readyBranch,
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
  return c.json({ targetN, workers: workers.map(w => toView(w, claimByWorker)), readyCount: readyCount(dataDir) });
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

/** POST /api/workers/pool/queue-only — HS-8975: toggle a worker's queue-only mode. */
workerRoutes.post('/workers/pool/queue-only', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(SetQueueOnlyReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  if (!setQueueOnly(c.get('dataDir'), parsed.data.worker, parsed.data.queueOnly)) return c.json({ error: 'No such worker' }, 404);
  return c.json({ ok: true });
});

/** POST /api/workers/ready — HS-9090 (docs/106 §106.1): a worker signals its
 *  branch is committed + rebased + ready to integrate (once per batch boundary).
 *  Rides on the pool slot so the panel surfaces "N branches ready" and the owner's
 *  integrate loop keys on the signal instead of scanning on a timer. */
workerRoutes.post('/workers/ready', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(WorkerReadyReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  if (!setReady(c.get('dataDir'), parsed.data.worker, parsed.data.branch)) return c.json({ error: 'No such worker' }, 404);
  return c.json({ ok: true });
});

/** GET /api/workers/suggest-n — HS-8963: a recommended worker count + rationale
 *  for the current Up Next set (AI when a key is configured, else a heuristic). */
workerRoutes.get('/workers/suggest-n', async (c) => {
  return c.json(await suggestWorkerCount());
});

/** POST /api/workers/partition — HS-8965: AI-propose an assignment of the current
 *  unblocked Up Next tickets across the given workers (one chunk per worker). */
workerRoutes.post('/workers/partition', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(PartitionReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  return c.json({ assignments: await partitionTickets(parsed.data.workers) });
});

// HS-9048 — owner-side branch integration (docs/89 §89.7). The owner is the single
// integrator for worker branches; these expose the deterministic git core.

/** GET /api/workers/integratable — the detected target branch + the ready worker
 *  branches (`hotsheet/*` ahead of the target). */
workerRoutes.get('/workers/integratable', async (c) => {
  const repoRoot = projectRootFromDataDir(c.get('dataDir'));
  if (!isGitRepo(repoRoot)) return c.json({ error: 'Not a git repository' }, 400);
  try {
    const target = await detectTargetBranch(repoRoot);
    const branches = await listReadyBranches(repoRoot, target);
    return c.json({ target, branches });
  } catch (e) {
    return c.json({ error: getErrorMessage(e) }, 500);
  }
});

/** POST /api/workers/integrate — merge one ready worker branch into the target
 *  (clean-tree guarded, conflict → abort + report, never pushes). Always 200 with
 *  the structured `IntegrateResult`; the caller branches on `status`. */
workerRoutes.post('/workers/integrate', async (c) => {
  const dataDir = c.get('dataDir');
  const repoRoot = projectRootFromDataDir(dataDir);
  if (!isGitRepo(repoRoot)) return c.json({ error: 'Not a git repository' }, 400);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(IntegrateReqSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  const target = await detectTargetBranch(repoRoot);
  // HS-9091 — opt-in in-helper gate: when the project configured an
  // `integrationGate` command (shared setting), run it after the merge and roll
  // back on failure. Absent/blank → the agent-runs-gates default (no gate).
  const gateCommand = readFileSettings(dataDir).integrationGate?.trim();
  const gate = gateCommand !== undefined && gateCommand !== '' ? { command: gateCommand } : undefined;
  const result = await integrateBranch(repoRoot, parsed.data.branch, target, undefined, { gate });
  // HS-9090 — once the branch is merged, clear any worker's "ready" signal for it
  // so the panel's "N ready" count and the owner's loop reflect the drained queue.
  if (result.status === 'merged') clearReadyByBranch(dataDir, parsed.data.branch);
  return c.json(result);
});
