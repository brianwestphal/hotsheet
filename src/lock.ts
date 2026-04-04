import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

let lockPath: string | null = null;

export function acquireLock(dataDir: string): void {
  lockPath = join(dataDir, 'hotsheet.lock');

  if (existsSync(lockPath)) {
    try {
      const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
      const pid = contents.pid;

      // Same process re-acquiring the lock (e.g., project re-registered after tab close)
      if (pid === process.pid) {
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

  const cleanup = () => releaseLock();
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

function releaseLock(): void {
  if (lockPath !== null) {
    try { rmSync(lockPath, { force: true }); } catch { /* shutting down */ }
    lockPath = null;
  }
}
