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

/** HS-8163 — hard cap on `freeze.log` size. Freezes during a long debug
 *  session can accumulate hundreds of entries (~250 B each); without a
 *  ceiling the file grows unbounded and eats user disk. 1 MB ≈ 4000
 *  entries — enough for ~a week of normal-use diagnostics. When a new
 *  append would push the file past this cap, the head of the file is
 *  dropped down to ~half so the next ~2000 entries fit before the next
 *  truncate (avoids truncating on every write near the boundary). */
export const FREEZE_LOG_MAX_BYTES = 1_048_576; // 1 MiB
/** Floor we truncate down to when the cap is hit. Keeping it well below
 *  the cap means a freeze burst doesn't re-trigger the truncate path on
 *  every write — there's headroom for ~half the cap before the next
 *  rotation. */
export const FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE = 524_288; // 512 KiB

// Sentinel line inserted at the top of the file after a truncate so a
// reader pasting the log knows the head was dropped (and roughly when).
// Shape: a JSON object with source "freeze.log-truncated", durationMs 0,
// and a context message describing the size before / after.
function truncateMarkerLine(ts: string, beforeBytes: number, afterBytes: number): string {
  const entry: FreezeEntry = {
    ts,
    source: 'freeze.log-truncated',
    durationMs: 0,
    context: `head dropped — file exceeded ${beforeBytes} bytes, kept tail ${afterBytes} bytes`,
  };
  return JSON.stringify(entry) + '\n';
}

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
    | 'client-server-busy-banner' // HS-8425 — global server-slow banner activation
    | 'server-heartbeat'       // 50 ms setInterval on the Node process
    | 'server-instrument-sync' // wrapped synchronous block
    | 'server-instrument-async' // wrapped async block
    | 'freeze.log-truncated';  // HS-8163 — marker for the head-dropped sentinel
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
        // HS-8163 — rotation gate. Stat the current file; if appending
        // the new line would push it past `FREEZE_LOG_MAX_BYTES`, drop
        // the head of the file down to `FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE`
        // (keeping the tail intact — the most recent freezes are the
        // most useful), insert a one-line truncation marker so a reader
        // pasting the log knows the head was dropped, then append the
        // new line. Bounds the file at ~1 MB indefinitely; the floor is
        // far enough below the cap that a freeze burst doesn't trigger
        // back-to-back truncates on every write.
        await rotateIfNeeded(path, line.length);
        await fsp.appendFile(path, line, 'utf8');
      } catch (err) {
        console.warn('[hotsheet freeze.log] append failed:', err instanceof Error ? err.message : String(err));
      }
    });
  appendQueue.set(dataDir, next);
  return next;
}

/** HS-8163 — when the file exists AND its current size + the pending
 *  write would exceed `FREEZE_LOG_MAX_BYTES`, rewrite the file with the
 *  most-recent tail (~`FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE` bytes)
 *  plus a one-line truncation marker prepended. The marker is itself a
 *  valid JSONL entry (source `freeze.log-truncated`) so JSON-parsing
 *  consumers don't choke. Missing file (ENOENT) is a no-op — the
 *  caller's `appendFile` will create it. Any other error is swallowed:
 *  freeze.log is diagnostic-only and we'd rather lose a rotation than
 *  cascade into the caller's hot path. */
async function rotateIfNeeded(path: string, pendingBytes: number): Promise<void> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(path);
  } catch (err) {
    // File doesn't exist yet (first ever append) — nothing to rotate.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (stat.size + pendingBytes <= FREEZE_LOG_MAX_BYTES) return;

  // Read the current file. Files at this scale (~1 MB) are cheap to
  // slurp; streaming would be more code for negligible payoff.
  let content: string;
  try {
    content = await fsp.readFile(path, 'utf8');
  } catch (err) {
    console.warn('[hotsheet freeze.log] rotate readFile failed:', err instanceof Error ? err.message : String(err));
    return;
  }
  const beforeBytes = Buffer.byteLength(content, 'utf8');
  // Walk forward from a target offset, advance to the next `\n` so the
  // tail starts on a complete JSONL line (a mid-line truncation would
  // leave the first entry unparseable).
  const targetOffset = Math.max(0, beforeBytes - FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE);
  const newlineIdx = content.indexOf('\n', targetOffset);
  const tail = newlineIdx === -1 ? '' : content.slice(newlineIdx + 1);
  const afterBytes = Buffer.byteLength(tail, 'utf8');
  const marker = truncateMarkerLine(new Date().toISOString(), beforeBytes, afterBytes);
  // Single overwriting write so a concurrent read either sees the old
  // file or the new one — never a half-written state. The per-dataDir
  // `appendQueue` ordering guarantees no other writes interleave here.
  try {
    await fsp.writeFile(path, marker + tail, 'utf8');
  } catch (err) {
    console.warn('[hotsheet freeze.log] rotate writeFile failed:', err instanceof Error ? err.message : String(err));
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let lastHeartbeatNs = 0n;
// HS-8724 — most-recent observed event-loop lag (ms), updated EVERY heartbeat
// tick (not just when it crosses the freeze-log threshold). This is the
// backpressure signal the background-work scheduler reads via
// `getRecentEventLoopLagMs()` to decide whether to hold back deferrable
// low-priority jobs. 0 until the heartbeat starts (so callers degrade to "no
// backpressure" rather than throttling on a stale reading).
let lastEventLoopLagMs = 0;
// HS-8674 — single-instance assumption: there is ONE event-loop heartbeat per
// Node process (the timer is idempotent), and it attributes every stall to the
// dataDir of the FIRST `startServerEventLoopHeartbeat` caller. On a
// multi-project instance the event loop is shared, so a stall genuinely can't
// be attributed to one project — every project's work runs on the same loop.
// We therefore log it against the first-booted project's freeze.log rather than
// fanning the same entry out to every registered dataDir (which would multiply
// one real stall into N misleading per-project entries). The per-CLIENT freeze
// path (`appendFreezeLog` from the `/api/diagnostics/freeze` route) is correctly
// per-project; only this process-wide heartbeat is single-attribution.
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
    // HS-8724 — record the lag on every tick for the scheduler's backpressure
    // read, clamped at 0 (a slightly-early timer fire yields a small negative).
    lastEventLoopLagMs = blockMs > 0 ? blockMs : 0;
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
 * HS-8724 — the most recent event-loop lag (ms) observed by the heartbeat,
 * refreshed every `HEARTBEAT_INTERVAL_MS`. The background-work scheduler reads
 * this to apply backpressure: when lag is high, deferrable low-priority jobs
 * (backups, GC) are held back so foreground request handling keeps the loop.
 * Returns 0 when the heartbeat hasn't started (no signal → no throttling).
 */
export function getRecentEventLoopLagMs(): number {
  return lastEventLoopLagMs;
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
  lastEventLoopLagMs = 0;
  appendQueue.clear();
}
