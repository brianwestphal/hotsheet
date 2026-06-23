/**
 * HS-8862 (docs/90 §90.2.2) — periodic claim-lease expiry sweep.
 *
 * Correctness does NOT depend on this timer: `claimNext`/`claimById` already
 * treat an expired lease as claimable (lazy reclaim), and `getClaims` filters to
 * live leases. The sweep's job is to *surface + tidy* — clear a dead worker's
 * `claimed_by` and append a "lease expired — reclaimed" note so the maintainer
 * sees that a worker died. Runs OFF the main loop via the §75 background scheduler
 * (GC priority, deferred under lag, coalesced); the interval is `unref()`'d and
 * cleared on shutdown (`lifecycle.ts`).
 */
import { runWithDataDir } from '../db/connection.js';
import { type BackgroundScheduler, getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';

/** 60 s — well inside the default 120 s lease so a dead worker surfaces promptly. */
export const LEASE_SWEEP_INTERVAL_MS = 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export interface LeaseSweepTimerOptions {
  scheduler?: BackgroundScheduler;
  intervalMs?: number;
  /** Inject the sweep worker (tests). Defaults to `sweepExpiredClaims`. */
  sweep?: () => Promise<number>;
  setIntervalFn?: (cb: () => void, ms: number) => NodeJS.Timeout;
}

/** Start (or restart) the periodic lease sweep for the launched project.
 *  Idempotent — a second call replaces the existing timer. */
export function startLeaseSweepTimer(launchedDataDir: string, opts: LeaseSweepTimerOptions = {}): void {
  stopLeaseSweepTimer();
  const intervalMs = opts.intervalMs ?? LEASE_SWEEP_INTERVAL_MS;
  const scheduler = opts.scheduler ?? getBackgroundScheduler();
  const setIntervalFn = opts.setIntervalFn
    ?? ((cb: () => void, ms: number): NodeJS.Timeout => setInterval(cb, ms));
  const sweep = opts.sweep ?? (async (): Promise<number> => {
    const { sweepExpiredClaims } = await import('../db/claims.js');
    return runWithDataDir(launchedDataDir, () => sweepExpiredClaims());
  });

  timer = setIntervalFn(() => {
    void scheduler.submit({
      key: 'claim-lease-sweep',
      projectKey: launchedDataDir,
      priority: PRIORITY.GC,
      deferUnderLag: true,
      run: async () => { await sweep(); },
    });
  }, intervalMs);
  timer.unref();
}

/** Stop the periodic timer (shutdown / tests). No-op when not running. */
export function stopLeaseSweepTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test seam — is the timer currently armed? */
export function isLeaseSweepTimerRunning(): boolean {
  return timer !== null;
}
