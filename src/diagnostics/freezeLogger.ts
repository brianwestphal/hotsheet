/**
 * HS-8054 v3 — file-based freeze diagnostic logger.
 *
 * The user reported (2026-05-04) that the previous in-browser instrumentation
 * (HS-8054 v1 PerformanceObserver + v2 50ms heartbeat with console.error +
 * toast) wasn't surfacing the hangs they were experiencing — and that the
 * problem may not even be the client locking up: it could be the WebSocket
 * connection between client and server, or between the server and a PTY.
 * They asked for a file-based log at `<dataDir>/freeze.log` they can paste
 * back so we can absorb diagnostics independent of console output.
 *
 * This module is the server-side half of v3:
 *
 *   1. `appendFreezeLog(dataDir, entry)` — append a single JSONL line to
 *      `<dataDir>/freeze.log`. Single-flight queue per dataDir so concurrent
 *      writers don't interleave bytes mid-line.
 *   2. `startServerEventLoopHeartbeat(dataDir)` — Node-process equivalent
 *      of the client heartbeat. `setInterval(50ms)` measures the gap; any
 *      gap ≥ `LONG_TASK_THRESHOLD_MS` is logged with `source: 'server-heartbeat'`.
 *      Cheap (20 ticks/sec, no allocs unless a block fires).
 *   3. `instrumentSync(dataDir, label, fn)` / `instrumentAsync(dataDir, label, fn)`
 *      — execute `fn` and log to freeze.log if its wall-clock duration
 *      exceeds `LONG_TASK_THRESHOLD_MS`. Used by callers wrapping
 *      suspicious synchronous blocks (PTY write, WS message handlers).
 *
 * Companion route: `POST /api/diagnostics/freeze` in `src/routes/diagnostics.ts`
 * accepts client-detected events (HS-8054 v1/v2 long-task observer +
 * heartbeat) and forwards them through `appendFreezeLog`. The user gets a
 * single file with both client-side AND server-side hangs interleaved by
 * timestamp.
 *
 * Pure side-effect: writes to disk. No state on the module surface beyond
 * the per-dataDir append queue + the heartbeat timer. Tests use a tmp
 * dataDir + the `_resetForTesting` helper to drop both.
 */

import { promises as fsp } from 'fs';
import { join } from 'path';

export const FREEZE_LOG_FILENAME = 'freeze.log';
export const LONG_TASK_THRESHOLD_MS = 100;

/** Heartbeat tick interval for the server-side event-loop block detector.
 *  50 ms matches the client heartbeat (HS-8054 v2). 20 ticks/sec is
 *  trivial overhead under any realistic Node load. */
const HEARTBEAT_INTERVAL_MS = 50;

export interface FreezeEntry {
  /** ISO-8601 timestamp at the moment the block was OBSERVED (i.e. the
   *  end of the long task — the recorded `ts` is always after the block
   *  finished, by the nature of timer-based detection). Server uses
   *  `new Date().toISOString()`; client uses its own clock so timestamps
   *  may drift slightly between the two sources. */
  ts: string;
  /** Where the entry came from. The user's pasted log is grouped by
   *  source so we can tell at a glance whether the freeze was in the
   *  browser, in the Node process, or in the connection between them. */
  source:
    | 'client-observer'        // PerformanceObserver({ type: 'longtask' })
    | 'client-heartbeat'       // 50 ms setInterval heartbeat
    | 'server-heartbeat'       // 50 ms setInterval on the Node process
    | 'server-instrument-sync' // wrapped synchronous block
    | 'server-instrument-async'; // wrapped async block
  /** Block duration in ms. */
  durationMs: number;
  /** Free-form context — for client entries this is the recent UI
   *  interactions list; for server `instrumentSync` entries this is the
   *  caller-supplied label (e.g. `pty.write:default`). */
  context: string;
  /** Optional: for client entries the original wall-clock string from
   *  the client's `formatWallClock`; for server entries left undefined. */
  clientWallClock?: string;
  /** Optional: arbitrary additional fields the source wants to record. */
  extra?: Record<string, unknown>;
}

/** Single-flight queue per dataDir so two concurrent `appendFreezeLog`
 *  calls don't interleave writes mid-line. The append is small (≤ 1 KB
 *  per entry) and infrequent (≤ once per ~100 ms during a freeze burst),
 *  so a per-dataDir Promise chain is plenty. */
const appendQueue = new Map<string, Promise<void>>();

/**
 * Append a single JSONL line to `<dataDir>/freeze.log`. Each line is a
 * complete `FreezeEntry` JSON object followed by `\n`, so the file is
 * machine-readable AND human-greppable.
 *
 * Resolves once the bytes have hit the OS buffer (no fsync — diagnostics
 * data can survive an unclean shutdown losing its tail). Errors are
 * swallowed (logged to console.warn) so a freeze-log write failure never
 * cascades into the caller's hot path.
 */
export function appendFreezeLog(dataDir: string, entry: FreezeEntry): Promise<void> {
  const path = join(dataDir, FREEZE_LOG_FILENAME);
  const line = JSON.stringify(entry) + '\n';
  const prev = appendQueue.get(dataDir) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* drop chained errors so one bad write doesn't poison the queue */ })
    .then(async () => {
      try {
        await fsp.appendFile(path, line, 'utf8');
      } catch (err) {
        console.warn('[hotsheet freeze.log] append failed:', err instanceof Error ? err.message : String(err));
      }
    });
  appendQueue.set(dataDir, next);
  return next;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatNs = 0n;
let heartbeatDataDir: string | null = null;

/**
 * Start the server-side event-loop heartbeat. Idempotent — second + later
 * calls are no-ops (single timer per Node process). When the gap between
 * heartbeats exceeds `HEARTBEAT_INTERVAL_MS + LONG_TASK_THRESHOLD_MS`,
 * appends a `source: 'server-heartbeat'` entry to freeze.log.
 *
 * Uses `process.hrtime.bigint()` for monotonic high-resolution timing —
 * `Date.now()` would jitter on NTP slew, and `performance.now()` isn't
 * always available in older Node versions (it is in Node 16+ but the
 * bigint path is unambiguous and faster).
 */
export function startServerEventLoopHeartbeat(dataDir: string): void {
  if (heartbeatTimer !== null) return;
  heartbeatDataDir = dataDir;
  lastHeartbeatNs = process.hrtime.bigint();
  heartbeatTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const elapsedMs = Number(now - lastHeartbeatNs) / 1_000_000;
    lastHeartbeatNs = now;
    const blockMs = elapsedMs - HEARTBEAT_INTERVAL_MS;
    if (blockMs >= LONG_TASK_THRESHOLD_MS && heartbeatDataDir !== null) {
      void appendFreezeLog(heartbeatDataDir, {
        ts: new Date().toISOString(),
        source: 'server-heartbeat',
        durationMs: Math.round(blockMs),
        context: 'event-loop blocked',
      });
    }
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the process alive for the heartbeat alone — if every
  // other handle is gone, the process should exit cleanly.
  heartbeatTimer.unref();
}

/**
 * Stop the server-side heartbeat. Called from `gracefulShutdown` so the
 * timer doesn't outlive the data directory.
 */
export function stopServerEventLoopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatDataDir = null;
}

/**
 * Wrap a synchronous block. If `fn()` takes ≥ `LONG_TASK_THRESHOLD_MS`,
 * append a `source: 'server-instrument-sync'` entry to freeze.log. The
 * caller's return value is preserved verbatim. Throws propagate
 * unchanged (after logging the duration).
 */
export function instrumentSync<T>(dataDir: string, label: string, fn: () => T): T {
  const startNs = process.hrtime.bigint();
  try {
    return fn();
  } finally {
    const durMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (durMs >= LONG_TASK_THRESHOLD_MS) {
      void appendFreezeLog(dataDir, {
        ts: new Date().toISOString(),
        source: 'server-instrument-sync',
        durationMs: Math.round(durMs),
        context: label,
      });
    }
  }
}

/**
 * Wrap an async block. Same semantics as `instrumentSync` but for
 * Promise-returning functions. The returned Promise resolves / rejects
 * exactly like `fn()`'s; the freeze-log append happens in the
 * `finally` so it doesn't add to the observed duration.
 */
export async function instrumentAsync<T>(dataDir: string, label: string, fn: () => Promise<T>): Promise<T> {
  const startNs = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    const durMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    if (durMs >= LONG_TASK_THRESHOLD_MS) {
      void appendFreezeLog(dataDir, {
        ts: new Date().toISOString(),
        source: 'server-instrument-async',
        durationMs: Math.round(durMs),
        context: label,
      });
    }
  }
}

/** Test-only: drop module state so tests don't bleed across runs. */
export function _resetForTesting(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatDataDir = null;
  lastHeartbeatNs = 0n;
  appendQueue.clear();
}
