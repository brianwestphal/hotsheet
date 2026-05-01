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
  shutdownPromise = runShutdownPipeline(reason);
  return shutdownPromise;
}

/** Test-only — clears the cached promise + http-server registration so each
 *  test starts from a clean slate. Production callers must never need this. */
export function _resetLifecycleForTests(): void {
  shutdownPromise = null;
  httpServer = null;
}

/** Test-only — true once `gracefulShutdown` has been called. */
export function _shutdownStarted(): boolean {
  return shutdownPromise !== null;
}

async function runShutdownPipeline(reason: ShutdownReason): Promise<void> {
  console.log(`[lifecycle] gracefulShutdown(${reason}) — starting`);

  await closeHttpServer();
  await killShellCommands();
  await destroyTerminals();
  await disposeGitWatchers();
  await closeDatabases();
  releaseProjectLocks();
  removeLockfile();

  console.log(`[lifecycle] gracefulShutdown(${reason}) — done`);
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

async function closeHttpServer(): Promise<void> {
  if (httpServer === null) return;
  await new Promise<void>((resolve) => {
    httpServer!.close((err) => {
      if (err !== undefined) {
        console.error('[lifecycle] http server close error:', err);
      }
      resolve();
    });
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
