/**
 * HS-8889 (§85.2.1) — periodic telemetry retention sweep.
 *
 * The §67.6 retention sweep otherwise runs only at startup
 * (`cli.ts::initializeProject` → `cleanupAllProjectsTelemetry`). The desktop app
 * can stay open for days, and §68 enhanced tracing emits high-volume spans, so a
 * long-lived session accumulates rows unbounded between restarts. This adds a
 * **24 h timer** that re-runs the same driver, with two safety properties:
 *   - the work runs OFF the main loop via the §75 background scheduler (GC
 *     priority, deferred under event-loop lag, coalesced) — never inline on the
 *     timer tick, so a big sweep can't wedge the loop;
 *   - the interval is `unref()`'d (never keeps the process alive) and cleared on
 *     shutdown (`lifecycle.ts`).
 *
 * After each sweep it nudges the §75 telemetry-vacuum pass (HS-8884) so the freed
 * pages are actually reclaimed — a `DELETE` alone doesn't shrink PGLite files.
 */
import { cleanupAllProjectsTelemetry } from './cleanup.js';
import { type BackgroundScheduler, getBackgroundScheduler, PRIORITY } from './scheduler/backgroundScheduler.js';

/** 24 h, per the HS-8886 decision (hard-coded; no setting unless demand). */
export const TELEMETRY_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export interface RetentionTimerOptions {
  /** Inject a scheduler (tests). Defaults to the process-wide singleton. */
  scheduler?: BackgroundScheduler;
  /** Override the 24 h cadence (tests). */
  intervalMs?: number;
  /** Inject the sweep worker (tests). Defaults to `cleanupAllProjectsTelemetry`. */
  sweep?: (dataDir: string) => Promise<unknown>;
  /** Inject the post-sweep vacuum nudge (tests). Defaults to the §75 vacuum pass. */
  nudgeVacuum?: (dataDir: string) => void;
  /** Inject `setInterval` (tests). Defaults to the global. */
  setIntervalFn?: (cb: () => void, ms: number) => NodeJS.Timeout;
}

async function defaultNudgeVacuum(dataDir: string): Promise<void> {
  // Lazy import to avoid a static cycle (telemetryVacuum imports nothing here,
  // but keep the dependency one-directional + load-on-demand).
  const { scheduleTelemetryMaintenance } = await import('./db/telemetryVacuum.js');
  void scheduleTelemetryMaintenance(dataDir);
}

/**
 * Start (or restart) the periodic retention timer. Idempotent — a second call
 * replaces the existing timer so there's never more than one. Each tick submits
 * ONE coalesced sweep job (`telemetry-retention-sweep`) to the scheduler.
 */
export function startTelemetryRetentionTimer(launchedDataDir: string, opts: RetentionTimerOptions = {}): void {
  stopTelemetryRetentionTimer();
  const intervalMs = opts.intervalMs ?? TELEMETRY_SWEEP_INTERVAL_MS;
  const scheduler = opts.scheduler ?? getBackgroundScheduler();
  const sweep = opts.sweep ?? ((dir: string) => cleanupAllProjectsTelemetry(dir));
  const nudgeVacuum = opts.nudgeVacuum ?? ((dir: string) => { void defaultNudgeVacuum(dir); });
  const setIntervalFn = opts.setIntervalFn
    ?? ((cb: () => void, ms: number): NodeJS.Timeout => setInterval(cb, ms));

  timer = setIntervalFn(() => {
    void scheduler.submit({
      key: 'telemetry-retention-sweep',
      projectKey: launchedDataDir,
      priority: PRIORITY.GC,
      deferUnderLag: true,
      run: async () => {
        await sweep(launchedDataDir);
        nudgeVacuum(launchedDataDir);
      },
    });
  }, intervalMs);
  // Never keep the process alive just to run a maintenance sweep.
  timer.unref();
}

/** Stop the periodic timer (shutdown / tests). No-op when not running. */
export function stopTelemetryRetentionTimer(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test seam — is the timer currently armed? */
export function isTelemetryRetentionTimerRunning(): boolean {
  return timer !== null;
}
