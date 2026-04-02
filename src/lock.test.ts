import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireLock } from './lock.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `hs-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('acquireLock', () => {
  let tempDir: string;

  afterEach(() => {
    // Clean up lock file if present
    if (tempDir) {
      const lockPath = join(tempDir, 'hotsheet.lock');
      try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('creates a lock file with pid and startedAt', () => {
    tempDir = createTempDir();
    acquireLock(tempDir);

    const lockPath = join(tempDir, 'hotsheet.lock');
    expect(existsSync(lockPath)).toBe(true);

    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number; startedAt: string };
    expect(contents.pid).toBe(process.pid);
    expect(contents.startedAt).toBeDefined();
    // startedAt should be a valid ISO string
    expect(new Date(contents.startedAt).toISOString()).toBe(contents.startedAt);
  });

  it('removes a stale lock from a dead process', () => {
    tempDir = createTempDir();
    const lockPath = join(tempDir, 'hotsheet.lock');

    // Write a lock file with a PID that doesn't exist (use a very high PID)
    const stalePid = 999999999;
    writeFileSync(lockPath, JSON.stringify({ pid: stalePid, startedAt: new Date().toISOString() }));

    // acquireLock should detect the stale lock, remove it, and create a new one
    acquireLock(tempDir);

    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid);
  });

  it('removes a corrupt lock file and creates a new one', () => {
    tempDir = createTempDir();
    const lockPath = join(tempDir, 'hotsheet.lock');

    // Write garbage to the lock file
    writeFileSync(lockPath, 'not valid json{{{');

    acquireLock(tempDir);

    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid);
  });

  // Note: "exits when active process holds lock" is not tested here because
  // process.exit() is called synchronously before the mock can intercept it
  // in the forked vitest pool. This behavior is covered by integration testing.

  it('creates the lock file in the correct directory', () => {
    tempDir = createTempDir();
    acquireLock(tempDir);

    const lockPath = join(tempDir, 'hotsheet.lock');
    expect(existsSync(lockPath)).toBe(true);

    // Verify it's specifically in the data dir, not somewhere else
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(typeof contents.pid).toBe('number');
  });
});
