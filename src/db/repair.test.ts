import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackup } from '../backup.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { createTicket } from './queries.js';
import {
  candidatePgResetwalPaths,
  findWorkingBackup,
  installInstructions,
  listCorruptClusters,
  parsePgResetwalMajor,
  PGLITE_PG_MAJOR,
  resolveCorruptCluster,
} from './repair.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * HS-7897: pure helpers + integration for Settings → Backups → Database
 * Repair. The cross-platform install instructions and candidate-path
 * lists are pinned by unit tests so adding a new platform doesn't
 * silently regress an existing one. The find-working-backup integration
 * test verifies the newest-first iteration + skip-bad-tarball logic.
 */
describe('installInstructions (HS-7897)', () => {
  it('returns Homebrew text on macOS', () => {
    const out = installInstructions('darwin');
    expect(out.description).toMatch(/macOS/);
    expect(out.command).toMatch(/brew install postgresql@17/);
    expect(out.url).toMatch(/postgresql\.org/);
  });

  it('returns apt + dnf text on Linux', () => {
    const out = installInstructions('linux');
    expect(out.description).toMatch(/Linux/);
    expect(out.command).toMatch(/apt install postgresql-17/);
    expect(out.command).toMatch(/dnf install postgresql17/);
  });

  it('returns the EnterpriseDB text on Windows', () => {
    const out = installInstructions('win32');
    expect(out.description).toMatch(/Windows/);
    expect(out.command).toMatch(/EnterpriseDB|installer/i);
    expect(out.url).toMatch(/postgresql\.org\/download\/windows/);
  });

  it('falls back to a generic download link on unknown platforms', () => {
    // freebsd / aix / sunos all share the fallback branch
    const out = installInstructions('freebsd');
    expect(out.description).toMatch(/Other/);
    expect(out.url).toMatch(/postgresql\.org/);
  });
});

describe('candidatePgResetwalPaths (HS-7897)', () => {
  it('always tries the bare command first so PATH wins', () => {
    expect(candidatePgResetwalPaths('darwin')[0]).toBe('pg_resetwal');
    expect(candidatePgResetwalPaths('linux')[0]).toBe('pg_resetwal');
    expect(candidatePgResetwalPaths('win32')[0]).toBe('pg_resetwal.exe');
  });

  it('macOS includes Homebrew + Postgres.app paths', () => {
    const paths = candidatePgResetwalPaths('darwin');
    expect(paths).toContain('/opt/homebrew/opt/postgresql@17/bin/pg_resetwal');
    expect(paths).toContain('/usr/local/opt/postgresql@17/bin/pg_resetwal');
    expect(paths.some(p => p.includes('Postgres.app'))).toBe(true);
  });

  it('Linux includes the standard /usr/lib/postgresql/17 path', () => {
    expect(candidatePgResetwalPaths('linux')).toContain('/usr/lib/postgresql/17/bin/pg_resetwal');
  });

  it('Windows includes the default EnterpriseDB install path', () => {
    expect(candidatePgResetwalPaths('win32')).toContain('C:\\Program Files\\PostgreSQL\\17\\bin\\pg_resetwal.exe');
  });
});

describe('findWorkingBackup (HS-7897)', () => {
  it('returns the newest tarball that opens cleanly, skipping broken ones', async () => {
    // Create a healthy backup from the test DB
    await createTicket('Repair test ticket A');
    await createTicket('Repair test ticket B');
    const good = await createBackup(tempDir, '5min');
    expect(good).not.toBeNull();

    // Sabotage a fake "newer" tarball so the iteration must skip it
    // and fall through to the good one.
    const tierDir = join(tempDir, 'backups', '5min');
    const badFilename = 'backup-2099-01-01T00-00-00Z.tar.gz';
    writeFileSync(join(tierDir, badFilename), Buffer.from('not a real tarball'));

    const result = await findWorkingBackup(tempDir);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe(good!.filename);
    expect(result!.tier).toBe('5min');
    expect(result!.ticketCount).toBeGreaterThanOrEqual(2);

    // Cleanup the sabotaged tarball so subsequent tests don't trip on it
    rmSync(join(tierDir, badFilename), { force: true });
  }, 60_000);

  it('returns null when no tarballs exist', async () => {
    // Create an empty backup dir
    const emptyDataDir = await setupTestDb();
    try {
      const result = await findWorkingBackup(emptyDataDir);
      expect(result).toBeNull();
    } finally {
      await cleanupTestDb(emptyDataDir);
    }
  }, 60_000);
});

// HS-9575 — before this, repair could only ever operate on the ONE directory
// named by `.db-recovery-marker.json`. That marker is written at the END of
// recovery, so a recovery that died partway (HS-9572) leaves the PREVIOUS
// incident's marker behind — on 2026-08-04 it named a 0-byte directory while
// the one holding 432 tickets sat beside it, unreferenced and unofferable.
describe('corrupt-cluster enumeration (HS-9575)', () => {
  let dir: string;

  beforeEach(() => {
    dir = join(tmpdir(), `hs-corrupt-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeCandidate(name: string, opts: { cluster: boolean; bytes?: number } = { cluster: true }): string {
    const p = join(dir, name);
    mkdirSync(p, { recursive: true });
    if (opts.cluster) writeFileSync(join(p, 'PG_VERSION'), '17\n');
    if (opts.bytes !== undefined) writeFileSync(join(p, 'base'), 'x'.repeat(opts.bytes));
    return p;
  }

  it('lists every preserved directory, not just the one a marker names', async () => {
    makeCandidate('db-corrupt-1');
    makeCandidate('db-corrupt-2');
    makeCandidate('db-corrupt-3');
    const found = await listCorruptClusters(dir);
    expect(found.map((c) => c.name).sort()).toEqual(['db-corrupt-1', 'db-corrupt-2', 'db-corrupt-3']);
  });

  it('flags a directory that is not a cluster, instead of silently offering it', async () => {
    // The 2026-08-04 trap: an empty `db-corrupt-*` the marker pointed at.
    makeCandidate('db-corrupt-empty', { cluster: false });
    const [c] = await listCorruptClusters(dir);
    expect(c.looksLikeCluster).toBe(false);
  });

  it('reports size so a stub is distinguishable from a real cluster', async () => {
    makeCandidate('db-corrupt-big', { cluster: true, bytes: 5000 });
    const [c] = await listCorruptClusters(dir);
    expect(c.sizeBytes).toBeGreaterThanOrEqual(5000);
  });

  it('ignores unrelated directories and files', async () => {
    makeCandidate('db-corrupt-real');
    mkdirSync(join(dir, 'db'), { recursive: true });
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'db-corrupt-not-a-dir'), 'x');
    const found = await listCorruptClusters(dir);
    expect(found.map((c) => c.name)).toEqual(['db-corrupt-real']);
  });

  it('returns [] for a dataDir that does not exist', async () => {
    expect(await listCorruptClusters(join(dir, 'nope'))).toEqual([]);
  });

  describe('resolveCorruptCluster — the path guard', () => {
    // The resolved path goes straight to `cpSync` and `pg_resetwal`, so a
    // browser-supplied value has to be proven to be one of ours.
    it('accepts an enumerated candidate', async () => {
      const p = makeCandidate('db-corrupt-ok');
      expect(await resolveCorruptCluster(dir, p)).toBe(p);
    });

    it('rejects a traversal out of the data dir', async () => {
      makeCandidate('db-corrupt-ok');
      expect(await resolveCorruptCluster(dir, join(dir, '..', 'etc'))).toBeNull();
    });

    it('rejects a directory that merely shares the name prefix elsewhere', async () => {
      // A `startsWith` check on the raw string would pass this.
      const outside = join(tmpdir(), `hs-outside-${Date.now()}`, 'db-corrupt-1');
      mkdirSync(outside, { recursive: true });
      try {
        makeCandidate('db-corrupt-1');
        expect(await resolveCorruptCluster(dir, outside)).toBeNull();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('rejects a sibling that is not a corrupt directory', async () => {
      makeCandidate('db-corrupt-ok');
      mkdirSync(join(dir, 'db'), { recursive: true });
      expect(await resolveCorruptCluster(dir, join(dir, 'db'))).toBeNull();
    });
  });
});

/**
 * HS-9578 — `pg_resetwal` refuses a cluster written by a different major
 * (`data directory is of wrong version`), so "the binary runs" was never the
 * right availability question. The bare `pg_resetwal` candidate is tried FIRST,
 * and on a machine whose PATH Postgres is 18 (Homebrew's `postgresql` formula
 * today) the panel reported "available", handed the flow a binary that can
 * never work, and every probe came back `null` — which the UI renders as
 * "checking…" forever, with no error anywhere.
 */
describe('pg_resetwal version matching (HS-9578)', () => {
  it('parses the major out of real --version output', () => {
    expect(parsePgResetwalMajor('pg_resetwal (PostgreSQL) 17.9 (Homebrew)\n')).toBe(17);
    expect(parsePgResetwalMajor('pg_resetwal (PostgreSQL) 18.3 (Homebrew)\n')).toBe(18);
    // Debian/Ubuntu packaging appends its own revision.
    expect(parsePgResetwalMajor('pg_resetwal (PostgreSQL) 17.4 (Ubuntu 17.4-1.pgdg22.04+1)')).toBe(17);
  });

  it('returns null for output it cannot classify', () => {
    // Deliberately NOT an error: an unclassifiable binary is still tried, so a
    // packaging format we have not seen cannot disable repair outright.
    expect(parsePgResetwalMajor('')).toBeNull();
    expect(parsePgResetwalMajor('pg_resetwal: command not found')).toBeNull();
  });

  it('the pinned candidate paths are all the major PGLite writes', () => {
    // The fallbacks are what rescue a machine whose PATH binary is wrong, so
    // they have to agree with `PGLITE_PG_MAJOR` — a bump that updates one and
    // not the other would silently leave no usable candidate.
    const pinned = [
      ...candidatePgResetwalPaths('darwin'),
      ...candidatePgResetwalPaths('linux'),
      ...candidatePgResetwalPaths('win32'),
    ].filter((p) => p !== 'pg_resetwal' && p !== 'pg_resetwal.exe');
    expect(pinned.length).toBeGreaterThan(0);
    for (const path of pinned) expect(path).toContain(String(PGLITE_PG_MAJOR));
  });
});
