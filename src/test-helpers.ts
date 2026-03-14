import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeDb, setDataDir } from './db/connection.js';

export function createTempDir(): string {
  const dir = join(tmpdir(), `hs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export async function setupTestDb(): Promise<string> {
  const tempDir = createTempDir();
  setDataDir(tempDir);
  const { getDb } = await import('./db/connection.js');
  await getDb();
  return tempDir;
}

export async function cleanupTestDb(tempDir: string): Promise<void> {
  await closeDb();
  try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
