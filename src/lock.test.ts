import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { acquireLock, acquireLockWaitingForShutdown, classifyExistingLock, getProcessStartTime } from './lock.js';

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

  // HS-8706 — the launch-hang fix. A lock left by a SIGKILL'd instance whose
  // PID the OS recycled (and which is NOW a live, unrelated process) must be
  // reclaimed when the boot path passes `reclaimUnverified`, NOT mistaken for a
  // live instance (which silently `process.exit(1)`-ed the sidecar and wedged
  // the GUI splash). Uses an old-format lock (no pidStartTime) over our own
  // genuinely-alive parent PID — the exact unverifiable shape that hung HS-8704.
  it('reclaims an orphaned old-format lock over a live (recycled) PID when reclaimUnverified is set', () => {
    tempDir = createTempDir();
    const lockPath = join(tempDir, 'hotsheet.lock');
    // process.ppid is genuinely alive; the lock has NO recorded start time
    // (pre-HS-8596 format) so the PID can't be tied to the original writer.
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() }));

    acquireLock(tempDir, { reclaimUnverified: true });

    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid); // reclaimed by us, did NOT exit
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

// HS-8706 (fourth pass) — `acquireLockWaitingForShutdown` waits for a previous
// instance that is mid-shutdown to release the lock instead of FATAL-exiting
// instantly. Quitting Hot Sheet holds `hotsheet.lock` through its multi-second
// snapshot + DB-close phases and only releases it at the very end; a relaunch
// landing in that window used to die and hang the splash (the "every other
// launch fails" alternation).
describe('acquireLockWaitingForShutdown (HS-8706)', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(join(tempDir, 'hotsheet.lock'), { force: true }); } catch { /* ignore */ }
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('acquires immediately when no lock exists', async () => {
    tempDir = createTempDir();
    await acquireLockWaitingForShutdown(tempDir);
    const contents = JSON.parse(readFileSync(join(tempDir, 'hotsheet.lock'), 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid);
  });

  it('reclaims a dead-PID lock immediately (no waiting)', async () => {
    tempDir = createTempDir();
    const lockPath = join(tempDir, 'hotsheet.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
    const start = Date.now();
    await acquireLockWaitingForShutdown(tempDir);
    // Dead PID → 'stale' → acquired on the first attempt, no poll delay.
    expect(Date.now() - start).toBeLessThan(200);
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid);
  });

  it('WAITS for a genuinely-live holder, then acquires once the lock is released mid-wait', async () => {
    // Needs a real alive PID with a readable start time so the lock classifies
    // as 'live' (positive start-time match) rather than stale. The parent PID
    // fits; skip where `ps` is unavailable (covered by the source contract).
    const parentStart = getProcessStartTime(process.ppid);
    if (parentStart === null) return;

    tempDir = createTempDir();
    const lockPath = join(tempDir, 'hotsheet.lock');
    // A genuinely-live holder (our parent) with a MATCHING start time → 'live'.
    writeFileSync(lockPath, JSON.stringify({
      pid: process.ppid,
      startedAt: new Date().toISOString(),
      pidStartTime: parentStart,
    }));

    // Simulate the holder finishing its shutdown and releasing the lock after a
    // short delay — the exact moment `gracefulShutdown`'s `releaseAllLocks` runs.
    const releaseTimer = setTimeout(() => {
      try { rmSync(lockPath, { force: true }); } catch { /* ignore */ }
    }, 150);

    const start = Date.now();
    await acquireLockWaitingForShutdown(tempDir, {}, 5000, 25);
    clearTimeout(releaseTimer);

    // It must have WAITED for the release (not exited, not acquired instantly).
    expect(Date.now() - start).toBeGreaterThanOrEqual(120);
    const contents = JSON.parse(readFileSync(lockPath, 'utf-8')) as { pid: number };
    expect(contents.pid).toBe(process.pid); // acquired by us after the holder released
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

// HS-8706 — `reclaimUnverified` policy: the boot path proved no live instance
// exists (global instance file absent/unresponsive), so an alive-but-
// unverifiable PID is a recycled PID, not a second Hot Sheet. This is the
// classification that, when it wrongly returned 'live', wedged the GUI splash.
describe('classifyExistingLock reclaimUnverified policy (HS-8706)', () => {
  const aliveNoStartTime = { isPidAlive: () => true, processStartTime: () => null };
  const aliveWithStartTime = { isPidAlive: () => true, processStartTime: () => 'Mon May 24 12:00:00 2026' };

  it('reclaims (stale) an old-format lock with no recorded start time', () => {
    // Pre-fix this returned 'live' → process.exit(1) → splash hang.
    expect(classifyExistingLock({ pid: 100 }, 1, aliveWithStartTime, { reclaimUnverified: true })).toBe('stale');
  });

  it('reclaims (stale) when the live start time is unreadable (no ps)', () => {
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, aliveNoStartTime, { reclaimUnverified: true })).toBe('stale');
  });

  it('still returns live for a POSITIVE start-time match even with reclaimUnverified', () => {
    // A definitive match proves a genuinely live second writer — never reclaim
    // it, even on the boot path, so a real concurrent open still aborts safely.
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, aliveWithStartTime, { reclaimUnverified: true })).toBe('live');
  });

  it('still returns stale for a start-time MISMATCH (recycled PID)', () => {
    const probes = { isPidAlive: () => true, processStartTime: () => 'Tue May 25 09:00:00 2026' };
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, probes, { reclaimUnverified: true })).toBe('stale');
  });

  it('still returns reacquire-self / stale-dead regardless of the policy', () => {
    expect(classifyExistingLock({ pid: 42 }, 42, aliveWithStartTime, { reclaimUnverified: true })).toBe('reacquire-self');
    const dead = { isPidAlive: () => false, processStartTime: () => null };
    expect(classifyExistingLock({ pid: 100 }, 1, dead, { reclaimUnverified: true })).toBe('stale');
  });

  it('without the policy, an unverifiable lock stays conservatively live (no behavior change for un-checked callers)', () => {
    expect(classifyExistingLock({ pid: 100 }, 1, aliveWithStartTime)).toBe('live');
    expect(classifyExistingLock({ pid: 100, pidStartTime: 'Mon May 24 12:00:00 2026' }, 1, aliveNoStartTime)).toBe('live');
  });
});
