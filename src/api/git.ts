/**
 * HS-8522 — typed API for the git-status endpoints (§48). Single source of
 * truth for the wire shapes that were previously declared THREE times each:
 * `GitStatus` / `GitStatusFiles` / `FetchResult` lived as hand-kept
 * duplicates in `src/git/status.ts` (server), `gitStatusChip.tsx`, and
 * `gitStatusPopover.tsx` (client). They now live here once; the server
 * infers its types from these schemas and the client callers + popover
 * import them.
 *
 * Endpoints (see `src/routes/git.ts`):
 *   - `GET  /git/status[?files=true]` → `GitStatusWithFiles | null`
 *   - `POST /git/fetch`               → `FetchResult`
 *   - `POST /git/reveal`              → `{ ok: true }`  (body: `{ path }`)
 */
import { z } from 'zod';

import { apiCall, qs } from './_runner.js';

/** Branch / dirty / ahead-behind summary for the sidebar git chip. */
export const GitStatusSchema = z.object({
  /** Current branch name, or detached HEAD's short SHA. */
  branch: z.string(),
  /** True when HEAD is detached. */
  detached: z.boolean(),
  /** "origin/main" if tracking, null otherwise. */
  upstream: z.string().nullable(),
  /** Commits in HEAD not in upstream. */
  ahead: z.number(),
  /** Commits in upstream not in HEAD. */
  behind: z.number(),
  /** Staged file count (pre-commit). */
  staged: z.number(),
  /** Unstaged file count (modified files in working tree). */
  unstaged: z.number(),
  /** Untracked file count. */
  untracked: z.number(),
  /** Unresolved-merge file count. */
  conflicted: z.number(),
  /** Last successful Hot-Sheet-initiated `git fetch` timestamp (ms epoch). */
  lastFetchedAt: z.number().nullable(),
});
export type GitStatus = z.infer<typeof GitStatusSchema>;

/** Per-bucket file lists for the Phase 3 expanded popover (capped at 200
 *  per bucket; `truncated.<bucket>` flags a clipped list). */
export const GitStatusFilesSchema = z.object({
  staged: z.array(z.string()),
  unstaged: z.array(z.string()),
  untracked: z.array(z.string()),
  conflicted: z.array(z.string()),
  truncated: z.object({
    staged: z.boolean(),
    unstaged: z.boolean(),
    untracked: z.boolean(),
    conflicted: z.boolean(),
  }),
});
export type GitStatusFiles = z.infer<typeof GitStatusFilesSchema>;

/** `GET /git/status` body. `files` present only when `?files=true`. */
export const GitStatusWithFilesSchema = GitStatusSchema.extend({
  files: GitStatusFilesSchema.optional(),
});
export type GitStatusWithFiles = z.infer<typeof GitStatusWithFilesSchema>;

const GitStatusResponseSchema = GitStatusWithFilesSchema.nullable();

/** Result of `POST /git/fetch`. Always 200 — `ok` carries the signal. */
export const FetchResultSchema = z.object({
  ok: z.boolean(),
  lastFetchedAt: z.number().nullable(),
  /** stderr line(s) when `ok` is false; empty on success. */
  error: z.string(),
});
export type FetchResult = z.infer<typeof FetchResultSchema>;

/** `POST /git/reveal` request body. Path is optional so the server's
 *  "Invalid path" branch still fires when it's missing. `.loose()` tolerates
 *  unexpected extra keys at the wire boundary. */
export const GitRevealReqSchema = z.object({
  path: z.string().optional(),
}).loose();
export type GitRevealReq = z.infer<typeof GitRevealReqSchema>;

const GitRevealRespSchema = z.object({ ok: z.literal(true) });

/** Branch + dirty counts for the active project, or null (not a git repo /
 *  tracking disabled). */
export async function getGitStatus(): Promise<GitStatusWithFiles | null> {
  return apiCall(GitStatusResponseSchema, '/git/status');
}

/** As `getGitStatus`, additionally pulling per-bucket file lists for the
 *  expanded popover. */
export async function getGitStatusWithFiles(): Promise<GitStatusWithFiles | null> {
  return apiCall(GitStatusResponseSchema, `/git/status${qs({ files: true })}`);
}

/** Run `git fetch` against the current branch's upstream. */
export async function gitFetch(): Promise<FetchResult> {
  return apiCall(FetchResultSchema, '/git/fetch', { method: 'POST' });
}

/** Reveal a git-status file (relative path) in the OS file manager. */
export async function gitReveal(req: GitRevealReq): Promise<{ ok: true }> {
  return apiCall(GitRevealRespSchema, '/git/reveal', { method: 'POST', body: req });
}
