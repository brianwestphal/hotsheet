import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const LockFileSchema = z.object({ pid: z.number() });

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

export function acquireLock(dataDir: string): void {
  const lockPath = join(dataDir, 'hotsheet.lock');

  if (existsSync(lockPath)) {
    try {
      const parsed = LockFileSchema.safeParse(JSON.parse(readFileSync(lockPath, 'utf-8')));
      if (!parsed.success) {
        // Corrupt lock file — remove and continue to acquire
        rmSync(lockPath, { force: true });
      } else {
        const pid = parsed.data.pid;

        // Same process re-acquiring the lock (e.g., project re-registered after tab close)
        if (pid === process.pid) {
          lockPaths.add(lockPath);
          return;
        }

        // Check if the process is still alive (signal 0 = test only)
        try {
          process.kill(pid, 0);
          // Process is alive — another instance is running
          console.error(`\n  Error: Another Hot Sheet instance (PID ${pid}) is already using this data directory.`);
          console.error(`  Directory: ${dataDir}`);
          console.error(`  Stop that instance first, or use --data-dir to point to a different location.\n`);
          process.exit(1);
        } catch {
          // Process is dead — stale lock
          console.log(`  Removing stale lock from PID ${pid}`);
          rmSync(lockPath, { force: true });
        }
      }
    } catch {
      // JSON parse error — remove corrupt lock file
      rmSync(lockPath, { force: true });
    }
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
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
