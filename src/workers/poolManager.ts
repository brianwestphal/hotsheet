// HS-8962 — worker-pool manager (docs/91 §91.2-91.4, §90.7). The in-memory,
// session-only runtime that tracks the durable worker slots draining the Up Next
// pool and coordinates graceful scale-down.
//
// A "worker slot" is a git worktree + an AI terminal running the HS-8863 claim
// loop (the `hotsheet-worker` skill). This module owns only the *coordination*
// state — which slots exist, their worktree/terminal, and the **drain flag**.
// Terminal + worktree lifecycle is driven by the client panel (terminals render
// client-side); slot state for the UI (idle/working) is derived from the live
// claims at read time, not stored here.
//
// Graceful drain (the key invariant — never kill a worker mid-ticket, §91.4): the
// panel marks a worker `draining`; the worker only learns it when it next calls
// `claim-next` (so it always finishes its current ticket first). `onClaimNext`
// returns `{drain:true}` for a draining worker and flips it to `stopped` — the
// panel then closes its terminal + removes its worktree. Pure in-memory + keyed
// by project data dir; session-only (no persistence) per §91.9.

/** A registered pool worker slot. `drain`/`stopped` are the lifecycle flags this
 *  module owns; `idle`/`working` are derived elsewhere from live claims. */
export interface WorkerSlot {
  /** Human-friendly label shown in the UI (`worker_label`, e.g. `worker-1`). */
  label: string;
  /** Worker identity used for `claimed_by` and as the registry key. */
  worker: string;
  /** Worktree root the worker runs in. */
  worktreePath: string;
  /** Worktree branch (null when unknown). */
  branch: string | null;
  /** The drawer terminal id running the loop (for the panel to close on cleanup). */
  terminalId: string | null;
  /** Drain requested — the worker stops claiming at its next `claim-next`. */
  drain: boolean;
  /** The worker acknowledged the drain (saw `drain:true`) and is exiting. */
  stopped: boolean;
  /** Registration order, for stable tile ordering. */
  seq: number;
  /** HS-8972 — last time this worker showed liveness (ms epoch): registration,
   *  any `claim-next`, lease renewal, or claim-by-id. A worker silent past
   *  `STALE_AFTER_MS` is treated as dead (crashed/hung) and reaped by the panel. */
  lastSeenAt: number;
}

/** HS-8972 — a pool worker silent (no claim-next / renew / claim) for this long is
 *  considered dead. Comfortably above the 120 s lease TTL + the worker's renew
 *  cadence, so a worker heads-down on a long ticket (still renewing) stays live;
 *  one that's truly silent has already lost its lease anyway. */
export const STALE_AFTER_MS = 5 * 60_000;

interface Pool {
  /** Desired worker count (a UI hint the panel reconciles toward; §91.9 session-only). */
  targetN: number;
  /** Slots keyed by worker identity. */
  workers: Map<string, WorkerSlot>;
  /** Monotonic registration counter. */
  nextSeq: number;
}

const pools = new Map<string, Pool>();

function poolFor(dataDir: string): Pool {
  let p = pools.get(dataDir);
  if (p === undefined) {
    p = { targetN: 0, workers: new Map(), nextSeq: 1 };
    pools.set(dataDir, p);
  }
  return p;
}

export interface RegisterWorkerInput {
  label: string;
  worker: string;
  worktreePath: string;
  branch?: string | null;
  terminalId?: string | null;
}

/** Register a worker the panel just launched (worktree created + terminal opened).
 *  Idempotent on `worker`: re-registering updates the slot's terminal/worktree and
 *  clears any stale drain/stopped flags (a fresh worker on the same identity). */
export function registerWorker(dataDir: string, input: RegisterWorkerInput): WorkerSlot {
  const pool = poolFor(dataDir);
  const existing = pool.workers.get(input.worker);
  const slot: WorkerSlot = {
    label: input.label,
    worker: input.worker,
    worktreePath: input.worktreePath,
    branch: input.branch ?? null,
    terminalId: input.terminalId ?? null,
    drain: false,
    stopped: false,
    seq: existing?.seq ?? pool.nextSeq++,
    lastSeenAt: Date.now(),
  };
  pool.workers.set(input.worker, slot);
  if (pool.workers.size > pool.targetN) pool.targetN = pool.workers.size;
  return slot;
}

/** Request graceful drain for one worker. Returns false if no such worker. */
export function requestDrain(dataDir: string, worker: string): boolean {
  const slot = poolFor(dataDir).workers.get(worker);
  if (slot === undefined) return false;
  slot.drain = true;
  return true;
}

/** Cancel a pending drain (worker returns to active) — only if it hasn't already
 *  acknowledged the drain + stopped. Returns false if no such drainable worker. */
export function cancelDrain(dataDir: string, worker: string): boolean {
  const slot = poolFor(dataDir).workers.get(worker);
  if (slot === undefined || slot.stopped) return false;
  slot.drain = false;
  return true;
}

/** Drain every active worker in the pool. Returns the count newly marked. */
export function requestDrainAll(dataDir: string): number {
  let n = 0;
  for (const slot of poolFor(dataDir).workers.values()) {
    if (!slot.drain && !slot.stopped) { slot.drain = true; n++; }
  }
  poolFor(dataDir).targetN = 0;
  return n;
}

/** Claim-next gate: if `worker` is a draining pool worker, flip it to `stopped`
 *  (it just acknowledged the drain by pulling) and tell it to stop. A worker not
 *  in the pool, or not draining, gets `{drain:false}` → claim proceeds normally.
 *  This is the single hook the claim-next route calls. */
export function onClaimNext(dataDir: string, worker: string): { drain: boolean } {
  const slot = pools.get(dataDir)?.workers.get(worker);
  if (slot === undefined) return { drain: false };
  slot.lastSeenAt = Date.now(); // a claim-next is a sign of life (HS-8972)
  if (slot.drain) {
    slot.stopped = true;
    return { drain: true };
  }
  return { drain: false };
}

/** HS-8972 — record liveness for a pool worker (called from the renew-lease /
 *  claim routes, in addition to `onClaimNext`). No-op for a non-pool worker.
 *  Returns whether a slot was found. */
export function touch(dataDir: string, worker: string, now: number = Date.now()): boolean {
  const slot = pools.get(dataDir)?.workers.get(worker);
  if (slot === undefined) return false;
  slot.lastSeenAt = now;
  return true;
}

/** HS-8972 — is this slot dead? Silent past `STALE_AFTER_MS` and not already on
 *  its way out (draining/stopped have their own cleanup path). */
export function isSlotStale(slot: WorkerSlot, now: number = Date.now()): boolean {
  return !slot.drain && !slot.stopped && now - slot.lastSeenAt > STALE_AFTER_MS;
}

/** Remove a worker slot from the registry (after its terminal + worktree are
 *  torn down). Returns false if no such worker. */
export function removeWorker(dataDir: string, worker: string): boolean {
  const pool = poolFor(dataDir);
  const had = pool.workers.delete(worker);
  if (had && pool.targetN > pool.workers.size) pool.targetN = pool.workers.size;
  return had;
}

/** Set the desired worker count (a UI hint; the panel reconciles toward it). */
export function setTarget(dataDir: string, n: number): void {
  poolFor(dataDir).targetN = Math.max(0, Math.floor(n));
}

/** Snapshot of the pool's coordination state (slots in registration order). The
 *  derived idle/working state + current ticket are layered on by the caller from
 *  the live claims. */
export function getPoolState(dataDir: string): { targetN: number; workers: WorkerSlot[] } {
  const pool = poolFor(dataDir);
  const workers = [...pool.workers.values()].sort((a, b) => a.seq - b.seq);
  return { targetN: pool.targetN, workers };
}

/** **TEST ONLY** — clear every pool so consecutive tests start clean. */
export function _resetPoolsForTesting(): void {
  pools.clear();
}
