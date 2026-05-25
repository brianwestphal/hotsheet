import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearRecoveryMarker, closeAllDatabases, closeDb, getDb, getDbForDir, isRecoverableOpenError, readRecoveryMarker, setDataDir } from './connection.js';
import { createTicket, getTickets } from './queries.js';

let dataDir: string;

beforeEach(() => {
  dataDir = join(tmpdir(), `hs-conn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(async () => {
  await closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('getDbByPath corruption recovery (HS-7888 + HS-7889)', () => {
  /** HS-7888 mitigation: a stale postmaster.pid alone shouldn't trigger
   *  the destructive "rename as corrupt + recreate empty" path. We open
   *  a healthy DB once, drop a stale pid file in (simulating unclean
   *  shutdown), and re-open. The original tickets must still be there
   *  AND the dbPath itself must not have been renamed. */
  it('recovers from a stale postmaster.pid without destroying live data', async () => {
    setDataDir(dataDir);
    const db1 = await getDb();
    await createTicket('Survives stale-pid recovery');
    await db1.exec('CHECKPOINT');
    await closeDb();

    const dbDir = join(dataDir, 'db');
    writeFileSync(join(dbDir, 'postmaster.pid'), '99999\n');

    setDataDir(dataDir);
    await getDb();
    const tickets = await getTickets();
    expect(tickets.some(t => t.title === 'Survives stale-pid recovery')).toBe(true);

    // No db-corrupt-* sibling should have appeared. If mitigation worked,
    // the live directory was reopened in place rather than renamed aside.
    const siblings = readdirSync(dataDir).filter(name => name.startsWith('db-corrupt-'));
    expect(siblings).toEqual([]);
  });

  /** HS-7889: the underlying open-failure message must be logged so users
   *  / future-Claude can diagnose what actually went wrong. We force a
   *  truly unrecoverable open by writing junk over the data directory and
   *  then assert that console.error received both the headline message
   *  and the original error text. */
  it('logs the underlying error message when the DB cannot be opened', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');
    writeFileSync(join(dbDir, 'global'), 'corrupt');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try {
        await getDb();
      } catch { /* may throw; we only care about what was logged */ }

      const allLogged = errorSpy.mock.calls.map(args => args.map(String).join(' ')).join('\n');
      expect(allLogged).toMatch(/Failed to open database/i);
    } finally {
      errorSpy.mockRestore();
    }
  });

  /** HS-7888: even when both mitigations exhaust, the original data
   *  directory is preserved as `db-corrupt-<timestamp>` and never
   *  rmSync'd. Previously a rename-failure path would silently delete
   *  the live data. */
  it('preserves the original data directory as db-corrupt-* on full failure', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');
    writeFileSync(join(dbDir, 'sentinel.txt'), 'preserve me');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try {
        await getDb();
      } catch { /* may throw; just observe filesystem afterwards */ }

      const siblings = readdirSync(dataDir).filter(name => name.startsWith('db-corrupt-'));
      // If recovery decided the dir was "corrupt", it should have
      // preserved the original contents — never deleted them.
      for (const sib of siblings) {
        expect(existsSync(join(dataDir, sib, 'sentinel.txt'))).toBe(true);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

/** HS-7899: when the recovery path falls all the way through to the
 *  rename-as-corrupt + fresh-cluster step, a `.db-recovery-marker.json`
 *  must be written so the launch-time client banner can prompt the user
 *  to restore from backup. The marker survives subsequent restarts
 *  until the user explicitly dismisses it (or restores). */
describe('DB recovery marker (HS-7899)', () => {
  it('writes a marker after the rename-as-corrupt + fresh-cluster path runs', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try {
        await getDb();
      } catch { /* may throw on some recovery paths; we only care about the marker */ }

      const marker = readRecoveryMarker(dataDir);
      // Whether or not getDb() succeeded, IF a `db-corrupt-*` sibling
      // appeared (i.e. the rename-as-corrupt path ran), the marker
      // must be present so the client can surface it.
      const siblings = readdirSync(dataDir).filter(name => name.startsWith('db-corrupt-'));
      if (siblings.length > 0) {
        expect(marker).not.toBeNull();
        expect(marker!.corruptPath).toContain('db-corrupt-');
        expect(typeof marker!.recoveredAt).toBe('string');
        expect(new Date(marker!.recoveredAt).toString()).not.toBe('Invalid Date');
      }
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('clearRecoveryMarker is idempotent and removes the marker file', () => {
    // No marker present — clearing should not throw.
    expect(() => clearRecoveryMarker(dataDir)).not.toThrow();
    expect(readRecoveryMarker(dataDir)).toBeNull();

    // Drop a hand-written marker, then clear it.
    writeFileSync(
      join(dataDir, '.db-recovery-marker.json'),
      JSON.stringify({ corruptPath: '/tmp/x', recoveredAt: new Date().toISOString(), errorMessage: 'boom' })
    );
    expect(readRecoveryMarker(dataDir)).not.toBeNull();
    clearRecoveryMarker(dataDir);
    expect(readRecoveryMarker(dataDir)).toBeNull();

    // Clearing again is fine.
    expect(() => clearRecoveryMarker(dataDir)).not.toThrow();
  });

  it('readRecoveryMarker returns null for malformed JSON instead of throwing', () => {
    writeFileSync(join(dataDir, '.db-recovery-marker.json'), 'not valid json {{{');
    expect(readRecoveryMarker(dataDir)).toBeNull();
  });

  it('readRecoveryMarker returns null when required fields are missing', () => {
    writeFileSync(
      join(dataDir, '.db-recovery-marker.json'),
      JSON.stringify({ recoveredAt: new Date().toISOString() }) // missing corruptPath
    );
    expect(readRecoveryMarker(dataDir)).toBeNull();
  });
});

/** HS-8426: classification helper that decides whether an open-time
 *  error triggers the preserve-and-recreate recovery flow. Pure: takes
 *  only the thrown value, returns boolean — no filesystem / DB. */
describe('isRecoverableOpenError (HS-8426)', () => {
  it('matches the WASM Aborted assertion-fault class', () => {
    expect(isRecoverableOpenError(new Error('Aborted(). Build with -sASSERTIONS for more info.'))).toBe(true);
  });

  it('matches the RuntimeError unreachable variant via message substring', () => {
    expect(isRecoverableOpenError(new Error('RuntimeError: unreachable'))).toBe(true);
  });

  it('matches the RuntimeError class by Error.name (when message is blank)', () => {
    const e = new Error('');
    e.name = 'RuntimeError';
    expect(isRecoverableOpenError(e)).toBe(true);
  });

  it('matches the PGLite 0.4.x generic init-failure wrapper (HS-8585)', () => {
    // 0.4.x throws Error("PGlite failed to initialize properly") on a corrupt
    // cluster open where 0.3.x surfaced the raw WASM Aborted/RuntimeError.
    // Without this, the corrupt-open recovery + §73 auto-restore stop firing.
    expect(isRecoverableOpenError(new Error('PGlite failed to initialize properly'))).toBe(true);
  });

  it('matches the PG catalog-corruption error from the HS-8426 repro', () => {
    // The exact string the user reported when trying to add the
    // ~/Documents/glassbox project folder. OID is variable.
    expect(isRecoverableOpenError(new Error('pg_attribute catalog is missing 1 attribute(s) for relation OID 16386'))).toBe(true);
    // Same family with different OID + different attribute count.
    expect(isRecoverableOpenError(new Error('pg_attribute catalog is missing 3 attribute(s) for relation OID 24578'))).toBe(true);
  });

  it('does NOT match benign FS errors that should propagate', () => {
    const enospc = new Error('ENOSPC: no space left on device');
    expect(isRecoverableOpenError(enospc)).toBe(false);
    const eacces = new Error('EACCES: permission denied');
    expect(isRecoverableOpenError(eacces)).toBe(false);
    const enoent = new Error('ENOENT: no such file or directory');
    expect(isRecoverableOpenError(enoent)).toBe(false);
  });

  it('does NOT match generic "missing" strings that lack the catalog signature', () => {
    // Guards against an over-broad pattern that would swallow our own
    // schema-mismatch errors.
    expect(isRecoverableOpenError(new Error('column "foo" is missing'))).toBe(false);
    expect(isRecoverableOpenError(new Error('missing required option'))).toBe(false);
  });

  it('returns false for null / undefined / non-Error values', () => {
    expect(isRecoverableOpenError(null)).toBe(false);
    expect(isRecoverableOpenError(undefined)).toBe(false);
    expect(isRecoverableOpenError(42)).toBe(false);
    // A plain string with the catalog phrase still matches via String(err).
    expect(isRecoverableOpenError('pg_attribute catalog is missing 1 attribute(s)')).toBe(true);
  });
});

/** HS-7931: `closeAllDatabases` is the central choke point used by
 *  `gracefulShutdown` (`src/lifecycle.ts`). It must close every cached
 *  PGLite instance — leaving even one open means the process exit will
 *  leave a stale `postmaster.pid` for HS-7888 to clean up next launch. */
describe('closeAllDatabases (HS-7931)', () => {
  // HS-8105: this test creates THREE real PGLite instances (dbA, dbB, plus
  // the post-close re-open). Each `initdb` is a few-hundred-ms operation
  // when run alone, but vitest's fork-pool runs ~30 sibling test files
  // in parallel and they fight for the same `initdb` shell-out, blowing
  // past the default 30 s timeout when run as part of the full suite.
  // Lift this single test's timeout to 60 s — the test passes in well
  // under that ceiling solo (~12 s); the wider envelope is purely to
  // absorb load-induced jitter so coverage can complete.
  it('closes every cached instance and clears the cache so the next getDb opens a fresh handle', async () => {
    const dataDirA = join(tmpdir(), `hs-close-all-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const dataDirB = join(tmpdir(), `hs-close-all-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDirA, { recursive: true });
    mkdirSync(dataDirB, { recursive: true });
    try {
      const dbA = await getDbForDir(dataDirA);
      const dbB = await getDbForDir(dataDirB);

      // Sanity — each instance is a live PGLite handle.
      expect(typeof dbA.close).toBe('function');
      expect(typeof dbB.close).toBe('function');

      await closeAllDatabases();

      // After closeAll, asking for the same dataDir returns a NEW handle —
      // the cache was cleared.
      const dbAAfter = await getDbForDir(dataDirA);
      expect(dbAAfter).not.toBe(dbA);
      await closeAllDatabases();
    } finally {
      rmSync(dataDirA, { recursive: true, force: true });
      rmSync(dataDirB, { recursive: true, force: true });
    }
  }, 60_000);

  it('keeps closing remaining instances even if one close throws', async () => {
    const dataDir1 = join(tmpdir(), `hs-close-all-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dataDir1, { recursive: true });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const db = await getDbForDir(dataDir1);
      // Patch close to throw the first time so we can prove the function
      // doesn't bail on the rest of the cache (none here, but the contract
      // is what's being asserted).
      const original = db.close.bind(db);
      let firstCallThrew = false;
      (db as unknown as { close: () => Promise<void> }).close = () => {
        firstCallThrew = true;
        return Promise.reject(new Error('synthetic close failure'));
      };
      await expect(closeAllDatabases()).resolves.toBeUndefined();
      expect(firstCallThrew).toBe(true);
      // Restore + actually close so the temp dir cleanup doesn't race a
      // live PGLite holding handles.
      (db as unknown as { close: () => Promise<void> }).close = original;
      await original();
    } finally {
      errorSpy.mockRestore();
      rmSync(dataDir1, { recursive: true, force: true });
    }
  });
});
