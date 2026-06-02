import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { startupLog } from './startup-log.js';

// HS-8596 — `pidStartTime` disambiguates a recycled PID from the genuine
// instance that wrote the lock (see `classifyExistingLock`). Older locks
// (pre-HS-8596) have no `pidStartTime`; the schema keeps it optional so they
// still parse and fall back to the conservative PID-alive check.
const LockFileSchema = z.object({
  pid: z.number(),
  startedAt: z.string().optional(),
  pidStartTime: z.string().optional(),
});

// Prevent EPIPE crashes when stdout/stderr pipe is closed (e.g., Tauri sidecar)
process.stdout.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });

// Track ALL lock paths so they can all be released on exit
const lockPaths = new Set<string>();
let exitHandlerRegistered = false;

/** HS-7934 — exposed so `gracefulShutdown` (`src/lifecycle.ts`) can release
 *  file locks as part of the unified shutdown pipeline instead of the lock
 *  module installing its own SIGINT/SIGTERM handler that races
 *  gracefulShutdown's process.exit(0) and beats it. The synchronous
 *  `process.on('exit')` registration below stays as the safety net for
 *  paths the async pipeline didn't catch. */
export function releaseAllLocks(): void {
  for (const p of lockPaths) {
    try { rmSync(p, { force: true }); } catch { /* shutting down */ }
  }
  lockPaths.clear();
}

/**
 * HS-8596 — best-effort wall-clock start time of a PID via POSIX `ps`
 * (`lstart` is stable for the life of the process). macOS + Linux both have
 * `ps`; Windows does not, so this returns `null` there and the caller falls
 * back to the conservative PID-alive check. Any failure (no `ps`, PID gone,
 * permission) also yields `null`. The string is opaque — we only ever test it
 * for equality against the value recorded when the lock was written, so a
 * recycled PID (a different process now occupying the same number) reads back
 * a different start time and is correctly treated as stale.
 */
export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

// Cache our own start time — it never changes, and re-shelling `ps` for every
// project's lock acquisition in a multi-project boot is wasteful.
let selfStartTime: string | null | undefined;
function selfPidStartTime(): string | null {
  if (selfStartTime === undefined) selfStartTime = getProcessStartTime(process.pid);
  return selfStartTime;
}

export type LockDisposition = 'reacquire-self' | 'stale' | 'live';

/**
 * HS-8596 — pure decision for an existing lock file. Extracted from
 * `acquireLock` so every branch is unit-testable with injected OS probes
 * (the real `acquireLock` would `process.exit(1)` on the `'live'` branch,
 * which can't be exercised in the forked vitest pool).
 *
 *   - `reacquire-self` — the same process already holds it (re-register).
 *   - `stale` — safe to remove + acquire: either the PID is dead, OR it is
 *     alive but its start time no longer matches the one recorded in the lock
 *     (the PID was recycled by an unrelated process after a hard crash), OR the
 *     caller passed `reclaimUnverified` and we couldn't positively confirm the
 *     PID is the original writer (HS-8706).
 *   - `live` — another Hot Sheet instance genuinely holds it: the live PID's
 *     start time POSITIVELY matches the one recorded in the lock. Without
 *     `reclaimUnverified`, an alive PID we couldn't disambiguate (old lock with
 *     no `pidStartTime`, or no `ps` on this platform) also conservatively counts
 *     as live.
 *
 * HS-8706 — `policy.reclaimUnverified` closes the launch-hang class from
 * HS-8704: when the boot path has ALREADY established (via the authoritative
 * global instance file) that no live, responsive Hot Sheet instance exists, an
 * alive-but-unverifiable PID here is necessarily a recycled PID from a
 * SIGKILL'd instance — `cleanupStaleInstance` removed that instance's global
 * file but left this per-project lock behind. Reclaim it instead of returning
 * `live` (which made `acquireLock` silently `process.exit(1)` and wedged the
 * GUI splash forever). A POSITIVE start-time match is never reclaimed — that
 * one branch proves a genuinely live second writer, so it stays `live`.
 */
export function classifyExistingLock(
  lock: { pid: number; pidStartTime?: string },
  selfPid: number,
  probes: { isPidAlive: (pid: number) => boolean; processStartTime: (pid: number) => string | null },
  policy: { reclaimUnverified?: boolean } = {},
): LockDisposition {
  if (lock.pid === selfPid) return 'reacquire-self';
  if (!probes.isPidAlive(lock.pid)) return 'stale';
  // The recorded PID is alive — but a hard crash (SIGKILL / power loss) skips
  // `releaseAllLocks`, leaving the lock behind, and the OS may have since
  // reassigned that PID to an unrelated process. If the lock recorded the
  // writer's start time AND we can read the live PID's start time, the match
  // settles it definitively: equal → genuinely live; unequal → recycled, stale.
  if (lock.pidStartTime !== undefined && lock.pidStartTime !== '') {
    const liveStart = probes.processStartTime(lock.pid);
    if (liveStart !== null) return liveStart === lock.pidStartTime ? 'live' : 'stale';
    // liveStart === null — `ps` couldn't read it; fall through to unverifiable.
  }
  // Unverifiable: alive, but we couldn't tie the PID to the original writer
  // (pre-HS-8596 lock with no start time, or `ps` returned nothing). The caller
  // that already proved no live instance exists reclaims it (HS-8706); everyone
  // else keeps the conservative `live` so a never-checked path can't corrupt a
  // genuinely-shared DB.
  if (policy.reclaimUnverified === true) return 'stale';
  return 'live';
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = liveness test only, no signal delivered
    return true;
  } catch {
    return false;
  }
}

/** Result of a single lock-acquire attempt that does NOT exit on a live
 *  holder — so callers can decide to fatal-exit immediately (`acquireLock`)
 *  or wait for a shutting-down holder to release it
 *  (`acquireLockWaitingForShutdown`). */
type AcquireOnceResult = { status: 'acquired' } | { status: 'live'; pid: number };

/** Write our own lock file + register the exit-time release handler. */
function writeOwnLock(lockPath: string): void {
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    // HS-8596 — omitted (undefined → dropped by JSON.stringify) when `ps` is
    // unavailable; the check then degrades to the conservative PID-alive test.
    pidStartTime: selfPidStartTime() ?? undefined,
  }));
  lockPaths.add(lockPath);

  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    // HS-7934: synchronous `process.on('exit')` stays as the safety net.
    // SIGINT/SIGTERM handlers were dropped — the HS-7931 graceful-shutdown
    // pipeline in `src/cli.ts` + `src/lifecycle.ts` now handles signals
    // for the whole process and calls `releaseAllLocks` via the lifecycle
    // pipeline. Pre-fix the lock module's own SIGINT handler ran a
    // synchronous `process.exit(0)` that beat the async gracefulShutdown
    // and short-circuited the close pipeline — including the second-
    // signal escalation path.
    process.on('exit', releaseAllLocks);
  }
}

/**
 * One acquire attempt. Acquires (writing our lock) for every disposition except
 * a genuinely-live holder, for which it returns `{ status: 'live', pid }`
 * WITHOUT exiting. Pure of the exit decision so both the sync `acquireLock`
 * (exit-on-live) and the async `acquireLockWaitingForShutdown` (wait-on-live)
 * can build on it.
 */
function tryAcquireLockOnce(dataDir: string, opts: { reclaimUnverified?: boolean }): AcquireOnceResult {
  const lockPath = join(dataDir, 'hotsheet.lock');

  if (existsSync(lockPath)) {
    try {
      const parsed = LockFileSchema.safeParse(JSON.parse(readFileSync(lockPath, 'utf-8')));
      if (!parsed.success) {
        // Corrupt lock file — remove and continue to acquire
        rmSync(lockPath, { force: true });
      } else {
        const disposition = classifyExistingLock(parsed.data, process.pid, {
          isPidAlive,
          processStartTime: getProcessStartTime,
        }, { reclaimUnverified: opts.reclaimUnverified });

        if (disposition === 'reacquire-self') {
          // Same process re-acquiring the lock (e.g., project re-registered after tab close)
          lockPaths.add(lockPath);
          return { status: 'acquired' };
        }

        if (disposition === 'live') {
          return { status: 'live', pid: parsed.data.pid };
        }

        // disposition === 'stale' — dead PID, or a recycled PID whose start
        // time no longer matches what we recorded (HS-8596).
        console.log(`  Removing stale lock from PID ${parsed.data.pid}`);
        rmSync(lockPath, { force: true });
      }
    } catch {
      // JSON parse error — remove corrupt lock file
      rmSync(lockPath, { force: true });
    }
  }

  writeOwnLock(lockPath);
  return { status: 'acquired' };
}

/** HS-8706 — the durable FATAL exit for a genuinely-live lock holder. Pre-fix
 *  this was a bare `console.error` + `process.exit(1)`: on a GUI launch (no
 *  terminal) the message went nowhere AND the exit killed the sidecar before
 *  its server started, so the Tauri splash spun forever with zero record of why
 *  (the HS-8704 trace gapped right here). */
function fatalLockHeld(dataDir: string, pid: number): never {
  startupLog(`[startup] FATAL: data directory ${dataDir} is locked by a live Hot Sheet instance (PID ${pid}); exiting`);
  startupLog('  Stop that instance first, or use --data-dir to point to a different location.');
  process.exit(1);
}

/**
 * Acquire the per-dataDir lock that guards against two PGLite processes opening
 * the same on-disk cluster. Exits the process (FATAL) if a genuinely-live
 * instance holds it.
 *
 * HS-8706 — `opts.reclaimUnverified` is passed by the boot paths
 * (`cli.ts::initializeProject`, `projects.ts::registerProject`) that have
 * already confirmed, via the authoritative global instance file, that no live
 * Hot Sheet instance is running. With it set, an orphaned lock left by a
 * SIGKILL'd instance whose PID the OS recycled is reclaimed instead of being
 * mistaken for a live instance — the false positive that silently exited the
 * sidecar and wedged the GUI splash forever (HS-8704). See `classifyExistingLock`.
 *
 * For the primary launch path use {@link acquireLockWaitingForShutdown}, which
 * tolerates a previous instance still mid-shutdown.
 */
export function acquireLock(dataDir: string, opts: { reclaimUnverified?: boolean } = {}): void {
  const r = tryAcquireLockOnce(dataDir, opts);
  if (r.status === 'live') fatalLockHeld(dataDir, r.pid);
}

/**
 * HS-8706 (third-pass fix for the installed-app launch hang) — acquire the lock
 * but, when it is held by a genuinely-live holder, WAIT for that holder to
 * release it (up to `waitMs`) before giving up.
 *
 * Why this exists: quitting Hot Sheet runs `gracefulShutdown`, whose
 * `snapshotDatabases` (§73 CHECKPOINT + gzip dump) and `closeDatabases` phases
 * can block the event loop for SECONDS, and which only releases the per-project
 * `hotsheet.lock` at the very END (after the DB is fully closed). During that
 * window the process is alive, its HTTP port is wedged (so a relaunch can't
 * JOIN it), and the lock is still held (so a relaunch can't ACQUIRE it) — the
 * old behavior FATAL-exited instantly and the Tauri splash hung. The
 * alternating "every other launch works" the user saw is a relaunch landing
 * inside vs. outside that shutdown window.
 *
 * Waiting is SAFE: the holder only releases the lock AFTER it has closed the DB,
 * so we never open the PGLite cluster concurrently. Each poll re-classifies, so
 * a holder that is SIGKILL'd mid-shutdown (pid dies, lock left behind) is
 * reclaimed as stale on the next iteration rather than waited on. If the holder
 * is genuinely wedged forever, we FATAL after the deadline — no worse than the
 * old instant exit, but only after giving the common case time to resolve.
 */
export async function acquireLockWaitingForShutdown(
  dataDir: string,
  opts: { reclaimUnverified?: boolean } = {},
  waitMs = 15_000,
  pollMs = 250,
): Promise<void> {
  const deadline = Date.now() + waitMs;
  let announced = false;
  for (;;) {
    const r = tryAcquireLockOnce(dataDir, opts);
    if (r.status === 'acquired') {
      if (announced) startupLog('  Previous (shutting-down) instance released the lock — acquired.');
      return;
    }
    if (Date.now() >= deadline) fatalLockHeld(dataDir, r.pid);
    if (!announced) {
      announced = true;
      startupLog(`  Data directory ${dataDir} is locked by PID ${r.pid} but it is not serving — likely a previous instance shutting down. Waiting up to ${Math.round(waitMs / 1000)}s for it to release the lock...`);
    }
    await new Promise(res => setTimeout(res, pollMs));
  }
}
