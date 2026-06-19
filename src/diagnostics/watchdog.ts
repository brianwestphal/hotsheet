/**
 * Load resilience (FOLLOW-UP-1) — thread-based event-loop watchdog.
 *
 * Detects a sustained main-thread block (the startup-wedge class — an unbounded
 * loop or a runaway synchronous task, e.g. the HS-8874 row-by-row telemetry
 * migration) and force-exits the process so it can't hold the HTTP port + every
 * project lock forever. A wedged server ignores SIGTERM (its handler runs ON the
 * blocked loop), so the next launch sees a live lock and FATAL-exits — a
 * permanent lockout. This converts that hang into a clean crash: the lock layer
 * reclaims the dead PID's lock as stale (`lock.ts`) and Tauri / a relaunch
 * recovers.
 *
 * Why a worker thread: the existing `freezeLogger` heartbeat is a main-loop
 * `setInterval`, so it can only LOG a block after the loop frees up — it can't
 * fire (let alone act) WHILE the loop is wedged, which is exactly when we need
 * to. This watchdog's checker runs on its own OS thread, so it keeps ticking
 * even when the main thread is pinned; it watches a `SharedArrayBuffer`
 * heartbeat the main thread bumps each tick and SIGKILLs the shared process
 * (worker threads share the PID) once that heartbeat goes stale past the
 * timeout.
 *
 * Suspend/resume guard: a laptop sleep / `kill -STOP` freezes EVERY thread, so
 * on resume the heartbeat looks stale — but the checker's OWN inter-tick gap is
 * also huge. We treat a large self-gap as a wake (skip), never a wedge, so the
 * watchdog can't false-fire on resume (mirrors `freezeLogger`'s
 * `WAKE_GAP_THRESHOLD_MS`). See `watchdogVerdict`.
 *
 * Everything is best-effort and `unref`'d: the watchdog never keeps an otherwise
 * idle process alive, and any spawn failure silently disables it rather than
 * breaking startup. Disable entirely with `HOTSHEET_DISABLE_WATCHDOG=1`; tune
 * the timeout with `HOTSHEET_WATCHDOG_TIMEOUT_MS`.
 */
import { Worker } from 'worker_threads';

/** Main thread bumps the shared heartbeat this often. 1 s granularity is ample
 *  against a multi-second timeout and is trivial overhead. */
const HEARTBEAT_MS = 1000;
/** The checker re-evaluates staleness this often (on its own, unblocked loop). */
const CHECK_MS = 2000;
/** Default: a main-thread block longer than this is treated as an unrecoverable
 *  wedge. Conservative so legitimate heavy synchronous work (a large PGLite
 *  query / snapshot) never trips it — a true wedge blocks forever, so a longer
 *  timeout only delays recovery, while a shorter one risks a false kill. */
const DEFAULT_TIMEOUT_MS = 60_000;
/** A checker self-gap at or above this means the whole process was suspended
 *  (sleep / STOP), not the main thread wedged. Matches
 *  `freezeLogger.WAKE_GAP_THRESHOLD_MS`. */
const WAKE_GAP_MS = 10_000;

export type WatchdogVerdict = 'kill' | 'suspend-skip' | 'armed-ok' | 'not-armed';

/**
 * Pure decision for one checker tick — exported so the policy is unit-testable
 * without spawning a worker or killing the test process. The worker replicates
 * this exact precedence inline (it runs from an eval string and can't import).
 *
 * Precedence matters: the suspend guard comes FIRST, so a resume (where the
 * heartbeat is stale only because every thread was frozen) is never mistaken
 * for a wedge.
 */
export function watchdogVerdict(args: {
  ownGapMs: number;
  heartbeatAgeMs: number;
  timeoutMs: number;
  wakeGapMs: number;
  armed: boolean;
}): WatchdogVerdict {
  if (args.ownGapMs >= args.wakeGapMs) return 'suspend-skip';
  if (!args.armed) return 'not-armed';
  if (args.heartbeatAgeMs > args.timeoutMs) return 'kill';
  return 'armed-ok';
}

// Worker source. Plain CommonJS-style JS (eval workers expose `require`); uses
// only Node built-ins. Mirrors `watchdogVerdict`'s precedence exactly — keep the
// two in sync.
const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const fs = require('fs');
const view = new BigInt64Array(workerData.sab);
const { pid, timeoutMs, checkMs, wakeGapMs, logPath } = workerData;
let lastCheck = Date.now();
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg + '\\n';
  try { process.stderr.write(line); } catch (e) {}
  if (logPath) { try { fs.appendFileSync(logPath, line); } catch (e) {} }
}
const timer = setInterval(function () {
  const now = Date.now();
  const ownGap = now - lastCheck;
  lastCheck = now;
  // Suspend guard first: if the checker itself was frozen, this is a wake.
  if (ownGap >= wakeGapMs) return;
  const last = Number(Atomics.load(view, 0));
  if (last === 0) return; // not armed yet
  const age = now - last;
  if (age > timeoutMs) {
    log('[watchdog] FATAL: event loop blocked for ' + Math.round(age) + 'ms (> ' + timeoutMs +
        'ms); the main thread is wedged and holding the port + project locks. Forcing SIGKILL so the ' +
        'next launch can recover. The last "[+Nms] <phase>" marker above is where startup stalled.');
    try { process.kill(pid, 'SIGKILL'); } catch (e) { try { process.exit(137); } catch (e2) {} }
  }
}, checkMs);
// NOTE: deliberately NOT unref'd. This interval is the only handle keeping the
// worker's own event loop alive; unref'ing it would let the worker thread exit
// immediately and stop watching. The main thread's \`worker.unref()\` is what
// keeps the watchdog from blocking process exit — that's separate from this.
void timer;
`;

export interface WatchdogOptions {
  /** Block-duration threshold (ms) before SIGKILL. Falls back to
   *  `HOTSHEET_WATCHDOG_TIMEOUT_MS`, then `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** File the worker appends its FATAL line to before killing (the main thread
   *  can't log — it's wedged). Typically the startup log path. */
  logPath?: string;
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let worker: Worker | null = null;
let view: BigInt64Array | null = null;

/**
 * Start the watchdog. Idempotent (a second call is a no-op). Call once at the
 * very top of `main()` so it covers the entire startup, the most wedge-prone
 * window. No-op when `HOTSHEET_DISABLE_WATCHDOG=1`.
 */
export function startEventLoopWatchdog(opts: WatchdogOptions = {}): void {
  if (process.env.HOTSHEET_DISABLE_WATCHDOG === '1') return;
  if (worker !== null) return;

  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const sab = new SharedArrayBuffer(8);
  const v = new BigInt64Array(sab);
  // Arm with the start time so an IMMEDIATE wedge (the main thread never reaches
  // its first heartbeat tick) is still caught after `timeoutMs`.
  Atomics.store(v, 0, BigInt(Date.now()));

  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { sab, pid: process.pid, timeoutMs, checkMs: CHECK_MS, wakeGapMs: WAKE_GAP_MS, logPath: opts.logPath ?? null },
    });
    // Don't keep the process alive for the watchdog alone, and never let a
    // watchdog-worker crash take down the process it's meant to protect.
    worker.unref();
    worker.on('error', () => { /* diagnostics-only; the heartbeat just goes unwatched */ });
  } catch {
    worker = null;
    return;
  }

  view = v;
  // Main-thread heartbeat. Can't fire while the loop is blocked — which is
  // exactly the staleness the worker keys off.
  heartbeatTimer = setInterval(() => {
    if (view !== null) Atomics.store(view, 0, BigInt(Date.now()));
  }, HEARTBEAT_MS);
  heartbeatTimer.unref();
}

/**
 * Stop the watchdog. Called at the START of `gracefulShutdown` so a legitimate
 * slow shutdown (snapshot CHECKPOINT / DB close can block the loop for seconds)
 * can't be mistaken for a wedge and SIGKILL'd mid-write — the Tauri-side
 * SIGKILL escalation already covers a shutdown that genuinely wedges. Idempotent.
 */
export function stopEventLoopWatchdog(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (worker !== null) {
    const w = worker;
    worker = null;
    void w.terminate().catch(() => { /* already gone */ });
  }
  view = null;
}

function resolveTimeoutMs(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const env = process.env.HOTSHEET_WATCHDOG_TIMEOUT_MS;
  if (typeof env === 'string' && env !== '') {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_TIMEOUT_MS;
}
