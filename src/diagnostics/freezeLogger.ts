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
import { getHeapStatistics } from 'v8';

import { enterOperation, exitOperation } from './currentOperation.js';
import { diagnosticsDir, projectLabelForDataDir } from './diagnosticsDir.js';

export const FREEZE_LOG_FILENAME = 'freeze.log';
export const LONG_TASK_THRESHOLD_MS = 100;

/** HS-8163 — hard cap on `freeze.log` size. Freezes during a long debug
 *  session can accumulate hundreds of entries (~250 B each); without a
 *  ceiling the file grows unbounded and eats user disk. 1 MB ≈ 4000
 *  entries — enough for ~a week of normal-use diagnostics. When a new
 *  append would push the file past this cap, the head of the file is
 *  dropped down to ~half so the next ~2000 entries fit before the next
 *  truncate (avoids truncating on every write near the boundary). */
// HS-9531 — raised from 1 MiB. Nine projects now share ONE log instead of writing
// nine, so the same wall-clock coverage costs ~9x the bytes; at observed rates
// 1 MiB held under four hours merged. 8 MiB is ~a day and a half of coverage.
export const FREEZE_LOG_MAX_BYTES = 8_388_608; // 8 MiB
/** Floor we truncate down to when the cap is hit. Keeping it well below
 *  the cap means a freeze burst doesn't re-trigger the truncate path on
 *  every write — there's headroom for ~half the cap before the next
 *  rotation. */
export const FREEZE_LOG_TARGET_BYTES_AFTER_TRUNCATE = 4_194_304; // 4 MiB

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

/**
 * HS-8726 — the smallest gap worth *considering* a suspend. A suspend is always
 * long, so anything shorter is unambiguously an ordinary block and skips the
 * divergence check below.
 *
 * HS-9520 — this used to be the whole test: any gap ≥ 10 s was declared a
 * suspend, justified by "no genuine on-loop task runs for 10 s". That premise
 * was false — `freeze.log` records `plugin.scheduledSync:github-issues` running
 * 9–16 s, 31 times — and because the heartbeat measures with a MONOTONIC clock,
 * the rule was also inverted (see `isSuspendGap`). Length alone cannot classify;
 * it only decides whether to bother asking.
 */
export const WAKE_GAP_THRESHOLD_MS = 10_000;

/**
 * HS-9520 — how far wall-clock must run ahead of the monotonic clock before a
 * gap is a suspend rather than a block. Generous: the two track within ~1 ms
 * during a real block (measured), and a suspend diverges by seconds at minimum.
 */
export const SUSPEND_CLOCK_DIVERGENCE_MS = 2_000;

/**
 * Was this gap an OS freeze (sleep / `kill -STOP` / VM pause) rather than the
 * event loop being pinned by our own work?
 *
 * **Duration cannot answer that, and using it got the answer backwards.** The
 * heartbeat measures with `process.hrtime.bigint()`, which is MONOTONIC — and a
 * monotonic clock does not advance while the machine is asleep. So a real
 * suspend produces a *small* monotonic gap, while a genuine 20 s block produces
 * a large one. The old length test therefore labelled our worst blocks
 * "suspend" and would have missed an actual suspend entirely.
 *
 * The clocks tell them apart directly:
 *
 *   real suspend  → wall-clock jumps, monotonic barely moves → large divergence
 *   genuine block → both advance together                    → ~zero divergence
 *
 * Verified on 2026-07-31: two entries logged as "resumed from suspend" (13 s and
 * 23 s) while `pmset -g log` showed the machine had not slept at all that day.
 *
 * **HS-9528 update — on THIS platform the divergence never appears.** Measured
 * 2026-07-31: over 171 h of uptime containing 743 sleep events, `hrtime.bigint()`
 * and wall-clock uptime (`kern.boottime`) agreed to within 0.00 h. libuv's macOS
 * monotonic clock therefore ADVANCES during sleep, so a real suspend produces ~0
 * divergence and lands in the "block" branch below. The fallback clause this
 * comment already described is not hypothetical here — it is the normal path.
 *
 * That is why `cpuMs` exists on `FreezeEntry`: CPU time is the signal that
 * actually separates a wedge from a sleeping laptop, since a suspend accrues
 * none. See `freezeAnalysis.looksLikeSuspend`.
 *
 * Safe under either platform behavior: if some platform's monotonic clock *did*
 * include suspend time, divergence would be ~0 and we would call it a block —
 * which only over-reports blocks, and keeps backpressure engaged. Erring that
 * way is recoverable; erring the other way is what wedged the server.
 */
export function isSuspendGap(monotonicGapMs: number, wallGapMs: number): boolean {
  if (monotonicGapMs < WAKE_GAP_THRESHOLD_MS && wallGapMs < WAKE_GAP_THRESHOLD_MS) return false;
  return wallGapMs - monotonicGapMs >= SUSPEND_CLOCK_DIVERGENCE_MS;
}

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
    | 'server-wake'            // HS-8726 — process resumed from suspend (gap ≫ a real block)
    | 'server-memory'          // HS-9421 — periodic memory sample (the trend INTO a wedge)
    | 'server-gc'              // HS-9534 — a stop-the-world GC pause over the threshold
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
  /** HS-9531 — which project produced this entry. Provenance used to be implicit
   *  in WHICH per-project file the line landed in; now every entry goes to one
   *  process-wide log, so it has to be carried explicitly. */
  project?: string;
  /**
   * HS-9531 — is `durationMs` time the EVENT LOOP WAS BLOCKED, or merely wall time?
   *
   * `instrumentAsync` measures a promise end-to-end, so an `await` on network or
   * threadpool I/O is counted while the loop is free. Reading those as blocking is
   * how HS-9521 reported ~10 % of the loop blocked when the heartbeat's real figure
   * was 2.88 %, and how it nominated `fsyncDbDir` — the LARGEST wall-time entry in
   * the dataset at 773.6 s — as a top offender when it contributes 0.5 s of real
   * blocking, HS-8351 having already moved it to the threadpool.
   *
   * The distinction has to live in the DATA. Fixing it only in whatever view
   * aggregates the log leaves the next reader to rediscover it.
   */
  blocking?: boolean;
  /**
   * HS-9528 — CPU milliseconds consumed while this entry was being measured.
   *
   * Exists because `durationMs` alone CANNOT tell a long block from a sleeping
   * laptop on this platform, and a confident reading of it produced a wrong
   * conclusion. Measured 2026-07-31: over 171 h of uptime containing 743 sleep
   * events, `process.hrtime.bigint()` and wall-clock uptime agreed to within
   * 0.00 h — so libuv's macOS monotonic clock ADVANCES during sleep. HS-9520's
   * clock-divergence test therefore reports ~0 divergence for a real suspend and
   * classifies it as a block (which that ticket anticipated and called safe —
   * over-reporting blocks only keeps backpressure engaged).
   *
   * CPU time settles it, and portably: a genuinely CPU-bound block accrues CPU
   * roughly in step with wall time; a suspend accrues none. This is how a
   * 17-minute `VACUUM` entry can be recognised as a closed lid rather than
   * seventeen minutes of a wedged server.
   *
   * Process-wide, so for an async span it includes whatever else ran. That is
   * fine for the question being asked — near-zero CPU across a long span means
   * nothing ran at all, which no amount of concurrent work can fake.
   */
  cpuMs?: number;
}

/**
 * HS-9421 — periodic memory sample interval. Diagnosing the HS-9420 OOM crash
 * loop needed an inspector attach because `freeze.log` recorded duration +
 * context only, and during the fatal wedge it recorded NOTHING (the loop never
 * recovers, so the heartbeat never gets to log) — the file just stops, which
 * reads like a clean exit. A low-frequency sample gives a memory TREND leading
 * into a wedge instead of only a post-mortem number.
 *
 * One entry a minute is ~250 B, i.e. ~350 KB/day against the 1 MiB cap — small
 * enough to be free, frequent enough to show a creep (the live measurement saw
 * +13 MB/min at complete idle).
 */
export const MEMORY_SAMPLE_INTERVAL_MS = 60_000;

/** HS-9421 — warn once `heapUsed + external` crosses this share of the V8 heap
 *  limit. This class of death is silent until it is fatal, so the sample is
 *  marked at a level a reader will notice while there is still headroom. */
export const MEMORY_PRESSURE_WARN_RATIO = 0.75;

/** HS-9421 — supplies the count of open PGLite clusters. Injected so
 *  `diagnostics/` keeps no dependency on `db/`. */
let openClusterCounter: (() => number) | null = null;

/** HS-9421 — register the open-PGLite-cluster counter (called once at boot).
 *  That single number is what would have pointed straight at HS-9420. */
export function setFreezeLogClusterCounter(fn: () => number): void {
  openClusterCounter = fn;
}

/** HS-9470 — supplies the cluster-eviction counters. Injected for the same
 *  reason as the counter above: `diagnostics/` keeps no dependency on `db/`. */
let evictionStatsReader: (() => {
  byMode: Record<string, number>;
  project: number;
  telemetry: number;
  churn: number;
}) | null = null;

/** HS-9470 — register the eviction-stats reader (called once at boot). */
export function setFreezeLogEvictionStats(fn: () => {
  byMode: Record<string, number>;
  project: number;
  telemetry: number;
  churn: number;
}): void {
  evictionStatsReader = fn;
}

const MB = 1024 * 1024;

/**
 * HS-9421 — the memory snapshot recorded alongside a freeze entry.
 *
 * `external` is the field that matters and the one nobody looks at: PGLite's
 * WASM heaps live there, ~180 MB per open cluster, and it does NOT appear in
 * `rss` (WASM memory is reserved sparsely and largely non-resident). During
 * HS-9420 `ps` showed a comfortable 1.3 GB RSS while `external` was 3.2 GB
 * against a 4.1 GB ceiling.
 */
export function memorySnapshot(): Record<string, number | boolean> {
  const mem = process.memoryUsage();
  const limit = getHeapStatistics().heap_size_limit;
  const heapUsedMb = Math.round(mem.heapUsed / MB);
  const externalMb = Math.round(mem.external / MB);
  const limitMb = Math.round(limit / MB);
  const usedRatio = limit > 0 ? (mem.heapUsed + mem.external) / limit : 0;
  return {
    rssMb: Math.round(mem.rss / MB),
    heapUsedMb,
    externalMb,
    arrayBuffersMb: Math.round(mem.arrayBuffers / MB),
    heapLimitMb: limitMb,
    usedPctOfLimit: Math.round(usedRatio * 100),
    openPGLiteClusters: openClusterCounter === null ? -1 : openClusterCounter(),
    memoryPressure: usedRatio >= MEMORY_PRESSURE_WARN_RATIO,
    // HS-9470 — the eviction counters, so a freeze capture says not just how much
    // memory was in use but what the cache was doing to keep it there. `evictChurn`
    // is the one to read first: a non-trivial count means a budget or idle window
    // is too tight and we are paying reopens for nothing.
    ...evictionCounters(),
  };
}

/** Flattened eviction counters for the snapshot, or nothing before boot wiring. */
function evictionCounters(): Record<string, number> {
  if (evictionStatsReader === null) return {};
  const s = evictionStatsReader();
  return {
    evictCap: s.byMode.cap,
    evictIdle: s.byMode.idle,
    evictHeadroom: s.byMode.headroom,
    evictProject: s.project,
    evictTelemetry: s.telemetry,
    evictChurn: s.churn,
  };
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
  // HS-9531 — `dataDir` is now PROVENANCE, not a destination. Every entry lands in
  // one process-wide log with the originating project recorded on the line.
  //
  // The signature is deliberately unchanged: 27 `instrumentSync`/`instrumentAsync`
  // call sites already thread a dataDir through and all still know which project
  // they belong to, so changing where the bytes go without changing what callers
  // pass keeps the diff to this module.
  const path = join(diagnosticsDir(), FREEZE_LOG_FILENAME);
  const stamped: FreezeEntry = entry.project === undefined
    ? { ...entry, project: projectLabelForDataDir(dataDir) }
    : entry;
  const line = JSON.stringify(stamped) + '\n';
  // Keyed by the FILE, not the dataDir. With one shared log, per-dataDir chains
  // would let two projects interleave bytes mid-line — the exact thing this queue
  // exists to prevent.
  const prev = appendQueue.get(path) ?? Promise.resolve();
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
  appendQueue.set(path, next);
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
/** HS-9520 — wall-clock cursor, sampled beside `lastHeartbeatNs` so a gap can be
 *  classified as suspend-vs-block by clock divergence rather than by length. */
let lastHeartbeatWallMs = 0;
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
// HS-8726 — listeners notified when the heartbeat detects a system suspend/
// resume (a gap ≥ WAKE_GAP_THRESHOLD_MS). The scheduler registers one to open
// its post-wake stagger window. Process-lifetime; never grows unbounded.
const wakeListeners = new Set<(gapMs: number) => void>();

/**
 * HS-8726 — subscribe to system-wake events. The listener fires with the
 * observed gap (ms) when the process resumes from a suspend. Returns an
 * unsubscribe function. Wired from `cli.ts` to `backgroundScheduler.noteWake`.
 */
export function onServerWake(listener: (gapMs: number) => void): () => void {
  wakeListeners.add(listener);
  return () => { wakeListeners.delete(listener); };
}

/**
 * Process one heartbeat gap (`blockMs` = observed inter-tick gap minus the
 * expected interval). Extracted from the interval callback so the wake-vs-block
 * classification is unit-testable without a real timer.
 *
 * HS-8726 — a gap ≥ `WAKE_GAP_THRESHOLD_MS` is a suspend/resume, not an
 * event-loop block: log it as `server-wake` (NOT a misleading multi-hour
 * "event-loop blocked"), do NOT let the sleep gap poison the backpressure lag
 * reading, and fire the wake listeners so the scheduler can re-stagger.
 */
function handleHeartbeatGap(blockMs: number, wallGapMs: number = blockMs): void {
  if (isSuspendGap(blockMs, wallGapMs)) {
    lastEventLoopLagMs = 0; // the suspend gap is not real event-loop lag
    if (heartbeatDataDir !== null) {
      void appendFreezeLog(heartbeatDataDir, {
        ts: new Date().toISOString(),
        source: 'server-wake',
        durationMs: Math.round(wallGapMs),
        blocking: false, // a suspend is not the loop being pinned by our own work
        context: `resumed from suspend after ~${Math.round(wallGapMs / 1000).toString()}s`,
      });
    }
    for (const listener of wakeListeners) {
      try { listener(wallGapMs); } catch { /* a wake listener must never break the heartbeat */ }
    }
    return;
  }
  // HS-8724 — record the lag on every tick for the scheduler's backpressure
  // read, clamped at 0 (a slightly-early timer fire yields a small negative).
  lastEventLoopLagMs = blockMs > 0 ? blockMs : 0;
  if (blockMs >= LONG_TASK_THRESHOLD_MS && heartbeatDataDir !== null) {
    void appendFreezeLog(heartbeatDataDir, {
      ts: new Date().toISOString(),
      source: 'server-heartbeat',
      durationMs: Math.round(blockMs),
      context: 'event-loop blocked',
      blocking: true, // an inter-tick gap IS blocked time — the ground truth
      // HS-9421 — every block carries the memory picture, so a GC-thrash wedge
      // is distinguishable from a slow query without an inspector attach.
      extra: memorySnapshot(),
    });
  }
}

/** Test-only — drive the gap handler directly (no real timer) to exercise the
 *  wake-vs-block classification + listener fan-out.
 *
 *  `wallGapMs` defaults to `blockMs`, i.e. the clocks agree — which is a genuine
 *  on-loop block. Pass a larger wall gap to simulate an OS suspend (HS-9520). */
export function _simulateHeartbeatGapForTesting(blockMs: number, wallGapMs: number = blockMs): void {
  handleHeartbeatGap(blockMs, wallGapMs);
}

/** HS-9421 — the periodic memory-sample timer (separate from the 50 ms
 *  heartbeat, which is far too hot to log on). */
let memorySampleTimer: ReturnType<typeof setInterval> | null = null;

/**
 * HS-9421 — start the low-frequency memory sampler. Idempotent. Writes one
 * `server-memory` entry per `MEMORY_SAMPLE_INTERVAL_MS` so `freeze.log` carries
 * a memory TREND, not just a post-mortem. Unref'd — diagnostics must never keep
 * the process alive.
 */
export function startMemorySampler(dataDir: string): void {
  if (memorySampleTimer !== null) return;
  const sample = (): void => {
    const snap = memorySnapshot();
    void appendFreezeLog(dataDir, {
      ts: new Date().toISOString(),
      source: 'server-memory',
      durationMs: 0,
      context: snap.memoryPressure === true
        ? `MEMORY PRESSURE: ${String(snap.usedPctOfLimit)}% of the V8 limit with ${String(snap.openPGLiteClusters)} open PGLite clusters (each pins ~180MB of external; external is not visible in rss)`
        : 'periodic memory sample',
      extra: snap,
    });
  };
  sample(); // one immediately, so a short-lived process still records something
  memorySampleTimer = setInterval(sample, MEMORY_SAMPLE_INTERVAL_MS);
  memorySampleTimer.unref();
}

/** HS-9421 — stop the memory sampler (graceful shutdown / tests). */
export function stopMemorySampler(): void {
  if (memorySampleTimer !== null) {
    clearInterval(memorySampleTimer);
    memorySampleTimer = null;
  }
}

/**
 * Start the server-side event-loop heartbeat. Idempotent — second + later
 * calls are no-ops (single timer per Node process). When the gap between
 * heartbeats exceeds `HEARTBEAT_INTERVAL_MS + LONG_TASK_THRESHOLD_MS`,
 * appends a `source: 'server-heartbeat'` entry to freeze.log (or `server-wake`
 * for a suspend-sized gap — see `handleHeartbeatGap`).
 *
 * Uses `process.hrtime.bigint()` for monotonic high-resolution timing —
 * `Date.now()` would jitter on NTP slew, and `performance.now()` isn't
 * always available in older Node versions (it is in Node 16+ but the
 * bigint path is unambiguous and faster).
 */
export function startServerEventLoopHeartbeat(dataDir: string): void {
  if (heartbeatTimer !== null) return;
  startMemorySampler(dataDir);
  heartbeatDataDir = dataDir;
  lastHeartbeatNs = process.hrtime.bigint();
  lastHeartbeatWallMs = Date.now();
  heartbeatTimer = setInterval(() => {
    const now = process.hrtime.bigint();
    const nowWall = Date.now();
    const elapsedMs = Number(now - lastHeartbeatNs) / 1_000_000;
    // HS-9520 — the WALL gap is sampled alongside the monotonic one purely to
    // classify: only a real OS freeze makes the two diverge (`isSuspendGap`).
    // The monotonic gap remains the reported lag, since it is the accurate one.
    const elapsedWallMs = nowWall - lastHeartbeatWallMs;
    lastHeartbeatNs = now;
    lastHeartbeatWallMs = nowWall;
    handleHeartbeatGap(elapsedMs - HEARTBEAT_INTERVAL_MS, elapsedWallMs - HEARTBEAT_INTERVAL_MS);
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
  stopMemorySampler();
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
/** HS-9528 — CPU ms elapsed since a `process.cpuUsage()` mark. */
function cpuSince(start: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(start);
  return Math.round((d.user + d.system) / 1000);
}

export function instrumentSync<T>(dataDir: string, label: string, fn: () => T): T {
  const startNs = process.hrtime.bigint();
  const startCpu = process.cpuUsage();
  // HS-9519 — publish the label into shared memory so a WEDGED main thread can still
  // be named by the watchdog worker. Sync only: these are the calls that actually pin
  // the loop, and an async label would just record whatever happened to start last.
  enterOperation(label);
  try {
    return fn();
  } finally {
    exitOperation();
    const durMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    const cpuMs = cpuSince(startCpu);
    if (durMs >= LONG_TASK_THRESHOLD_MS) {
      void appendFreezeLog(dataDir, {
        ts: new Date().toISOString(),
        source: 'server-instrument-sync',
        durationMs: Math.round(durMs),
        context: label,
        blocking: true, // a synchronous block holds the loop for its whole duration
        cpuMs,
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
  const startCpu = process.cpuUsage();
  try {
    return await fn();
  } finally {
    const durMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    const cpuMs = cpuSince(startCpu);
    if (durMs >= LONG_TASK_THRESHOLD_MS) {
      void appendFreezeLog(dataDir, {
        ts: new Date().toISOString(),
        source: 'server-instrument-async',
        durationMs: Math.round(durMs),
        context: label,
        // WALL time, not blocked time — the loop runs freely during any `await`
        // inside `fn`. Summing these as blocking is the HS-9521 error.
        blocking: false,
        cpuMs,
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
  wakeListeners.clear();
  appendQueue.clear();
  // HS-9421 — the memory sampler is a second timer; a suite that started the
  // heartbeat would otherwise leak it into the next test.
  stopMemorySampler();
  openClusterCounter = null;
}
