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
