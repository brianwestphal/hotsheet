import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { globalHotsheetDir } from './global-dir.js';

const InstanceInfoSchema = z.object({
  port: z.number(),
  pid: z.number(),
});

type InstanceInfo = z.infer<typeof InstanceInfoSchema>;

function getInstanceFilePath(): string {
  return join(globalHotsheetDir(), 'instance.json');
}

export function writeInstanceFile(port: number): void {
  const dir = globalHotsheetDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getInstanceFilePath(), JSON.stringify({ port, pid: process.pid }));
}

export function readInstanceFile(): InstanceInfo | null {
  const path = getInstanceFilePath();
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = InstanceInfoSchema.safeParse(raw);
    return result.success ? result.data : null;
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
 *
 * HS-8706 — this function must NEVER delete the instance file of a process that
 * is still alive. The owning process removes its own file on exit (gated on a
 * PID match in `removeInstanceFile`); a *different* process clobbering a live
 * owner's file is the root cause of the installed-app launch hang. See the
 * `pidAlive && !portActive` branch below.
 */
export async function cleanupStaleInstance(): Promise<boolean> {
  const instance = readInstanceFile();
  if (!instance) return false;

  const pidAlive = isPidAlive(instance.pid);
  const portActive = await isInstanceRunning(instance.port);

  if (pidAlive && portActive) {
    return false; // Legitimate running instance
  }

  if (pidAlive && !portActive) {
    // HS-8706 — the process that wrote this instance file is STILL ALIVE but
    // its HTTP port isn't answering right now. This is NOT a stale instance:
    // it's a live Hot Sheet that is mid-startup, transiently busy (event loop
    // blocked past the 2s `isInstanceRunning` timeout), or momentarily refusing
    // connections during a `--replace` handoff (server already closed, process
    // still draining and still holding its per-project `hotsheet.lock`).
    //
    // Deleting its instance file here is catastrophic: the caller
    // (`handleExistingInstance`) then reads `null`, concludes no instance is
    // running, and starts its own server for the same restored project. That
    // fresh boot collides on the `hotsheet.lock` the live process still holds →
    // `acquireLock` → `process.exit(1)` → the sidecar dies before navigating →
    // eternal "Starting Hot Sheet…" splash on a GUI launch (the HS-8704 hang).
    //
    // Leave the file untouched and report "not cleaned up" so the caller treats
    // it as a live instance to defer to. The live owner is solely responsible
    // for its own instance file.
    return false;
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

  // Both the PID and the port are dead — a truly stale instance file. Remove it.
  try { const { rmSync } = await import('fs'); rmSync(getInstanceFilePath(), { force: true }); } catch { /* ignore */ }
  return true;
}
