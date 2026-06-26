/**
 * HS-9077 (docs/100 §100.2.2) — SERVER-owned terminal lifecycle for pool workers.
 *
 * Today a worker's terminal is launched + closed from the browser
 * (`openTerminalRunningCommand` / `closeDynamicTerminal`), so a target raised with
 * no UI open records the intent but nothing actually starts or gets torn down.
 * This gives the server the two primitives the §100 reconcile loop (HS-9076) needs
 * to scale the pool headlessly:
 *
 *   - `spawnWorkerTerminal` — spawn a worker's `claude "/hotsheet-worker"` PTY
 *     server-side (no open client), returning a server-tracked `terminalId` for
 *     the pool slot. Mirrors the client `openTerminalRunningCommand`.
 *   - `reapWorker` — the server analog of the client `cleanupStopped` reap
 *     (HS-9051): force-release the worker's still-leased tickets, close its PTY,
 *     remove its worktree, and drop the pool slot — all with no UI, so the §91.7
 *     liveness reap works headlessly.
 *
 * The terminal subsystem already buffers an unattached PTY's output in the session
 * RingBuffer (§54), so a headless worker terminal is safe; these reuse the
 * extracted `createDynamicTerminal` / `destroyDynamicTerminal` server services.
 */
import { getClaims, release } from '../db/claims.js';
import { createDynamicTerminal, destroyDynamicTerminal } from '../routes/terminal.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { defaultGit, type GitRunner, removeWorktree } from '../worktrees.js';
import type { WorkerLaunchSpec } from './launchWorker.js';
import { removeWorker, type WorkerSlot } from './poolManager.js';

/**
 * Spawn a worker's terminal SERVER-SIDE from a prepared `WorkerLaunchSpec`. Like
 * the client `openTerminalRunningCommand`, it opens the default shell in the
 * worktree cwd and injects `spec.command` (`claude "/hotsheet-worker"`) once the
 * shell settles. Returns the server-tracked `terminalId` to store on the pool slot
 * (so `reapWorker` can later close it). Best-effort spawn (the create helper logs
 * but never throws on an eager-spawn hiccup).
 */
export function spawnWorkerTerminal(secret: string, dataDir: string, spec: WorkerLaunchSpec): string {
  return createDynamicTerminal(secret, dataDir, {
    spawn: true,
    runCommand: spec.command,
    name: spec.label,
    cwd: spec.cwd,
  }).id;
}

/** The pool-slot fields `reapWorker` needs (a full `WorkerSlot` works too). */
export type ReapableSlot = Pick<WorkerSlot, 'worker' | 'worktreePath' | 'terminalId'>;

/**
 * Tear down a pool worker with NO client open — the server analog of the client
 * `cleanupStopped` reap (HS-9051). Each step is best-effort so one failure doesn't
 * block the rest:
 *   1. force-release the worker's still-leased tickets so they're reclaimable now
 *      (don't wait out the lease TTL),
 *   2. close its PTY (`destroyDynamicTerminal`),
 *   3. remove its worktree (`force`), and
 *   4. drop the pool slot.
 * Git is injectable for tests.
 */
export async function reapWorker(
  secret: string,
  dataDir: string,
  repoRoot: string,
  slot: ReapableSlot,
  git: GitRunner = defaultGit,
): Promise<void> {
  // 1) Force-release the worker's live claims (HS-9051) so they're reclaimable now.
  try {
    for (const claim of await getClaims()) {
      if (claim.claimedBy !== slot.worker) continue;
      try { await release(claim.ticketId); } catch { /* best-effort per-claim */ }
    }
  } catch { /* claims read failed — continue the teardown */ }

  // 2) Close the worker's PTY (server-side; no client).
  if (slot.terminalId !== null && slot.terminalId !== '') {
    try { destroyDynamicTerminal(secret, slot.terminalId); } catch { /* best-effort */ }
  }

  // 3) Remove its worktree.
  try {
    await removeWorktree(repoRoot, slot.worktreePath, { force: true }, git);
  } catch (e) {
    console.warn(`[workers] reap: removeWorktree failed for ${slot.worktreePath}: ${getErrorMessage(e)}`);
  }

  // 4) Drop the pool slot.
  removeWorker(dataDir, slot.worker);
}
