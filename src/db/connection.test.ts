import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initStartupLog } from '../startup-log.js';
import { isInsideHotSheetTerminal } from '../test-helpers.js';
import { clearRecoveryMarker, closeAllDatabases, closeDb, getDb, getDbForDir, handleLiveStorageFailure, ignoreBenignMigrationError, isClusterStorageFailure, isRecoverableOpenError, readRecoveryMarker, resetStorageFailureReportingForTests, setDataDir } from './connection.js';
import { createTicket, getTickets } from './queries.js';

// HS-9504 — a PGLite-heavy suite: real embedded-Postgres clusters, which stretch ~6x
// under the full parallel run (CPU starvation, see `vitest.config.ts`). The global 30s
// budget is deliberate and stays; the heavy tier scopes its own. Applied to the whole
// tier at once rather than one file per flake — the failing file ROTATED between runs,
// so fixing them individually was whack-a-mole.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

let dataDir: string;
let startupLogPath: string;
let savedStartupLogEnv: string | undefined;

/** HS-9590 — the durable log this suite asserts against. `HOTSHEET_STARTUP_LOG`
 *  is the documented full-path override, so the test never touches the
 *  developer's real `~/.hotsheet/startup.log`. */
function readStartupLogForTest(): string {
  return existsSync(startupLogPath) ? readFileSync(startupLogPath, 'utf-8') : '';
}

beforeEach(() => {
  dataDir = join(tmpdir(), `hs-conn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
  startupLogPath = join(dataDir, 'startup.log');
  savedStartupLogEnv = process.env.HOTSHEET_STARTUP_LOG;
  process.env.HOTSHEET_STARTUP_LOG = startupLogPath;
  // `startupLog` no-ops until a session is opened — the same ordering production
  // has (`initStartupLog` runs at the top of `main()`, long before any DB open).
  initStartupLog();
});

afterEach(async () => {
  await closeDb();
  if (savedStartupLogEnv === undefined) delete process.env.HOTSHEET_STARTUP_LOG;
  else process.env.HOTSHEET_STARTUP_LOG = savedStartupLogEnv;
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
   *  then assert the recovery narration names the cluster and the cause.
   *
   *  HS-9590 — asserts the DURABLE trail, not just stderr. Every line here now
   *  goes through `startupLog` (which still mirrors to `console.error`), because
   *  on a GUI launch the server child's stderr goes nowhere and
   *  `~/.hotsheet/startup.log` held zero trace of the 2026-08-04 recovery. */
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
      // The cause (HS-7889) …
      expect(allLogged).toMatch(/recovery: failed to open/i);
      // … the cluster it happened to, so a multi-project log is readable …
      expect(allLogged).toContain(dbDir);
      // … and where the data was preserved, which is the only pointer a user
      // has to the copy that still holds their tickets.
      expect(allLogged).toMatch(/preserving as .*db-corrupt-/i);
    } finally {
      errorSpy.mockRestore();
    }
  });

  /** HS-9590 — the recovery narration must reach `~/.hotsheet/startup.log`.
   *  `console.error` alone is invisible on a GUI launch (docs/134 §134.5), which
   *  is why the 2026-08-04 incident left an absorbed-rejection line naming a
   *  project nobody could identify. Asserting the file (not the spy) is the
   *  point: a future refactor back to `console.error` would keep the test above
   *  green and silently undo this one. */
  it('writes the recovery narration to the durable startup log', async () => {
    const dbDir = join(dataDir, 'db');
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(join(dbDir, 'PG_VERSION'), 'not-a-real-version\n');
    writeFileSync(join(dbDir, 'global'), 'corrupt');

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      setDataDir(dataDir);
      try { await getDb(); } catch { /* the log is what matters */ }
      const log = readStartupLogForTest();
      expect(log).toMatch(/recovery: failed to open/i);
      expect(log).toContain(dbDir);
      expect(log).toMatch(/preserving as .*db-corrupt-/i);
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

  it('matches the WAL-flush storage corruption from the HS-9458 report', () => {
    // Verbatim from the reported failure: data pages written ahead of the WAL,
    // so every write after it fails. Before HS-9458 this matched nothing here,
    // so recovery never ran and the server 500'd on every request, forever.
    expect(isRecoverableOpenError(new Error(
      'xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0',
    ))).toBe(true);
    // Same family, different LSNs (they vary per cluster and per failure).
    expect(isRecoverableOpenError(new Error(
      'xlog flush request 0/1A2B3C4D is not satisfied --- flushed only to 0/1A2B0000',
    ))).toBe(true);
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

/** HS-9458: the storage-corruption class + the migration `.catch()` that used to
 *  swallow it. Both pure — no filesystem / DB. */
describe('isClusterStorageFailure (HS-9458)', () => {
  it('matches the reported WAL-flush failure', () => {
    expect(isClusterStorageFailure(new Error(
      'xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0',
    ))).toBe(true);
  });

  it('matches the page-level corruption phrases in the same family', () => {
    expect(isClusterStorageFailure(new Error('invalid page in block 5 of relation base/1/461145'))).toBe(true);
    expect(isClusterStorageFailure(new Error('could not read block 3 in file "base/1/461145"'))).toBe(true);
  });

  it('does NOT match on the XX000 code alone', () => {
    // XX000 is Postgres's generic internal_error — keying on it would pull in
    // unrelated failures and preserve-aside a healthy cluster.
    const generic = Object.assign(new Error('some internal error'), { code: 'XX000' });
    expect(isClusterStorageFailure(generic)).toBe(false);
  });

  it('does NOT match benign errors', () => {
    expect(isClusterStorageFailure(new Error('relation "tickets" already exists'))).toBe(false);
    expect(isClusterStorageFailure(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isClusterStorageFailure(null)).toBe(false);
    expect(isClusterStorageFailure(undefined)).toBe(false);
    expect(isClusterStorageFailure(new Error(''))).toBe(false);
  });
});

describe('ignoreBenignMigrationError (HS-9458)', () => {
  let logged: string[];
  let restoreConsole: () => void;

  beforeEach(() => {
    logged = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
    restoreConsole = () => { spy.mockRestore(); };
  });
  afterEach(() => { restoreConsole(); });

  it('RETHROWS a storage failure instead of swallowing it', () => {
    // The core of the bug: the old filter logged this as a routine
    // `Migration error (…)` and let init continue on an unwritable cluster, so
    // the failure never reached `recoverFromOpenFailure`.
    const wal = new Error('xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0');
    expect(() => { ignoreBenignMigrationError('TIMESTAMPTZ', ['already'])(wal); }).toThrow(wal);
    expect(logged).toEqual([]);
  });

  it('rethrows a storage failure from every step, whatever its benign list', () => {
    const wal = new Error('xlog flush request 0/3BA18690 is not satisfied --- flushed only to 0/3BA176E8');
    // Both real shapes in initSchema: the "already exists" DDL steps and the
    // "does not exist" DROP/ALTER steps. Two of these swallowed the reported
    // failure before the first un-caught step finally threw.
    expect(() => { ignoreBenignMigrationError('attachments.draft_id')(wal); }).toThrow(wal);
    expect(() => { ignoreBenignMigrationError('drop vestigial rollup columns', ['does not exist'])(wal); }).toThrow(wal);
  });

  it('still swallows the benign already-applied errors silently', () => {
    const handler = ignoreBenignMigrationError('ticket_blocked_by');
    expect(() => { handler(new Error('relation "ticket_blocked_by" already exists')); }).not.toThrow();
    expect(logged).toEqual([]);
  });

  it('honors the per-step benign list', () => {
    // The DROP/ALTER steps ignore "does not exist", not "already exists".
    const drop = ignoreBenignMigrationError('drop vestigial rollup columns', ['does not exist']);
    expect(() => { drop(new Error('column "foo" of relation "bar" does not exist')); }).not.toThrow();
    expect(logged).toEqual([]);
    // ...and the TIMESTAMPTZ step's broader 'already' covers more than 'already exists'.
    const tz = ignoreBenignMigrationError('TIMESTAMPTZ', ['already']);
    expect(() => { tz(new Error('column "created_at" is already of type timestamptz')); }).not.toThrow();
    expect(logged).toEqual([]);
  });

  it('is the ONLY place initSchema swallows a migration error', () => {
    // The defect was a hand-rolled `.catch()` repeated at seven migration steps,
    // each swallowing everything it didn't recognize. They now all route through
    // the helper; this pins that, because the failure mode of adding an eighth
    // hand-rolled one is invisible until a cluster is already corrupt.
    const source = readFileSync(new URL('./connection.ts', import.meta.url), 'utf8');
    const handRolled = source.split('\n').filter((l) =>
      l.includes('.catch(') && l.includes('console.error') && !l.includes('ignoreBenignMigrationError'));
    expect(handRolled).toEqual([]);
    // Every migration `.catch()` uses the helper.
    const catches = source.split('\n').filter((l) => /\)\.catch\(/.test(l) && l.includes('Migration'));
    expect(catches.length).toBeGreaterThan(0);
    for (const line of catches) expect(line).toContain('ignoreBenignMigrationError');
  });

  it('logs (but does not throw on) an unrecognized non-fatal error', () => {
    // Unchanged behavior for the middle ground: a migration step can fail for a
    // reason that is neither benign nor fatal, and init should carry on.
    const handler = ignoreBenignMigrationError('columns');
    expect(() => { handler(new Error('syntax error at or near "ALTER"')); }).not.toThrow();
    expect(logged).toEqual(['Migration error (columns): syntax error at or near "ALTER"']);
  });
});

/** HS-7931: `closeAllDatabases` is the central choke point used by
 *  `gracefulShutdown` (`src/lifecycle.ts`). It must close every cached
 *  PGLite instance — leaving even one open means the process exit will
 *  leave a stale `postmaster.pid` for HS-7888 to clean up next launch. */
// HS-8202 — skip inside a Hot Sheet terminal: opening THREE real PGLite (WASM)
// clusters under a timeout reliably blows past it when co-resident with a live
// Hot Sheet competing for CPU/memory. CI (no HOTSHEET_IN_TERMINAL) runs it.
describe.skipIf(isInsideHotSheetTerminal())('closeAllDatabases (HS-7931)', () => {
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

/**
 * HS-9460 — the storage-corruption class appearing on a LIVE cluster, which
 * HS-9458 did not cover: nothing reopens mid-session, so none of the docs/73
 * recovery ran and the server 500'd until someone restarted into the same
 * corrupt cluster. The response is to mark it so the NEXT start restores it.
 */
describe('live storage-failure handling (HS-9460)', () => {
  let liveDir: string;
  let logged: string[];
  let restoreConsole: () => void;

  beforeEach(() => {
    liveDir = join(tmpdir(), `hs-live-fail-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(liveDir, { recursive: true });
    resetStorageFailureReportingForTests();
    logged = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
    restoreConsole = () => { spy.mockRestore(); };
  });
  afterEach(() => {
    restoreConsole();
    resetStorageFailureReportingForTests();
    rmSync(liveDir, { recursive: true, force: true });
  });

  const markerPath = (dir: string): string => join(dir, '.db-pending-recovery.json');
  const wal = (): Error => new Error('xlog flush request 0/3BA18488 is not satisfied --- flushed only to 0/3BA175E0');

  it('writes a pending-recovery marker naming the live-storage cause', () => {
    expect(existsSync(markerPath(liveDir))).toBe(false);
    handleLiveStorageFailure(join(liveDir, 'db'), wal());

    expect(existsSync(markerPath(liveDir))).toBe(true);
    const marker: unknown = JSON.parse(readFileSync(markerPath(liveDir), 'utf8'));
    expect(marker).toMatchObject({ attempts: 1, reason: 'live-storage-failure' });
  });

  it('tells the user the ONE thing that helps — restart', () => {
    // The class fails every write, so without this the user only ever sees the
    // raw `xlog flush request …` text and has no idea a restart now heals it.
    handleLiveStorageFailure(join(liveDir, 'db'), wal());
    const all = logged.join('\n');
    expect(all).toMatch(/RESTART Hot Sheet/);
    expect(all).toMatch(/restored from the newest snapshot/);
  });

  it('reports ONCE per dataDir however many queries fail', () => {
    // Every write fails, so an un-deduped handler would rewrite the marker and
    // spam the log in a tight loop for as long as the server runs.
    for (let i = 0; i < 5; i += 1) handleLiveStorageFailure(join(liveDir, 'db'), wal());
    expect(logged.filter((l) => l.includes('storage corruption on a LIVE cluster'))).toHaveLength(1);
  });

  it('marks each affected cluster separately', () => {
    const otherDir = join(tmpdir(), `hs-live-fail-other-${Date.now()}`);
    mkdirSync(otherDir, { recursive: true });
    try {
      handleLiveStorageFailure(join(liveDir, 'db'), wal());
      handleLiveStorageFailure(join(otherDir, 'db'), wal());
      expect(existsSync(markerPath(liveDir))).toBe(true);
      expect(existsSync(markerPath(otherDir))).toBe(true);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('the marker drives recovery on the NEXT open, and says why', async () => {
    // The whole point: healthy → poisoned → (restart) → recovered. Open a real
    // cluster, mark it as HS-9460 would, then reopen — `completeDeferredRecovery`
    // must preserve the old `db/` aside and leave a recovery marker whose text
    // names the live-storage cause, not the Windows handle-lock one.
    setDataDir(liveDir);
    const db = await getDb();
    await db.exec('CREATE TABLE IF NOT EXISTS live_probe (id int)');
    await closeDb();

    handleLiveStorageFailure(join(liveDir, 'db'), wal());
    expect(existsSync(markerPath(liveDir))).toBe(true);

    setDataDir(liveDir);
    await getDb();

    // Pending marker consumed, corrupt cluster preserved (never deleted), and the
    // user-facing marker explains the real cause.
    expect(existsSync(markerPath(liveDir))).toBe(false);
    expect(readdirSync(liveDir).some((n) => n.startsWith('db-corrupt-'))).toBe(true);
    const recovery = readRecoveryMarker(liveDir);
    expect(recovery).not.toBeNull();
    expect(recovery!.errorMessage).toMatch(/stopped accepting writes/);
    expect(recovery!.errorMessage).not.toMatch(/Windows handle lock/);
    await closeDb();
  });
});
