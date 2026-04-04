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
