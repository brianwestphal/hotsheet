import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

interface InstanceInfo {
  port: number;
  pid: number;
}

function getInstanceFilePath(): string {
  return join(homedir(), '.hotsheet', 'instance.json');
}

export function writeInstanceFile(port: number): void {
  const dir = join(homedir(), '.hotsheet');
  mkdirSync(dir, { recursive: true });
  writeFileSync(getInstanceFilePath(), JSON.stringify({ port, pid: process.pid }));
}

export function readInstanceFile(): InstanceInfo | null {
  const path = getInstanceFilePath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as InstanceInfo;
    if (typeof data.port !== 'number' || typeof data.pid !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}

export function removeInstanceFile(): void {
  const path = getInstanceFilePath();
  if (!existsSync(path)) return;
  try {
    // Only remove if the PID matches the current process
    const data = readInstanceFile();
    if (data !== null && data.pid === process.pid) {
      rmSync(path, { force: true });
    }
  } catch { /* shutting down */ }
}

export async function isInstanceRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${port}/api/projects`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Check if a PID is still alive. */
function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Clean up a stale instance: if the instance file's PID is dead but the port
 * still responds (orphaned server), try to shut it down gracefully.
 * Returns true if the stale instance was cleaned up (caller should proceed to start).
 */
export async function cleanupStaleInstance(): Promise<boolean> {
  const instance = readInstanceFile();
  if (!instance) return false;

  const pidAlive = isPidAlive(instance.pid);
  const portActive = await isInstanceRunning(instance.port);

  if (pidAlive && portActive) {
    return false; // Legitimate running instance
  }

  if (!pidAlive && portActive) {
    // PID is dead but port responds — orphaned server. Try graceful shutdown.
    console.log(`  Stale Hot Sheet server detected on port ${instance.port} (PID ${instance.pid} is dead). Shutting it down...`);
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      await fetch(`http://localhost:${instance.port}/api/shutdown`, {
        method: 'POST',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // Wait a moment for the server to actually stop
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      // If shutdown endpoint doesn't exist or fails, the port is occupied by something else
    }
  }

  // Remove stale instance file
  try { const { rmSync } = await import('fs'); rmSync(getInstanceFilePath(), { force: true }); } catch { /* ignore */ }
  return true;
}
