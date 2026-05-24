import { execFileSync } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

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
 *     (the PID was recycled by an unrelated process after a hard crash).
 *   - `live` — another Hot Sheet instance genuinely holds it (start times
 *     match), OR we couldn't disambiguate (old lock without `pidStartTime`,
 *     or no `ps` on this platform) and so conservatively assume it's live.
 */
export function classifyExistingLock(
  lock: { pid: number; pidStartTime?: string },
  selfPid: number,
  probes: { isPidAlive: (pid: number) => boolean; processStartTime: (pid: number) => string | null },
): LockDisposition {
  if (lock.pid === selfPid) return 'reacquire-self';
  if (!probes.isPidAlive(lock.pid)) return 'stale';
  // The recorded PID is alive — but a hard crash (SIGKILL / power loss) skips
  // `releaseAllLocks`, leaving the lock behind, and the OS may have since
  // reassigned that PID to an unrelated process. If the lock recorded the
  // writer's start time AND we can read the live PID's start time, a mismatch
  // proves the PID was recycled, so the original instance is gone → stale.
  if (lock.pidStartTime !== undefined && lock.pidStartTime !== '') {
    const liveStart = probes.processStartTime(lock.pid);
    if (liveStart !== null && liveStart !== lock.pidStartTime) return 'stale';
  }
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

export function acquireLock(dataDir: string): void {
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
        });

        if (disposition === 'reacquire-self') {
          // Same process re-acquiring the lock (e.g., project re-registered after tab close)
          lockPaths.add(lockPath);
          return;
        }

        if (disposition === 'live') {
          console.error(`\n  Error: Another Hot Sheet instance (PID ${parsed.data.pid}) is already using this data directory.`);
          console.error(`  Directory: ${dataDir}`);
          console.error(`  Stop that instance first, or use --data-dir to point to a different location.\n`);
          process.exit(1);
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
