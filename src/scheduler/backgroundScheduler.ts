/**
 * HS-8724 (load resilience, docs/75 §75.6 Phase 2) — the central background-work
 * scheduler. ALL non-request background work (git refresh, markdown sync,
 * snapshot, backup, GC) is meant to be submitted here rather than each
 * subsystem firing its own uncoordinated timers onto the single shared event
 * loop. It generalizes the HS-8229 `withGlobalBackupLock` mutex (which only
 * serialized backups) into a real load-aware queue.
 *
 * Five properties, all from §75.3 P2:
 *
 *  1. **Bounded concurrency** — at most `concurrency` jobs run at once (default
 *     2). The rest queue. No unbounded pile-up under load.
 *  2. **Coalescing** — jobs carry a `key`; submitting a key that is already
 *     pending REPLACES the pending job (latest wins) instead of enqueuing a
 *     duplicate. A `.git` change that wakes N tabs, or a burst of ticket edits,
 *     collapses to one pending job per (project, kind). A submit for a key that
 *     is currently RUNNING is held as pending and re-runs once the in-flight
 *     run finishes — so a change that lands mid-run isn't lost.
 *  3. **Fairness** — within a priority tier, the next job is chosen round-robin
 *     across distinct `projectKey`s (oldest-served-first), so one churning
 *     project can't starve the others' work.
 *  4. **Priority** — lower `priority` number runs first (see `PRIORITY`).
 *  5. **Backpressure** — jobs flagged `deferUnderLag` are held back while the
 *     event-loop lag (read from the injected `lagProvider`, wired in production
 *     to `freezeLogger.getRecentEventLoopLagMs`) exceeds `lagThresholdMs`. They
 *     are DEFERRED, never dropped: a re-drain timer retries them once the loop
 *     calms. Durability-critical jobs leave `deferUnderLag` false so they always
 *     run regardless of load.
 *
 * This module is pure infrastructure — it owns no domain knowledge and imports
 * no subsystem. Production wires the default instance to the freeze-logger lag
 * signal via `getBackgroundScheduler()`; the migration of each consumer onto it
 * is tracked separately so the durability-critical paths (backup/snapshot) move
 * deliberately.
 */

import { getRecentEventLoopLagMs } from '../diagnostics/freezeLogger.js';

/** Priority tiers — lower runs first. Mirrors §75.3 P2's ordering
 *  (request handling is never queued here; it's the loop's foreground). */
export const PRIORITY = {
  /** Startup restoration of the previous session's projects (load-resilience
   *  epic HS-8722, docs/75 — the startup restore path). Highest
   *  priority because each restored project is a user-visible tab — they should
   *  fill in ahead of routine git/markdown/backup churn — but still bounded by
   *  the scheduler's concurrency cap + lag backpressure so the serial fan-out
   *  of N projects can't saturate the event loop on launch (the HS-8721 freeze,
   *  on the one path never migrated onto the scheduler). */
  PROJECT_RESTORE: 5,
  GIT_STATUS: 10,
  MARKDOWN_SYNC: 20,
  SNAPSHOT: 30,
  BACKUP: 40,
  GC: 50,
} as const;

export interface BackgroundJob {
  /** Coalescing + identity key. A submit for a key already pending replaces it;
   *  a submit for a key currently running is held until that run completes.
   *  Use a stable per-(project, kind) string, e.g. `snapshot:/abs/dataDir`. */
  key: string;
  /** Lower number = higher priority. Use a `PRIORITY` constant. */
  priority: number;
  /** Fairness bucket. Round-robin is applied across distinct `projectKey`s
   *  within a priority tier. Defaults to `key` when omitted. */
  projectKey?: string;
  /** The work. Async + self-contained; a rejection is caught and routed to
   *  `onError` (never crashes the scheduler or blocks the queue). */
  run: () => Promise<void>;
  /** When true, the job is held back while event-loop lag exceeds the
   *  threshold — it waits for a calmer tick. Leave false (default) for
   *  durability-critical work that must always run. */
  deferUnderLag?: boolean;
  /** Optional mutual-exclusion group. At most ONE job per `exclusiveGroup`
   *  runs at a time, independent of the global concurrency cap — so a class of
   *  work that must not overlap itself (e.g. backups: HS-8229 disk + Google
   *  Drive rate-limit contention) stays serialized even though the scheduler
   *  otherwise allows `concurrency` heavy jobs of different kinds at once. */
  exclusiveGroup?: string;
}

export interface BackgroundSchedulerOptions {
  /** Max concurrent running jobs. Default 2. */
  concurrency?: number;
  /** Returns the current event-loop lag in ms. Default: the freeze-logger
   *  heartbeat reading. Injectable for tests. */
  lagProvider?: () => number;
  /** Lag (ms) above which `deferUnderLag` jobs are held back. Default 200. */
  lagThresholdMs?: number;
  /** Delay (ms) before retrying a drain that was blocked only by lag
   *  deferral. Default 250. */
  reDrainDelayMs?: number;
  /** Called when a job's `run()` rejects. Default: console.warn. */
  onError?: (key: string, err: unknown) => void;
  /** HS-8726 — monotonic-ish clock for the post-wake stagger window. Default
   *  `Date.now`. Injectable so tests can control the window deterministically. */
  now?: () => number;
  /** HS-8726 — duration of the post-wake drain-stagger window after `noteWake()`.
   *  Default 15 000 ms. During the window the scheduler starts one job at a time
   *  spaced by `wakeStaggerStepMs`, so N projects' overdue periodic timers firing
   *  together on resume don't all start at once. */
  wakeStaggerWindowMs?: number;
  /** HS-8726 — minimum gap between job STARTS during the post-wake window.
   *  Default 250 ms. */
  wakeStaggerStepMs?: number;
}

export interface BackgroundScheduler {
  /** Enqueue (or coalesce) a job and kick the drain loop. Returns a Promise
   *  that resolves when the job that actually runs for this key completes —
   *  awaitable by callers that need to know the work finished (e.g. the manual
   *  backup endpoint, the shutdown snapshot flush). Fire-and-forget callers
   *  simply ignore the return. NEVER rejects: a `run()` rejection is routed to
   *  `onError` and the awaiter still resolves, so a `void submit(...)` can't
   *  produce an unhandled rejection. */
  submit: (job: BackgroundJob) => Promise<void>;
  /** Number of jobs currently executing. */
  runningCount: () => number;
  /** Number of jobs waiting (not yet started, incl. lag-deferred). */
  pendingCount: () => number;
  /** Resolves when the queue is fully drained (nothing running, nothing
   *  pending). Useful for shutdown flush + tests. */
  onIdle: () => Promise<void>;
  /** HS-8726 — signal that the machine just resumed from suspend. Opens the
   *  post-wake stagger window so the backlog of overdue periodic jobs drains
   *  one-at-a-time, spaced, instead of bursting. Wired from the freeze-logger
   *  wake detector (`onServerWake`). */
  noteWake: () => void;
  /** Drop all pending jobs + cancel the re-drain timer. In-flight runs are
   *  left to finish. For shutdown / tests. */
  clear: () => void;
}

/**
 * Create an isolated scheduler. Production uses the shared singleton from
 * `getBackgroundScheduler()`; tests create their own so state can't bleed.
 */
export function createBackgroundScheduler(opts: BackgroundSchedulerOptions = {}): BackgroundScheduler {
  const concurrency = opts.concurrency ?? 2;
  const lagProvider = opts.lagProvider ?? getRecentEventLoopLagMs;
  const lagThresholdMs = opts.lagThresholdMs ?? 200;
  const reDrainDelayMs = opts.reDrainDelayMs ?? 250;
  const now = opts.now ?? (() => Date.now());
  const wakeStaggerWindowMs = opts.wakeStaggerWindowMs ?? 15_000;
  const wakeStaggerStepMs = opts.wakeStaggerStepMs ?? 250;
  const onError = opts.onError ?? ((key, err) => {
    console.warn('[hotsheet backgroundScheduler] job failed:', key, err instanceof Error ? err.message : String(err));
  });

  // Pending jobs keyed by job.key (the Map gives us O(1) coalescing AND stable
  // insertion order for the FIFO tie-break).
  const pending = new Map<string, BackgroundJob>();
  // Keys currently executing.
  const running = new Set<string>();
  // Exclusive groups with a job currently executing (at most one per group).
  const runningGroups = new Set<string>();
  // Awaiters registered by `submit` but whose key hasn't started running yet
  // (keyed by job.key — coalesced submits accumulate here).
  const awaiters = new Map<string, Array<() => void>>();
  // Awaiters captured at the moment a key STARTED running — settled when that
  // run finishes. Separated from `awaiters` so a re-submit during a run waits
  // for the NEXT run, not the current one.
  const runningAwaiters = new Map<string, Array<() => void>>();
  // Fairness: monotonic counter + last-served sequence per projectKey. The
  // project with the smallest last-served seq (or none yet) is preferred.
  let seq = 0;
  const lastServedSeq = new Map<string, number>();
  let reDrainTimer: ReturnType<typeof setTimeout> | null = null;
  const idleWaiters: Array<() => void> = [];
  // HS-8726 — post-wake stagger window. `staggerUntil` is the timestamp the
  // window closes; while `now() < staggerUntil` the drain starts ≤1 job at a
  // time spaced by `wakeStaggerStepMs`. `lastStartAt` is the last job-start
  // timestamp (persists across the wake so the FIRST post-wake job starts
  // promptly, then subsequent ones are spaced).
  let staggerUntil = 0;
  let lastStartAt = Number.NEGATIVE_INFINITY; // -∞ ⇒ "never started" (sinceLast = ∞ ⇒ first post-wake job starts promptly)
  let staggerTimer: ReturnType<typeof setTimeout> | null = null;

  function projectKeyOf(job: BackgroundJob): string {
    return job.projectKey ?? job.key;
  }

  function settleIdleIfDone(): void {
    if (running.size === 0 && pending.size === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters.splice(0, idleWaiters.length);
      for (const w of waiters) w();
    }
  }

  /** Pick the next runnable job, honoring priority → fairness → FIFO, and
   *  skipping (a) keys already running and (b) lag-deferred jobs while lag is
   *  high. Returns null when nothing is runnable right now. Also reports
   *  whether any candidate was held back PURELY by lag, so the caller knows to
   *  arm the re-drain timer. */
  function pickNext(highLag: boolean): { job: BackgroundJob | null; lagDeferred: boolean } {
    let best: BackgroundJob | null = null;
    let lagDeferred = false;
    for (const job of pending.values()) {
      if (running.has(job.key)) continue; // coalesced re-submit of an in-flight key — wait for it
      if (job.exclusiveGroup !== undefined && runningGroups.has(job.exclusiveGroup)) continue; // group busy
      if (highLag && job.deferUnderLag === true) { lagDeferred = true; continue; }
      if (best === null) { best = job; continue; }
      // Higher priority (lower number) wins outright.
      if (job.priority !== best.priority) {
        if (job.priority < best.priority) best = job;
        continue;
      }
      // Same tier — fairness: prefer the project served least recently.
      const a = lastServedSeq.get(projectKeyOf(job)) ?? -1;
      const b = lastServedSeq.get(projectKeyOf(best)) ?? -1;
      if (a < b) best = job;
      // Equal fairness falls through to insertion order (best stays = earlier).
    }
    return { job: best, lagDeferred };
  }

  function drain(): void {
    const highLag = lagProvider() > lagThresholdMs;
    const t = now();
    // HS-8726 — during the post-wake window, cap effective concurrency at 1 and
    // space starts by `wakeStaggerStepMs` so the burst of overdue periodic jobs
    // drains gently instead of all firing at resume.
    const inStagger = t < staggerUntil;
    const cap = inStagger ? 1 : concurrency;
    let armReDrain = false;
    while (running.size < cap) {
      if (inStagger) {
        const sinceLast = t - lastStartAt;
        if (sinceLast < wakeStaggerStepMs) {
          scheduleStaggerDrain(wakeStaggerStepMs - sinceLast);
          break;
        }
      }
      const { job, lagDeferred } = pickNext(highLag);
      if (job === null) { armReDrain = lagDeferred; break; }
      pending.delete(job.key);
      running.add(job.key);
      if (job.exclusiveGroup !== undefined) runningGroups.add(job.exclusiveGroup);
      // Capture this key's accumulated awaiters for THIS run; later re-submits
      // register fresh awaiters that wait for the next run.
      runningAwaiters.set(job.key, awaiters.get(job.key) ?? []);
      awaiters.delete(job.key);
      lastServedSeq.set(projectKeyOf(job), ++seq);
      lastStartAt = t;
      void runJob(job);
    }
    if (armReDrain) scheduleReDrain();
    settleIdleIfDone();
  }

  async function runJob(job: BackgroundJob): Promise<void> {
    try {
      await job.run();
    } catch (err) {
      onError(job.key, err);
    } finally {
      running.delete(job.key);
      if (job.exclusiveGroup !== undefined) runningGroups.delete(job.exclusiveGroup);
      // Settle the awaiters captured when this run started (resolve only —
      // errors already went to onError, so a fire-and-forget submit can't
      // surface an unhandled rejection).
      const settled = runningAwaiters.get(job.key);
      runningAwaiters.delete(job.key);
      if (settled !== undefined) for (const r of settled) r();
      drain();
    }
  }

  function scheduleReDrain(): void {
    if (reDrainTimer !== null) return;
    reDrainTimer = setTimeout(() => {
      reDrainTimer = null;
      drain();
    }, reDrainDelayMs);
    // Don't keep the process alive just to retry a deferred backup.
    reDrainTimer.unref();
  }

  /** HS-8726 — schedule the next drain pass `delayMs` out so post-wake job
   *  starts stay spaced. Single pending timer (a later, shorter request
   *  replaces a longer one so the spacing stays tight). */
  function scheduleStaggerDrain(delayMs: number): void {
    if (staggerTimer !== null) clearTimeout(staggerTimer);
    staggerTimer = setTimeout(() => {
      staggerTimer = null;
      drain();
    }, Math.max(0, delayMs));
    staggerTimer.unref();
  }

  return {
    submit(job) {
      pending.set(job.key, job); // coalesce: latest wins
      const done = new Promise<void>((resolve) => {
        const list = awaiters.get(job.key) ?? [];
        list.push(resolve);
        awaiters.set(job.key, list);
      });
      drain();
      return done;
    },
    runningCount: () => running.size,
    pendingCount: () => pending.size,
    onIdle() {
      if (running.size === 0 && pending.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
    noteWake() {
      staggerUntil = now() + wakeStaggerWindowMs;
      drain();
    },
    clear() {
      pending.clear();
      if (reDrainTimer !== null) { clearTimeout(reDrainTimer); reDrainTimer = null; }
      if (staggerTimer !== null) { clearTimeout(staggerTimer); staggerTimer = null; }
      staggerUntil = 0;
      // Resolve awaiters of the dropped pending jobs so their callers don't hang
      // (the work was cancelled, not failed — they get a clean resolve).
      const orphaned = [...awaiters.values()].flat();
      awaiters.clear();
      for (const r of orphaned) r();
      settleIdleIfDone();
    },
  };
}

// ---------------------------------------------------------------------------
// Process-wide default instance
// ---------------------------------------------------------------------------

let defaultScheduler: BackgroundScheduler | null = null;

/** The shared process-wide scheduler, wired to the freeze-logger lag signal.
 *  Every production consumer submits here so all background work shares one
 *  concurrency budget + fairness pool. */
export function getBackgroundScheduler(): BackgroundScheduler {
  if (defaultScheduler === null) {
    defaultScheduler = createBackgroundScheduler();
  }
  return defaultScheduler;
}

/** Test-only — drop the default instance so a test can't inherit another's
 *  queue state. */
export function _resetDefaultSchedulerForTests(): void {
  defaultScheduler?.clear();
  defaultScheduler = null;
}
