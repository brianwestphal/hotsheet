/**
 * HS-8863 — typed API for launching distributed workers (docs/90 §90.5 / §90.7).
 * A worker is a Claude terminal running the `hotsheet-worker` skill in an isolated
 * worktree, looping claim → work → complete + release. This endpoint PREPARES one
 * (ensuring the worktree slot) and returns the launch spec; the caller opens the
 * terminal via the Phase C terminal infrastructure. The durable pool that spins up
 * N workers + scale controls is HS-8962.
 *
 * Endpoint:
 *   - `POST /workers/launch` → `WorkerLaunchSpec` (body: `LaunchWorkerReq`)
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

export const LaunchWorkerReqSchema = z.object({
  /** Reuse this EXISTING worktree root instead of creating one. */
  worktreePath: z.string().optional(),
  /** Branch for a NEW worktree (created with `-b`). Required when `worktreePath` is omitted. */
  branch: z.string().optional(),
  /** Human-friendly worker label (defaults to the branch / worktree dir name). */
  label: z.string().optional(),
  /** Worker identity for `claimed_by` (defaults to a slug of the label). */
  worker: z.string().optional(),
});
export type LaunchWorkerReq = z.infer<typeof LaunchWorkerReqSchema>;

export const WorkerLaunchSpecSchema = z.object({
  worker: z.string(),
  label: z.string(),
  cwd: z.string(),
  command: z.string(),
  worktreeCreated: z.boolean(),
});
export type WorkerLaunchSpec = z.infer<typeof WorkerLaunchSpecSchema>;

/** POST `/workers/launch` → prepare a worker (ensure its worktree) + return the
 *  command/cwd to start it. */
export async function launchWorker(req: LaunchWorkerReq): Promise<WorkerLaunchSpec> {
  return apiCall(WorkerLaunchSpecSchema, '/workers/launch', { method: 'POST', body: req });
}

// --- HS-8962 — worker-pool manager (docs/91 §91.2-91.5) ---

/** Derived worker lifecycle state for the pool panel (docs/91 §91.2). `dead` is
 *  HS-8972 — silent past the liveness window (crashed/hung), pending reap. */
export const WorkerStateSchema = z.enum(['idle', 'working', 'draining', 'stopped', 'dead']);
export type WorkerState = z.infer<typeof WorkerStateSchema>;

/** A pool worker as the panel sees it — the registry slot + derived state + (when
 *  working) the ticket it currently holds. */
export const WorkerSlotViewSchema = z.object({
  label: z.string(),
  worker: z.string(),
  worktreePath: z.string(),
  branch: z.string().nullable(),
  terminalId: z.string().nullable(),
  state: WorkerStateSchema,
  currentTicket: z.object({ id: z.number(), ticketNumber: z.string(), title: z.string() }).nullable(),
});
export type WorkerSlotView = z.infer<typeof WorkerSlotViewSchema>;

export const PoolStateSchema = z.object({
  targetN: z.number(),
  workers: z.array(WorkerSlotViewSchema),
});
export type PoolState = z.infer<typeof PoolStateSchema>;

export const RegisterWorkerReqSchema = z.object({
  label: z.string().min(1),
  worker: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().nullish(),
  terminalId: z.string().nullish(),
});
export type RegisterWorkerReq = z.infer<typeof RegisterWorkerReqSchema>;

/** Identify one pool worker (by its `claimed_by` identity). */
export const WorkerRefSchema = z.object({ worker: z.string().min(1) });
export type WorkerRef = z.infer<typeof WorkerRefSchema>;

export const SetTargetReqSchema = z.object({ targetN: z.number().int().min(0).max(64) });
export type SetTargetReq = z.infer<typeof SetTargetReqSchema>;

const OkSchema = z.object({ ok: z.literal(true) });

/** GET `/workers/pool` → the pool's workers + derived state. */
export async function getWorkerPool(): Promise<PoolState> {
  return apiCall(PoolStateSchema, '/workers/pool');
}

/** POST `/workers/pool/register` → register a worker the panel just launched. */
export async function registerPoolWorker(req: RegisterWorkerReq): Promise<WorkerSlotView> {
  return apiCall(WorkerSlotViewSchema, '/workers/pool/register', { method: 'POST', body: req });
}

/** POST `/workers/pool/drain` → request graceful drain of one worker. */
export async function drainPoolWorker(req: WorkerRef): Promise<{ ok: true }> {
  return apiCall(OkSchema, '/workers/pool/drain', { method: 'POST', body: req });
}

/** POST `/workers/pool/drain-all` → request graceful drain of every worker. */
export async function drainAllPoolWorkers(): Promise<{ ok: true }> {
  return apiCall(OkSchema, '/workers/pool/drain-all', { method: 'POST', body: {} });
}

/** POST `/workers/pool/remove` → unregister a worker (after teardown). */
export async function removePoolWorker(req: WorkerRef): Promise<{ ok: true }> {
  return apiCall(OkSchema, '/workers/pool/remove', { method: 'POST', body: req });
}

/** POST `/workers/pool/target` → set the desired worker count (UI hint). */
export async function setPoolTarget(req: SetTargetReq): Promise<{ ok: true }> {
  return apiCall(OkSchema, '/workers/pool/target', { method: 'POST', body: req });
}

// --- HS-8963 — AI-suggested worker count (docs/91 §91.6) ---

export const SuggestionResultSchema = z.object({
  n: z.number(),
  rationale: z.string(),
  source: z.enum(['ai', 'heuristic']),
});
export type SuggestionResult = z.infer<typeof SuggestionResultSchema>;

/** GET `/workers/suggest-n` → a recommended worker count + rationale for the
 *  current Up Next set (owner still sets the actual N). */
export async function getSuggestedWorkerCount(): Promise<SuggestionResult> {
  return apiCall(SuggestionResultSchema, '/workers/suggest-n');
}

// --- HS-8965 — AI partition-into-N-chunks dispatch helper (docs/92 §92.6) ---

export const PartitionReqSchema = z.object({
  workers: z.array(z.object({ worker: z.string().min(1), label: z.string() })).min(1),
});
export type PartitionReq = z.infer<typeof PartitionReqSchema>;

export const PartitionAssignmentSchema = z.object({
  worker: z.string(),
  label: z.string(),
  ticketIds: z.array(z.number()),
  ticketNumbers: z.array(z.string()),
});
export type PartitionAssignment = z.infer<typeof PartitionAssignmentSchema>;

const PartitionRespSchema = z.object({ assignments: z.array(PartitionAssignmentSchema) });

/** POST `/workers/partition` → an AI-proposed assignment of the current unblocked
 *  Up Next tickets across the given workers (one chunk per worker). */
export async function getTicketPartition(req: PartitionReq): Promise<PartitionAssignment[]> {
  const r = await apiCall(PartitionRespSchema, '/workers/partition', { method: 'POST', body: req });
  return r.assignments;
}
