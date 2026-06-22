/**
 * HS-8935 — typed API for git worktree management (docs/89-git-worktrees.md
 * Phase B). Single source of truth for the wire shapes, shared by the server
 * route handlers (`src/routes/worktrees.ts`) and the client callers.
 *
 * Endpoints:
 *   - `GET  /worktrees`        → `WorktreeInfo[]`
 *   - `POST /worktrees`        → `WorktreeInfo`  (body: `CreateWorktreeReq`)
 *   - `POST /worktrees/remove` → `{ ok: true }`  (body: `RemoveWorktreeReq`)
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

export const WorktreeInfoSchema = z.object({
  /** Absolute worktree root. */
  path: z.string(),
  /** Branch name (no `refs/heads/`), or null when detached. */
  branch: z.string().nullable(),
  /** Current commit sha (may be empty for a brand-new entry). */
  head: z.string(),
  /** The repo's primary worktree. */
  isMain: z.boolean(),
  /** The owner `.hotsheet` this worktree follows, or null when it's not a follower. */
  authoritativeDataDir: z.string().nullable(),
});
export type WorktreeInfo = z.infer<typeof WorktreeInfoSchema>;

export const CreateWorktreeReqSchema = z.object({
  /** Branch to check out (existing) or create (with `newBranch`). */
  branch: z.string().min(1),
  /** Worktree location; server defaults to a sibling `../<repo>-worktrees/<branch>`. */
  path: z.string().optional(),
  /** Create a new branch instead of checking out an existing one. */
  newBranch: z.boolean().optional(),
  /** Base ref for a new branch (default HEAD). */
  baseRef: z.string().optional(),
});
export type CreateWorktreeReq = z.infer<typeof CreateWorktreeReqSchema>;

export const RemoveWorktreeReqSchema = z.object({
  /** Worktree root to remove. */
  path: z.string().min(1),
  /** Pass `git worktree remove --force` (e.g. the worktree has local `.hotsheet/`). */
  force: z.boolean().optional(),
  /** Also delete the worktree's branch (`git branch -D`). */
  deleteBranch: z.boolean().optional(),
});
export type RemoveWorktreeReq = z.infer<typeof RemoveWorktreeReqSchema>;

const OkSchema = z.object({ ok: z.literal(true) });

/** GET `/worktrees` → the project's worktrees (main first). */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  return apiCall(z.array(WorktreeInfoSchema), '/worktrees');
}

/** POST `/worktrees` → create a worktree (follower of this project) + return it. */
export async function createWorktree(req: CreateWorktreeReq): Promise<WorktreeInfo> {
  return apiCall(WorktreeInfoSchema, '/worktrees', { method: 'POST', body: req });
}

/** POST `/worktrees/remove` → remove a worktree. */
export async function removeWorktree(req: RemoveWorktreeReq): Promise<{ ok: true }> {
  return apiCall(OkSchema, '/worktrees/remove', { method: 'POST', body: req });
}
