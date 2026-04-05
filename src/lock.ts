import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// Prevent EPIPE crashes when stdout/stderr pipe is closed (e.g., Tauri sidecar)
process.stdout?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on?.('error', (err: NodeJS.ErrnoException) => { if (err.code !== 'EPIPE') throw err; });

// Track ALL lock paths so they can all be released on exit
const lockPaths = new Set<string>();
let exitHandlerRegistered = false;

function releaseAllLocks(): void {
  for (const p of lockPaths) {
    try { rmSync(p, { force: true }); } catch { /* shutting down */ }
  }
  lockPaths.clear();
}

export function acquireLock(dataDir: string): void {
  const lockPath = join(dataDir, 'hotsheet.lock');

  if (existsSync(lockPath)) {
    try {
      const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
      const pid = contents.pid;

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
    } catch {
      // Corrupt lock file — remove it
      rmSync(lockPath, { force: true });
    }
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  lockPaths.add(lockPath);

  if (!exitHandlerRegistered) {
    exitHandlerRegistered = true;
    process.on('exit', releaseAllLocks);
    process.on('SIGINT', () => { releaseAllLocks(); process.exit(0); });
    process.on('SIGTERM', () => { releaseAllLocks(); process.exit(0); });
  }
}
