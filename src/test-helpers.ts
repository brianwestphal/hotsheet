import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { closeDb, setDataDir } from './db/connection.js';

/**
 * True when the test process is running inside a Hot Sheet-spawned terminal
 * (the PTY sets `HOTSHEET_IN_TERMINAL=1` in `src/terminals/registry/lifecycle.ts`,
 * and `npm`/`vitest`/spawned children all inherit it).
 *
 * Tests that spawn a REAL Hot Sheet server + send signals + run the graceful
 * shutdown pipeline, or that open multiple heavyweight PGLite (WASM) clusters
 * under a tight timeout, are unreliable when run co-resident with a live Hot
 * Sheet: tsx's signal forwarding through a controlling TTY exits 130 instead
 * of running the child's clean-exit handler, and PGLite memory/CPU contention
 * with the running app blows past the timeouts. Such suites gate themselves on
 * `!isInsideHotSheetTerminal()` so a `npm run release:beta` (or plain `npm test`)
 * launched from inside the app skips them cleanly rather than flaking. CI
 * (GitHub Actions) does not set the var, so it still runs the full suite.
 */
export function isInsideHotSheetTerminal(): boolean {
  return process.env.HOTSHEET_IN_TERMINAL === '1';
}

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
