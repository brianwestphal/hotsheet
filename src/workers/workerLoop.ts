// HS-8863 — distributed worker loop (docs/90 §90.5 self-claim + §90.7 worker pool).
//
// The canonical claim → work → complete + release → repeat cycle a single worker
// runs to drain the Up Next pool. In INTERACTIVE production the worker is a Claude
// terminal driven by the generated `hotsheet-worker` skill (it performs the same
// sequence through the `hotsheet_*` MCP tools — see `src/skills.ts`); this module
// is the programmatic reference for the loop's invariants (lease heartbeat,
// graceful stop that never abandons a ticket mid-work, completed-before-release
// ordering) and is the seam the multi-worker tests + a future headless/pool
// driver (HS-8962) build on. It composes the HS-8862 claim primitive (`claimNext`
// / `renewLease` / `release`) with `updateTicket` — never double-claiming because
// `claimNext` is atomic (`SELECT … FOR UPDATE SKIP LOCKED`), and crash-safe
// because a dead worker's lease simply expires and another worker reclaims it.
import { claimNext, DEFAULT_CLAIM_TTL_SECONDS, release, renewLease } from '../db/claims.js';
import { updateTicket } from '../db/tickets.js';
import type { Ticket } from '../schemas.js';
import type { TicketStatus } from '../types.js';

/** What a worker's `doWork` returns after working one ticket. */
export interface WorkOutcome {
  /** Final status to set (default `completed`). */
  status?: TicketStatus;
  /** Completion notes — required (the worklist requires notes on completion). */
  notes: string;
}

/** Performs the actual work for one claimed ticket. In interactive production this
 *  is the Claude session (the skill); in tests it's a stub. Throwing PARKS the
 *  ticket (records an error note + leaves the lease so it isn't hot-re-claimed);
 *  the lease expiry yields a natural retry backoff. */
export type DoWork = (ticket: Ticket) => Promise<WorkOutcome>;

export type WorkerEvent =
  | { type: 'claimed'; ticket: Ticket }
  | { type: 'idle'; round: number }
  | { type: 'completed'; ticketId: number }
  | { type: 'released'; ticketId: number }
  | { type: 'lease-lost'; ticketId: number }
  | { type: 'work-error'; ticketId: number; error: string }
  | { type: 'stopped'; reason: StopReason };

export type StopReason = 'drained' | 'stopped' | 'max-tickets';

export interface WorkerLoopOptions {
  /** Stable worker identity (a clientId / worker_label slug); attributes the claim. */
  worker: string;
  /** Human-friendly label for the UI (e.g. `worktree-2`). */
  label?: string | null;
  /** Lease TTL in seconds (default 1800 = 30 min, docs/90 §90.2.2; HS-9050). The
   *  loop heartbeats every TTL/3 so it never lapses regardless. */
  ttlSeconds?: number;
  /** Heartbeat cadence in ms while a ticket is held (default ttl/3). 0 disables. */
  heartbeatMs?: number;
  /** Wait between empty `claim-next` rounds (default 2000ms). */
  idleBackoffMs?: number;
  /** Stop after this many CONSECUTIVE empty rounds (default Infinity = wait forever
   *  for new work; tests pass 1 to drain-and-exit). */
  maxIdleRounds?: number;
  /** Safety bound on tickets worked before stopping (default Infinity). */
  maxTickets?: number;
  /** Performs the work for one ticket. */
  doWork: DoWork;
  /** Injectable sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Observability hook — fires for each loop transition. */
  onEvent?: (e: WorkerEvent) => void;
}

export interface WorkerLoopSummary {
  /** Tickets completed by this worker. */
  completed: number;
  /** Ticket ids this worker completed, in order. */
  completedIds: number[];
  /** Why the loop exited. */
  reason: StopReason;
}

export interface WorkerLoopHandle {
  /** Request a GRACEFUL stop: the loop finishes the ticket it is currently working
   *  (never abandons it mid-work — docs/90 §90.7 "never kill mid-ticket"), then
   *  exits before claiming the next. */
  stop(): void;
  /** Resolves with the run summary when the loop exits. */
  readonly done: Promise<WorkerLoopSummary>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Start a worker loop. Returns a handle exposing graceful `stop()` and a `done`
 * promise. The loop:
 *   1. `claim-next` the top claimable Up Next ticket (atomic, no double-claim).
 *   2. While working, heartbeat `renew-lease` so the claim doesn't expire.
 *   3. On success, set the ticket `completed` (+ notes) then `release` it.
 *   4. Repeat — backing off when the pool is empty.
 * If the lease is lost mid-work (another worker reclaimed an expired lease), the
 * worker does NOT complete/release the ticket — it leaves it for whoever owns it
 * now, the crash-recovery guarantee from the other direction.
 */
export function startWorker(options: WorkerLoopOptions): WorkerLoopHandle {
  const {
    worker,
    label = null,
    ttlSeconds = DEFAULT_CLAIM_TTL_SECONDS,
    idleBackoffMs = 2000,
    maxIdleRounds = Infinity,
    maxTickets = Infinity,
    doWork,
    sleep = defaultSleep,
    onEvent,
  } = options;
  // Heartbeat well inside the TTL so a slow renew still beats expiry.
  const heartbeatMs = options.heartbeatMs ?? Math.max(1000, Math.floor((ttlSeconds * 1000) / 3));

  // On an object so the `stop()` closure's mutation isn't flow-narrowed away.
  const ctl = { stopRequested: false };
  const emit = (e: WorkerEvent): void => { if (onEvent) onEvent(e); };

  const done = (async (): Promise<WorkerLoopSummary> => {
    const completedIds: number[] = [];
    let idleRounds = 0;
    let reason: StopReason = 'stopped';

    for (;;) {
      // Graceful stop is checked only BETWEEN tickets — never mid-work.
      if (ctl.stopRequested) { reason = 'stopped'; break; }
      if (completedIds.length >= maxTickets) { reason = 'max-tickets'; break; }

      const ticket = await claimNext(worker, label, ttlSeconds);
      if (ticket === null) {
        idleRounds += 1;
        emit({ type: 'idle', round: idleRounds });
        if (idleRounds >= maxIdleRounds) { reason = 'drained'; break; }
        await sleep(idleBackoffMs);
        continue;
      }
      idleRounds = 0;
      emit({ type: 'claimed', ticket });

      // Heartbeat: keep the lease fresh while doWork runs. A failed renew means the
      // claim lapsed and was (or can be) reclaimed — stop renewing and skip the
      // completion so we don't clobber another worker's ownership. The flags live
      // on an object because they're mutated from the interval closure (a plain
      // `let` would be flow-narrowed to its initializer everywhere else).
      const hb = { leaseLost: false, renewing: false };
      const timer = heartbeatMs > 0 ? setInterval(() => {
        if (hb.renewing || hb.leaseLost) return;
        hb.renewing = true;
        void renewLease(ticket.id, worker, ttlSeconds).then(r => {
          if (!r.ok) { hb.leaseLost = true; emit({ type: 'lease-lost', ticketId: ticket.id }); }
        }).finally(() => { hb.renewing = false; });
      }, heartbeatMs) : null;
      const stopHeartbeat = (): void => { if (timer !== null) clearInterval(timer); };

      try {
        const outcome = await doWork(ticket);
        stopHeartbeat();
        if (hb.leaseLost) continue; // someone else owns it now — don't complete/release.
        await updateTicket(ticket.id, { status: outcome.status ?? 'completed', notes: outcome.notes });
        emit({ type: 'completed', ticketId: ticket.id });
        await release(ticket.id, worker);
        emit({ type: 'released', ticketId: ticket.id });
        completedIds.push(ticket.id);
      } catch (e) {
        stopHeartbeat();
        const msg = e instanceof Error ? e.message : String(e);
        emit({ type: 'work-error', ticketId: ticket.id, error: msg });
        // PARK the ticket (if we still hold it): record the error as a note and
        // leave the lease in place rather than releasing it back to the claimable
        // pool. Releasing here would let THIS worker immediately re-claim and
        // re-fail the same ticket in a hot loop; parking lets the lease expire
        // first, giving a natural backoff before any retry (by this or another
        // worker) — the same recovery path as a crash. A poison ticket that always
        // fails surfaces via the repeated error notes + climbing `claim_count`.
        if (!hb.leaseLost) await updateTicket(ticket.id, { notes: `Worker \`${label ?? worker}\` hit an error: ${msg}` });
      }
    }

    const summary: WorkerLoopSummary = { completed: completedIds.length, completedIds, reason };
    emit({ type: 'stopped', reason });
    return summary;
  })();

  return { stop: () => { ctl.stopRequested = true; }, done };
}
