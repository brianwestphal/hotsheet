/**
 * HS-9076 (docs/100 §100.2.1) — the SERVER-owned worker-pool reconciler: drives
 * the live worker count toward the pool's `targetN` with NO client open. The
 * server analog of the client `workerPoolPanel.tsx::reconcile`, so a target raised
 * headlessly (the `hotsheet_set_worker_target` MCP tool, which triggers
 * `POST /api/workers/pool/reconcile`) actually scales the pool instead of waiting
 * for a human to open the UI.
 *
 * Each pass:
 *   1. **Reap** finished/crashed slots (`stopped`, or stale-`dead` past §91.7's
 *      window) via `reapWorker` — the no-UI reap (close PTY + remove worktree +
 *      drop slot + release claims).
 *   2. **Scale up** — for each missing slot up to `min(targetN, poolMax())`:
 *      `prepareWorker` (worktree) → `spawnWorkerTerminal` (PTY, server-side) →
 *      `registerWorker` with the server-tracked `terminalId`.
 *   3. **Scale down** — drain the surplus (newest-first) via the existing graceful
 *      `requestDrain` flag (the worker stops at its next claim, finishing its
 *      current ticket); the next pass reaps the resulting `stopped` slot.
 *
 * `prepare` / `spawn` / `reap` are injectable so tests drive the orchestration
 * without real git / PTYs.
 */
import { getErrorMessage } from '../utils/errorMessage.js';
import { prepareWorker } from './launchWorker.js';
import { getPoolState, isSlotStale, registerWorker, requestDrain, setTarget, type WorkerSlot } from './poolManager.js';
import { reapWorker, spawnWorkerTerminal } from './serverWorkerLifecycle.js';
import { poolMax } from './suggestN.js';

export interface ReconcileResult {
  /** Workers spawned this pass (scale-up). */
  spawned: number;
  /** Workers asked to drain this pass (scale-down). */
  drained: number;
  /** Finished/crashed slots torn down this pass. */
  reaped: number;
  /** The pool's recorded target (pre-clamp). */
  targetN: number;
  /** Live (idle/working) workers after the pass. */
  live: number;
}

export interface ReconcileDeps {
  prepare?: typeof prepareWorker;
  spawn?: typeof spawnWorkerTerminal;
  reap?: typeof reapWorker;
}

/** A worker counts toward the live total unless it's draining, stopped, or
 *  stale-dead (mirrors the client `activeCount` view derivation). */
function isLive(w: WorkerSlot, now: number): boolean {
  return !w.drain && !w.stopped && !isSlotStale(w, now);
}

/** The next free `worker-N` label (server analog of the panel's `nextWorkerName`). */
function nextWorkerName(workers: readonly WorkerSlot[]): string {
  const used = new Set(workers.map(w => w.label));
  let n = 1;
  while (used.has(`worker-${String(n)}`)) n++;
  return `worker-${String(n)}`;
}

/**
 * Reconcile the project's worker pool toward its `targetN`, server-side. Returns a
 * summary of what changed. Never throws — a scale-up launch failure stops the
 * up-loop (so it doesn't hammer) and a reap/drain failure is swallowed.
 */
export async function reconcilePool(
  secret: string,
  dataDir: string,
  repoRoot: string,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  const prepare = deps.prepare ?? prepareWorker;
  const spawn = deps.spawn ?? spawnWorkerTerminal;
  const reap = deps.reap ?? reapWorker;

  let spawned = 0;
  let drained = 0;
  let reaped = 0;

  // Capture the owner's intended target UP FRONT: reaping a slot can lower
  // `pool.targetN` (`removeWorker`'s contract — it never lets the target exceed
  // the slot count), so we restore it after reaping. Without this, reaping a
  // crashed worker would silently shrink the pool instead of replacing it; with
  // it, the pool SELF-HEALS toward the target across crashes/drains.
  const rawTarget = Math.max(0, getPoolState(dataDir).targetN);
  const now = Date.now();

  // 1) Reap finished/crashed slots (no UI needed — HS-9077's `reapWorker`).
  for (const w of getPoolState(dataDir).workers) {
    if (!w.stopped && !isSlotStale(w, now)) continue;
    try { await reap(secret, dataDir, repoRoot, w); reaped++; }
    catch (e) { console.warn(`[workers] reconcile: reap failed for ${w.worker}: ${getErrorMessage(e)}`); }
  }
  if (reaped > 0) setTarget(dataDir, rawTarget); // restore the intended target

  // 2) Recompute live count + the poolMax-clamped spawn ceiling.
  const live = getPoolState(dataDir).workers.filter(w => isLive(w, now));
  const want = Math.min(rawTarget, poolMax());

  if (live.length < want) {
    // 3) Scale up.
    for (let i = live.length; i < want; i++) {
      try {
        const name = nextWorkerName(getPoolState(dataDir).workers);
        const branch = `hotsheet/${name}`;
        const spec = await prepare(repoRoot, dataDir, { branch, label: name });
        const terminalId = spawn(secret, dataDir, spec);
        registerWorker(dataDir, { worker: spec.worker, label: spec.label, worktreePath: spec.cwd, branch, terminalId });
        spawned++;
      } catch (e) {
        // A failed launch lowers our effective ceiling for this pass — stop rather
        // than retry the same failing launch in a tight loop.
        console.warn(`[workers] reconcile: scale-up failed: ${getErrorMessage(e)}`);
        break;
      }
    }
  } else if (live.length > want) {
    // 4) Scale down — drain the surplus gracefully (newest-first).
    const surplus = live.length - want;
    const victims = [...live].sort((a, b) => b.seq - a.seq).slice(0, surplus);
    for (const w of victims) { if (requestDrain(dataDir, w.worker)) drained++; }
  }

  const finalLive = getPoolState(dataDir).workers.filter(w => isLive(w, Date.now())).length;
  return { spawned, drained, reaped, targetN: rawTarget, live: finalLive };
}
