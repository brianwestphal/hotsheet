/**
 * A claiming agent's stable LEASE identity (e.g. `worker-1`) — used for
 * `claimed_by` and its `hotsheet_claim_next` / `_renew_lease` / `_release` /
 * `_update_ticket` calls, and by `deriveChannelActor` so its auto-claim-on-write
 * matches its explicit claims.
 *
 * `resolveWorkerActor` derives it: an explicitly-set `HOTSHEET_WORKER_ID` →
 * the `hotsheet/<id>` branch → the cwd basename. (Originally HS-9676: the retired
 * worker pool INJECTED the id; the pool is gone as of HS-9686, so an agent in a
 * follower worktree either sets the env var or is identified by its branch.)
 *
 * Leaf module with NO imports so it can't introduce a cycle and — because it is
 * reachable from the CLIENT bundle — can't drag a node builtin (`path`) into the
 * browser build. Hence the hand-rolled `lastPathSegment` rather than `path.basename`.
 */

/** Last path segment of a filesystem path, cross-platform, dependency-free (see
 *  the module note — importing `node:path` breaks the client bundle). */
function lastPathSegment(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

/** The env var an agent may set to declare its canonical lease identity. Read by
 *  `deriveChannelActor` so a follower's auto-claim-on-write matches its explicit
 *  claim/renew/release calls. (The worker pool that used to INJECT this was
 *  retired in HS-9686; an agent now sets it itself, or falls back to its branch.) */
export const WORKER_ID_ENV = 'HOTSHEET_WORKER_ID';

/** Fallback when `HOTSHEET_WORKER_ID` is absent: strip the
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
  return lastPathSegment(cwd);
}
