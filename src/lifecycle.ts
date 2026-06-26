/**
 * HS-7931 — graceful shutdown pipeline.
 *
 * Every shutdown path Hot Sheet has today (`/api/shutdown`, SIGINT, SIGTERM,
 * Tauri close) used to end in `process.exit()` without ever calling
 * `db.close()`. PGLite's `postmaster.pid` therefore stayed on disk and HS-7888
 * had to mop it up on every relaunch. This module gives every path the same
 * close pipeline so PGLite gets a chance to checkpoint + remove the pid
 * cleanly.
 *
 * See `docs/45-pglite-robustness.md` §45.3.
 */
import type { Server as HttpServer } from 'http';

import { closeAllDatabases } from './db/connection.js';
import { stopServerEventLoopHeartbeat } from './diagnostics/freezeLogger.js';
import { stopEventLoopWatchdog } from './diagnostics/watchdog.js';
import { removeInstanceFile } from './instance.js';
import { releaseAllLocks } from './lock.js';

/** HS-8093 — was `'http' | 'SIGINT' | 'SIGTERM' | 'test' | string`, but
 *  union-with-`string` collapses to just `string` (lint
 *  `no-redundant-type-constituents`). The literal alternatives were
 *  documentation rather than constraint — `gracefulShutdown(reason)`
 *  accepts any string the caller wants to log. Kept the union as a
 *  comment so the documented vocabulary survives. */
export type ShutdownReason = string;

let httpServer: HttpServer | null = null;
let shutdownPromise: Promise<void> | null = null;

/**
 * Register the running HTTP server so `gracefulShutdown` can stop it before
 * closing the DB. Called once from `startServer` after `tryServe` resolves.
 * No-op if called with `null` (used in tests for cleanup).
 */
export function registerHttpServerForShutdown(server: HttpServer | null): void {
  httpServer = server;
}

/**
 * Run the shutdown pipeline. Idempotent — concurrent callers (e.g.
 * `/api/shutdown` while a SIGINT handler is mid-flight) await the same
 * underlying promise. Caller is responsible for calling `process.exit` after
 * the returned promise resolves.
 *
 * Order matters:
 *   1. Close the HTTP server so a CHECKPOINT (inside `db.close()`) doesn't
 *      race in-flight writes.
 *   2. Destroy PTYs (idempotent if already torn down).
 *   3. Close every cached PGLite instance. The close path runs an internal
 *      CHECKPOINT so the WAL is flushed into the data files; HS-7935's
 *      `fsyncDir` then ensures those writes hit physical disk. Note: PGLite
 *      0.3.16 does NOT remove `postmaster.pid` on close — that file stays
 *      until the next launch's HS-7888 stale-pid mitigation drops it. The
 *      durability win here is the CHECKPOINT, not the pid removal.
 *   4. Remove `~/.hotsheet/instance.json`.
 *
 * Any individual step that throws is logged and the pipeline continues — the
 * remaining steps still need to run, and we'd rather lose one cleanup step
 * than block the user's quit.
 */
export function gracefulShutdown(reason: ShutdownReason): Promise<void> {
  if (shutdownPromise !== null) return shutdownPromise;
  shutdownPromise = runWithOverallDeadline(reason);
  return shutdownPromise;
}

/**
 * HS-8828 — per-step + overall shutdown timeouts.
 *
 * The reported bug: quitting Hot Sheet (run via `npm run tauri:dev`) "never
 * actually quits." Root cause class: the SIGINT/SIGTERM handler (and the
 * `/api/shutdown` route) `await gracefulShutdown()` BEFORE calling
 * `process.exit(0)`. The pipeline tolerated a step that *throws* (each step has
 * its own try/catch), but NOT a step that *hangs* — a cleanup promise that
 * never settles (a PGLite CHECKPOINT that blocks, a PTY destroy waiting on a
 * wedged child, an Announcer generator promise that never resolves) left
 * `gracefulShutdown` pending forever, so `process.exit(0)` was never reached
 * and the Node sidecar lived on. Under `tauri dev` that keeps the whole dev
 * invocation alive → "never quits."
 *
 * Fix: bound every step (`STEP_TIMEOUT_MS`) so one hung step is abandoned and
 * the rest of the pipeline still runs, AND bound the whole pipeline
 * (`OVERALL_TIMEOUT_MS`) so a pathological cascade of slow steps can never
 * exceed a hard ceiling. On timeout we log and resolve — the caller's
 * `process.exit(0)` tears down whatever work is still pending, and the
 * synchronous `process.on('exit')` handler in `cli.ts` is the lockfile-removal
 * safety net for steps the deadline skipped.
 *
 * HS-9028 — the original 3s/step ceiling was too tight for the genuinely heavy
 * steps: closing the HTTP server (draining keep-alive sockets) and the DB work
 * (the snapshot CHECKPOINT + close + fsync), which under real load — and
 * especially with several projects' DBs handled in one step — legitimately need
 * more than 3s and were being cut off ("step closeHttpServer/snapshotDatabases
 * failed after 3000ms"). Now that shutdown has clear per-step feedback (the
 * `[lifecycle:progress]` markers → the Tauri "Shutting Down" overlay), we can
 * afford to wait: the named heavy steps get up to `HEAVY_STEP_TIMEOUT_MS` (90s)
 * each, while the light steps keep the short default. The overall ceiling is
 * raised to comfortably exceed the sum of the heavy budgets so the overall
 * deadline can't pre-empt a heavy step that's legitimately still working (each
 * step still self-limits, so a truly wedged step is abandoned at its own budget
 * and the pipeline advances). The Tauri-side SIGKILL escalation remains the
 * ultimate backstop for a wedge that outlasts even this.
 */
const STEP_TIMEOUT_MS = 3000;
/** Heavy steps (HTTP drain + DB snapshot/close) get a much longer budget — the
 *  two operations the user can actually see take a while on quit (HS-9028). */
const HEAVY_STEP_TIMEOUT_MS = 90_000;
/** Steps granted the heavy budget. Everything else uses `STEP_TIMEOUT_MS`. */
const HEAVY_STEPS = new Set(['closeHttpServer', 'snapshotDatabases', 'closeDatabases']);
/** Comfortably above the sum of the heavy budgets (3 × 90s) + the light steps,
 *  so the overall deadline only ever fires for a genuinely pathological cascade,
 *  never to cut short a heavy step still within its own budget (HS-9028). */
const OVERALL_TIMEOUT_MS = 300_000;

/** Test-only overrides so the timeout contract is unit-testable without
 *  waiting multiple real seconds. Production never sets these. */
let stepTimeoutOverrideMs: number | null = null;
let overallTimeoutOverrideMs: number | null = null;
export function _setShutdownTimeoutsForTests(step: number | null, overall: number | null): void {
  stepTimeoutOverrideMs = step;
  overallTimeoutOverrideMs = overall;
}

/** The timeout budget for a named step (pure — unit-testable). A test override
 *  (`_setShutdownTimeoutsForTests`) wins for every step so the timeout contract
 *  stays testable in milliseconds; otherwise heavy steps get the 90s budget and
 *  the rest the short default. */
export function stepTimeoutFor(label: string): number {
  if (stepTimeoutOverrideMs !== null) return stepTimeoutOverrideMs;
  return HEAVY_STEPS.has(label) ? HEAVY_STEP_TIMEOUT_MS : STEP_TIMEOUT_MS;
}

/** Run a single cleanup step under a timeout. A step that rejects OR hangs is
 *  logged and swallowed so the pipeline always advances to the next step.
 *
 *  HS-8828 — every step logs its start AND its completion time. The reported
 *  hang ("app never quits" under `npm run tauri:dev`) needs a per-step trail so
 *  the next stuck quit names the exact culprit step (a 3000ms "timed out" line,
 *  or a step that takes suspiciously long) rather than just showing the pipeline
 *  going quiet between "starting" and "done". */
async function runStep(label: string, fn: () => Promise<void> | void): Promise<void> {
  const ms = stepTimeoutFor(label);
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // HS-8911 — a stable, machine-parseable progress marker (separate from the
  // human "step … — starting" line below). The Tauri shell reads the sidecar's
  // stdout; on quit it parses these markers and emits a `shutdown-progress`
  // event so the desktop "Shutting Down" overlay can name the current step
  // (e.g. "Saving a snapshot…") instead of leaving the user staring at a
  // beachball. Plain stdout is the only channel that survives `closeHttpServer`
  // (step 1), which kills the HTTP API the webview would otherwise poll.
  console.log(`[lifecycle:progress] ${label}`);
  console.log(`[lifecycle] step "${label}" — starting`);
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${String(ms)}ms`)), ms);
        timer.unref();
      }),
    ]);
    console.log(`[lifecycle] step "${label}" — done in ${String(Date.now() - startedAt)}ms`);
  } catch (err) {
    console.error(`[lifecycle] step "${label}" failed after ${String(Date.now() - startedAt)}ms:`, err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Wrap the whole pipeline in a hard wall-clock ceiling. Resolves (not
 *  rejects) on timeout so every caller's post-shutdown `process.exit(0)` still
 *  fires. */
async function runWithOverallDeadline(reason: ShutdownReason): Promise<void> {
  const ms = overallTimeoutOverrideMs ?? OVERALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runShutdownPipeline(reason),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(`[lifecycle] gracefulShutdown(${reason}) — overall deadline (${String(ms)}ms) hit; forcing resolve so the process can exit`);
          resolve();
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test-only — clears the cached promise + http-server registration so each
 *  test starts from a clean slate. Production callers must never need this. */
export function _resetLifecycleForTests(): void {
  shutdownPromise = null;
  httpServer = null;
  stepTimeoutOverrideMs = null;
  overallTimeoutOverrideMs = null;
}

/** Test-only — true once `gracefulShutdown` has been called. */
export function _shutdownStarted(): boolean {
  return shutdownPromise !== null;
}

async function runShutdownPipeline(reason: ShutdownReason): Promise<void> {
  console.log(`[lifecycle] gracefulShutdown(${reason}) — starting`);

  // FOLLOW-UP-1 — disarm the event-loop watchdog FIRST. The heavy steps below
  // (snapshot CHECKPOINT, DB close + fsync) legitimately block the loop for
  // seconds; without this the watchdog could mistake an intentional slow
  // shutdown for a wedge and SIGKILL mid-write. A shutdown that genuinely wedges
  // is covered by the Tauri-side SIGKILL escalation instead.
  stopEventLoopWatchdog();

  // HS-8828 — every step runs under `runStep`'s per-step timeout so a single
  // hung cleanup can't wedge the whole quit (see `gracefulShutdown` above).
  await runStep('closeHttpServer', closeHttpServer);
  await runStep('killShellCommands', killShellCommands);
  await runStep('destroyTerminals', destroyTerminals);
  await runStep('disposeGitWatchers', disposeGitWatchers);
  await runStep('terminateHashWorker', terminateHashWorkerStep);
  await runStep('snapshotDatabases', snapshotDatabases);
  await runStep('closeDatabases', closeDatabases);
  await runStep('stopFreezeHeartbeat', stopFreezeHeartbeat);
  await runStep('stopTelemetryRetentionTimer', stopTelemetryRetentionTimerStep);
  await runStep('stopLeaseSweepTimer', stopLeaseSweepTimerStep);
  await runStep('stopPoolReconcileTimer', stopPoolReconcileTimerStep);
  await runStep('releaseProjectLocks', releaseProjectLocks);
  await runStep('removeLockfile', removeLockfile);

  console.log(`[lifecycle] gracefulShutdown(${reason}) — done`);
}

/** HS-8054 v3 — stop the server-side event-loop heartbeat so the timer
 *  doesn't outlive the data directory in tests / multi-shutdown paths.
 *  Runs after the heavy work so any blocks ABOVE this in the pipeline
 *  still get logged (a slow `closeDatabases` is exactly the kind of
 *  thing the heartbeat exists to surface). */
function stopFreezeHeartbeat(): void {
  try {
    stopServerEventLoopHeartbeat();
  } catch { /* heartbeat never started — nothing to stop */ }
}

/** HS-8889 — stop the periodic telemetry retention timer so its 24h interval
 *  doesn't outlive the data directory in tests / multi-shutdown paths. The timer
 *  is `unref`'d so it never blocks exit; this is the explicit-cleanup belt to the
 *  unref suspenders. */
async function stopTelemetryRetentionTimerStep(): Promise<void> {
  try {
    const { stopTelemetryRetentionTimer } = await import('./telemetryRetentionTimer.js');
    stopTelemetryRetentionTimer();
  } catch { /* never started — nothing to stop */ }
}

/** HS-8862 — stop the periodic claim-lease sweep timer on shutdown (unref'd, but
 *  explicit cleanup keeps it from outliving the data dir in tests). */
async function stopLeaseSweepTimerStep(): Promise<void> {
  try {
    const { stopLeaseSweepTimer } = await import('./claims/leaseSweepTimer.js');
    stopLeaseSweepTimer();
  } catch { /* never started — nothing to stop */ }
}

/** HS-9110 — stop the periodic worker-pool reconcile timer on shutdown (unref'd,
 *  but explicit cleanup keeps it from outliving the data dir in tests). */
async function stopPoolReconcileTimerStep(): Promise<void> {
  try {
    const { stopPoolReconcileTimer } = await import('./workers/poolReconcileTimer.js');
    stopPoolReconcileTimer();
  } catch { /* never started — nothing to stop */ }
}

/** HS-8040 — kill every shell-command process spawned via custom-command
 *  buttons (`target: 'shell'`). Pre-fix these survived Hot Sheet exit
 *  because the shell-routes module's `runningProcesses` map was never
 *  walked from any shutdown path; a long-running `npm run dev` fired from
 *  a button kept running in the background indefinitely.  Runs after
 *  `closeHttpServer` (so no new shell-exec requests can spawn during the
 *  pipeline) and before `destroyTerminals` (so the children's `'close'`
 *  handlers can still write to the command log + the DB stays open). */
async function killShellCommands(): Promise<void> {
  try {
    const { killAllRunningShellCommands } = await import('./routes/shell.js');
    const { killed } = await killAllRunningShellCommands();
    if (killed > 0) {
      console.log(`[lifecycle] killShellCommands — terminated ${killed} running shell-command process(es)`);
    }
  } catch (err) {
    console.error('[lifecycle] killShellCommands error:', err);
  }
}

/** HS-7954 — close every `fs.watch` handle held by the git status watcher.
 *  fs.watch handles ordinarily clean up on process exit, but properly
 *  disposing them in the graceful pipeline is hygienic + makes the test
 *  envelope happier (otherwise leaked handles can keep the event loop
 *  alive longer than the test expects). */
async function disposeGitWatchers(): Promise<void> {
  try {
    const { disposeAllGitWatchers } = await import('./git/watcher.js');
    disposeAllGitWatchers();
  } catch (err) {
    console.error('[lifecycle] disposeAllGitWatchers error:', err);
  }
}

/** HS-8728 — terminate the attachment-hash worker thread. It's `unref()`-ed so
 *  it never blocks exit, but tearing it down explicitly keeps the shutdown
 *  envelope clean (no lingering worker across a multi-shutdown test run). */
async function terminateHashWorkerStep(): Promise<void> {
  try {
    const { terminateHashWorker } = await import('./hashWorker.js');
    await terminateHashWorker();
  } catch (err) {
    console.error('[lifecycle] terminateHashWorker error:', err);
  }
}

async function closeHttpServer(): Promise<void> {
  if (httpServer === null) return;
  await new Promise<void>((resolve) => {
    // HS-8096: `server.close()` only stops accepting NEW connections — it
    // still waits for every existing connection (including idle keep-alive
    // sockets in the client's connection pool) to drain. A SIGINT-initiated
    // shutdown right after a client request will routinely have an idle
    // keep-alive socket from that request still in the pool, which would
    // otherwise block `close()` until Node's keep-alive timeout. We use
    // `closeIdleConnections()` (Node 18.2+) — NOT `closeAllConnections()` —
    // because the /api/shutdown route depends on the in-flight response
    // socket being able to finish writing the 200 OK reply before the
    // socket goes away.
    httpServer!.close((err) => {
      if (err !== undefined) {
        console.error('[lifecycle] http server close error:', err);
      }
      resolve();
    });
    httpServer!.closeIdleConnections();
  });
  httpServer = null;
}

async function destroyTerminals(): Promise<void> {
  try {
    // Lazy-import so unit tests can run this module without pulling the PTY
    // registry (which depends on `node-pty`, an optional native binding).
    const { destroyAllTerminals } = await import('./terminals/registry.js');
    destroyAllTerminals();
  } catch (err) {
    // Registry may already be torn down or absent (test environment).
    console.error('[lifecycle] destroyAllTerminals error:', err);
  }
}

/** HS-8586 — Snapshot Protection (§73): write a final canonical snapshot for
 *  every dirty project BEFORE the DBs close, so a clean exit loses nothing.
 *  Runs after `destroyTerminals` / `disposeGitWatchers` (no new writes can
 *  arrive) and before `closeDatabases` (the DBs must still be open to dump).
 *  `snapshotAllForShutdown` also clears the per-project snapshot timers so
 *  nothing reopens a DB after `closeAllDatabases`. Lazy-imported so unit
 *  tests of this module don't pull the snapshot module's deps. */
async function snapshotDatabases(): Promise<void> {
  try {
    const { snapshotAllForShutdown } = await import('./db/snapshot.js');
    await snapshotAllForShutdown();
  } catch (err) {
    console.error('[lifecycle] snapshotAllForShutdown error:', err);
  }
}

async function closeDatabases(): Promise<void> {
  try {
    await closeAllDatabases();
  } catch (err) {
    // Surface but don't rethrow — per-instance close errors are already
    // logged by `closeAllDatabases`; the outer catch is the belt-and-braces
    // case where the export itself blew up unexpectedly.
    console.error('[lifecycle] closeAllDatabases error:', err);
  }
}

function removeLockfile(): void {
  try {
    removeInstanceFile();
  } catch (err) {
    console.error('[lifecycle] removeInstanceFile error:', err);
  }
}

/** HS-7934 — release `<dataDir>/hotsheet.lock` files. Was its own SIGINT
 *  handler in `src/lock.ts` until HS-7934 — that handler called
 *  `process.exit(0)` synchronously and beat this pipeline's async
 *  resolution, which both skipped the rest of the pipeline AND
 *  short-circuited the second-signal escalation path. Folded in here so
 *  every shutdown path runs the same ordered cleanup. */
function releaseProjectLocks(): void {
  try {
    releaseAllLocks();
  } catch (err) {
    console.error('[lifecycle] releaseAllLocks error:', err);
  }
}
