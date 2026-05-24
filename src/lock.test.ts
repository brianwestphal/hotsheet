import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireLock, classifyExistingLock, getProcessStartTime } from './lock.js';

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

  // HS-8596 — a hard crash (SIGKILL) leaves the lock behind with the dead
  // PID; if the OS recycles that PID for an unrelated live process, the
  // relaunch must NOT be fooled into thinking an instance is still running.
  it('treats a recycled live PID (start-time mismatch) as stale and re-acquires', () => {
    // Only meaningful where `ps` can read a real start time (macOS / Linux).
    const parentStart = getProcessStartTime(process.ppid);
    if (parentStart === null) return; // no `ps` (e.g. Windows) — covered by classifyExistingLock units

    tempDir = createTempDir();
    const lockPath = join(tempDir, 'hotsheet.lock');
    // The parent PID is genuinely alive, but the recorded start time is bogus
    // (simulating the original crashed instance, whose PID the parent now
    // happens to occupy). The live start time won't match → stale.
    writeFileSync(lockPath, JSON.stringify({
      pid: process.ppid,
      startedAt: new Date().toISOString(),
      pidStartTime: 'Thu Jan  1 00:00:00 1970',
    }));

    acquireLock(tempDir);

    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid); // re-acquired by us, not blocked
  });

  it('writes pidStartTime into the lock when ps is available', () => {
    tempDir = createTempDir();
    acquireLock(tempDir);
    const contents = JSON.parse(readFileSync(join(tempDir, 'hotsheet.lock'), 'utf-8')) as { pidStartTime?: string };
    // On macOS / Linux `ps` resolves; on a platform without it the key is
    // omitted (and the check degrades to the conservative PID-alive test).
    if (getProcessStartTime(process.pid) !== null) {
      expect(typeof contents.pidStartTime).toBe('string');
      expect(contents.pidStartTime).not.toBe('');
    }
  });
});

describe('getProcessStartTime (HS-8596)', () => {
  it('is stable across calls, and a real timestamp when ps is reachable', () => {
    const a = getProcessStartTime(process.pid);
    // Stable across calls — a process's start time never changes. Holds
    // whether `ps` resolves (same string) or is unavailable (null both times,
    // e.g. a restricted sandbox or Windows → conservative fallback).
    expect(getProcessStartTime(process.pid)).toBe(a);
    if (a !== null) expect(a).not.toBe(''); // when ps works, it's a real value
  });

  it('returns null for a PID that does not exist (when ps is reachable)', () => {
    // A dead PID yields null; an unreachable `ps` also yields null — either
    // way the contract ("no resolvable live start time") is null.
    expect(getProcessStartTime(999999999)).toBeNull();
  });
});

describe('classifyExistingLock (HS-8596)', () => {
  const aliveMatch = {
    isPidAlive: () => true,
    processStartTime: () => 'Mon May 24 12:00:00 2026',
  };

  it('returns reacquire-self when the lock PID is our own', () => {
    expect(classifyExistingLock({ pid: 4242 }, 4242, aliveMatch)).toBe('reacquire-self');
  });

  it('returns stale when the lock PID is dead', () => {
    const probes = { isPidAlive: () => false, processStartTime: () => null };
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'x' }, 1, probes)).toBe('stale');
  });

  it('returns stale when the PID is alive but the start time was recycled (mismatch)', () => {
    const probes = {
      isPidAlive: () => true,
      processStartTime: () => 'Tue May 25 09:00:00 2026', // different process now at that PID
    };
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, probes)).toBe('stale');
  });

  it('returns live when the PID is alive and the start time matches', () => {
    const probes = {
      isPidAlive: () => true,
      processStartTime: () => 'Mon May 24 12:00:00 2026',
    };
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, probes)).toBe('live');
  });

  it('conservatively returns live for an old lock with no recorded start time', () => {
    const probes = { isPidAlive: () => true, processStartTime: () => 'Mon May 24 12:00:00 2026' };
    expect(classifyExistingLock({ pid: 100 }, 1, probes)).toBe('live');
  });

  it('conservatively returns live when the live start time is unavailable (no ps)', () => {
    const probes = { isPidAlive: () => true, processStartTime: () => null };
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, probes)).toBe('live');
  });

  it('treats an empty recorded start time as no-info (conservative live)', () => {
    const probes = { isPidAlive: () => true, processStartTime: () => 'Mon May 24 12:00:00 2026' };
    expect(classifyExistingLock({ pid: 100, pidStartTime: '' }, 1, probes)).toBe('live');
  });
});
