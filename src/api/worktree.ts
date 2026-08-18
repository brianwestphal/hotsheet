/**
 * HS-9697 (docs/89 §89.7) — typed API for adopting a git worktree as a follower from
 * the UI (the git-chip popover), wrapping the same `makeFollower` primitive the
 * `hotsheet --follow` CLI uses (HS-9688). Single source of truth for the two wire
 * shapes, shared by the server route (`src/routes/worktree.ts`) and the client caller.
 *
 * Endpoints:
 *   - `GET  /worktree/adoptable` → `{ worktrees: [{path}] }` — this repo's worktrees
 *     that can be adopted (excludes the owner project's own root + ones already
 *     following this owner).
 *   - `POST /worktree/adopt` (body `{ worktree }`) → `{ ok, error? }` — wire the given
 *     worktree as a follower of THIS project.
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

/** A worktree the current project can adopt as a follower. */
export const AdoptableWorktreeSchema = z.object({
  /** Absolute worktree root path. */
  path: z.string(),
});
export type AdoptableWorktree = z.infer<typeof AdoptableWorktreeSchema>;

export const AdoptableWorktreesResSchema = z.object({
  worktrees: z.array(AdoptableWorktreeSchema),
});
export type AdoptableWorktreesRes = z.infer<typeof AdoptableWorktreesResSchema>;

/** `POST /worktree/adopt` request body. `.loose()` tolerates extra keys at the wire
 *  boundary; `worktree` optional so the server's "invalid worktree" branch still fires
 *  when it's missing. */
export const AdoptWorktreeReqSchema = z.object({
  worktree: z.string().optional(),
}).loose();
export type AdoptWorktreeReq = z.infer<typeof AdoptWorktreeReqSchema>;

/** Always 200 — `ok` carries the signal; `error` is set (human-readable) on failure. */
export const AdoptWorktreeRespSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
export type AdoptWorktreeResp = z.infer<typeof AdoptWorktreeRespSchema>;

/** The current repo's worktrees that can be adopted as followers of this project. */
export async function getAdoptableWorktrees(): Promise<AdoptableWorktreesRes> {
  return apiCall(AdoptableWorktreesResSchema, '/worktree/adoptable');
}

/** Adopt `req.worktree` as a follower of the CURRENT project (wire its pointer +
 *  channel/skills/allow-rules against this owner). */
export async function adoptWorktree(req: AdoptWorktreeReq): Promise<AdoptWorktreeResp> {
  return apiCall(AdoptWorktreeRespSchema, '/worktree/adopt', { method: 'POST', body: req });
}
