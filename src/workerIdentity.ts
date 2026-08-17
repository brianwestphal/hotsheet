/**
 * HS-9676 — the canonical worker LEASE identity vs. the generated worktree/tab
 * INSTANCE name.
 *
 * A pooled worker has two names:
 *   - a stable lease id, e.g. `worker-1`, used for `claimed_by` and every
 *     `hotsheet_claim_next` / `_renew_lease` / `_release` / `_update_ticket` call;
 *   - a generated worktree folder / tab title, e.g. `hotsheet-worker-1-12`, whose
 *     numeric suffix increments each time the slot is reused.
 *
 * The launcher knows the canonical id, so it INJECTS it (this module) instead of
 * letting the agent guess it from its cwd — the old `hotsheet-worker` skill told
 * agents to use the worktree folder name, so a reused worker (`hotsheet-worker-1-12`)
 * claimed/renewed under the wrong id and never recognized the tickets the pool
 * dispatched to `worker-1`.
 *
 * Leaf module (only a node builtin) so both the AI-tool plugins and the worker
 * launcher / channel tools can depend on it without a cycle.
 */
import { basename } from 'path';

/** The env var carrying the canonical worker lease identity into the launch. */
export const WORKER_ID_ENV = 'HOTSHEET_WORKER_ID';

/** Worker ids are slugs (`slugify` → lowercase, `[a-z0-9]` joined by `-`), so
 *  they're always shell-safe. Guard defensively anyway: only emit an env
 *  assignment for a slug-shaped id, else nothing (older callers pass no id). */
function isSlugId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id);
}

/** `HOTSHEET_WORKER_ID=<id> ` prefix for the launch command (trailing space), or
 *  `''` when no valid id is known. Shell-safe by the slug guard — no quoting. */
export function workerIdEnvPrefix(workerId?: string): string {
  if (workerId === undefined || workerId === '' || !isSlugId(workerId)) return '';
  return `${WORKER_ID_ENV}=${workerId} `;
}

/** The verbatim identity statement appended to the worker's launch PROMPT, so the
 *  agent uses this exact id for its lease calls instead of the worktree folder name
 *  or the tab title. Empty when no id is known. No backticks/quotes — this text
 *  goes inside a double-quoted shell arg. */
export function workerIdPromptLine(workerId?: string): string {
  if (workerId === undefined || workerId === '') return '';
  return ` Your canonical worker id is ${workerId} — use exactly that as your worker + label for every hotsheet_claim_next / hotsheet_renew_lease / hotsheet_release / hotsheet_update_ticket call. Do NOT derive your id from the worktree folder name or the tab title.`;
}

/** Fallback used by the skill when `HOTSHEET_WORKER_ID` is absent: strip the
 *  `hotsheet/` prefix off a worker branch (`hotsheet/worker-1` → `worker-1`).
 *  Returns null for anything not in that shape. */
export function workerIdFromBranch(branch: string | null | undefined): string | null {
  if (branch === null || branch === undefined) return null;
  const m = /^hotsheet\/(.+)$/.exec(branch);
  return m !== null && m[1] !== '' ? m[1] : null;
}

/**
 * The worker's claim/lease ACTOR for a follower worktree, resolved with the SAME
 * chain the `/hotsheet-worker` skill uses — so a worker's auto-claim-on-write
 * (this actor, injected by the channel server) matches its explicit
 * claim/renew/release (the id the skill sends), and it never self-conflicts.
 *
 * Chain: injected `HOTSHEET_WORKER_ID` → the `hotsheet/<id>` branch → (legacy /
 * manual launch) the worktree folder basename. `getBranch` is lazy so the git
 * read only happens when the env is absent — the normal launcher path (env set)
 * never shells out. Pure + injectable for tests.
 */
export function resolveWorkerActor(cwd: string, injectedId: string | undefined, getBranch: () => string | null): string {
  if (injectedId !== undefined && injectedId !== '') return injectedId;
  const fromBranch = workerIdFromBranch(getBranch());
  if (fromBranch !== null) return fromBranch;
  return basename(cwd);
}
