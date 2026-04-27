import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createBackup } from '../backup.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { createTicket } from './queries.js';
import {
  candidatePgResetwalPaths,
  findWorkingBackup,
  installInstructions,
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
