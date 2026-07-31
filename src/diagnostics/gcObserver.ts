/**
 * HS-9534 — record GC pauses, because a stop-the-world collection is a blocked
 * event loop and nothing was watching for it.
 *
 * ## Why this exists
 *
 * During HS-9521, 65 % of observed blocking had no instrumented cause and the
 * biggest unattributed blocks clustered tightly around 1.7 s. GC was the obvious
 * suspect, and the running server could not answer: there was no GC
 * instrumentation at all. Settling it required building a standalone rig — 12
 * PGLite clusters, 1.6 GB of `external`, a `PerformanceObserver` — to learn that
 * the worst pause was **3 ms** and a forced `gc()`×2 was **30 ms**, i.e. GC was
 * not the cause.
 *
 * That answer was worth having and nobody should have to build a rig for it
 * again. This is ~30 lines that would have replaced an afternoon.
 *
 * ## Why the threshold
 *
 * V8 fires this observer for every collection, including scavenges that take
 * microseconds. Logging those would swamp the file and tell nobody anything —
 * the log is read by a human looking for a stall. Only pauses at or above
 * `LONG_TASK_THRESHOLD_MS` are recorded, which is the same bar every other
 * writer in `freezeLogger` uses.
 *
 * ## Why `blocking: true` and no `cpuMs`
 *
 * A major GC is stop-the-world: the loop genuinely cannot run for the duration,
 * so it belongs on the blocking side of `summarizeBlocking` rather than swelling
 * the unattributed bucket. `cpuMs` is deliberately omitted — the observer reports
 * a pause that already happened, so there is no interval over which to sample
 * CPU, and inventing one would be worse than leaving the field absent (HS-9528's
 * rule: an entry with no `cpuMs` is never judged).
 */

import { constants, PerformanceObserver } from 'node:perf_hooks';

import { appendFreezeLog, LONG_TASK_THRESHOLD_MS } from './freezeLogger.js';

/** V8's GC kind → a name a human can read in the log. */
export function gcKindName(kind: number | undefined): string {
  switch (kind) {
    case constants.NODE_PERFORMANCE_GC_MAJOR: return 'major';
    case constants.NODE_PERFORMANCE_GC_MINOR: return 'minor';
    case constants.NODE_PERFORMANCE_GC_INCREMENTAL: return 'incremental';
    case constants.NODE_PERFORMANCE_GC_WEAKCB: return 'weak-callback';
    case undefined: return 'unknown';
    default: return 'unknown';
  }
}

/** Should this pause be written to the log? Pure, and threshold-injectable so a
 *  test can assert on a REAL collection instead of hoping the machine produces a
 *  100 ms pause on cue. */
export function shouldRecordGcPause(durationMs: number, thresholdMs: number = LONG_TASK_THRESHOLD_MS): boolean {
  return durationMs >= thresholdMs;
}

/** The context string a recorded pause gets. Kept stable — `rankByContext`
 *  groups by it, so a per-pause detail here would fragment the aggregate. */
export function gcContext(kind: number | undefined): string {
  return `gc.pause: ${gcKindName(kind)}`;
}

let observer: PerformanceObserver | null = null;

/**
 * Start recording GC pauses into the process-wide diagnostics log. Idempotent.
 *
 * `dataDir` is provenance only (HS-9531) — GC is process-wide, so it is stamped
 * with whichever project booted the observer, exactly like the heartbeat.
 */
export function startGcObserver(dataDir: string, thresholdMs: number = LONG_TASK_THRESHOLD_MS): void {
  if (observer !== null) return;
  observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (!shouldRecordGcPause(entry.duration, thresholdMs)) continue;
      const kind = (entry as { detail?: { kind?: number } }).detail?.kind;
      void appendFreezeLog(dataDir, {
        ts: new Date().toISOString(),
        source: 'server-gc',
        durationMs: Math.round(entry.duration),
        context: gcContext(kind),
        // Stop-the-world: this is real blocked time, not wall time.
        blocking: true,
      });
    }
  });
  // `buffered: false` — we want pauses as they happen, not a replay at startup.
  observer.observe({ entryTypes: ['gc'] });
}

/** Stop the observer (graceful shutdown / tests). */
export function stopGcObserver(): void {
  if (observer !== null) {
    observer.disconnect();
    observer = null;
  }
}
