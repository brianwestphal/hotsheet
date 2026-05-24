/**
 * HS-8587 — Snapshot Protection Phase 2: auto-restore integration tests.
 *
 * Exercises the full recovery path through a real PGLite cluster: seed →
 * snapshot → corrupt the live `db/` (the same `PG_VERSION` lever the
 * HS-7889 corruption tests use) → reopen → assert the cluster auto-restored
 * from the canonical snapshot (or a §7 backup tier, or fell back to empty).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeAllDatabases, getDb, readRecoveryMarker, setDataDir } from './connection.js';
import { createTicket, getTickets } from './queries.js';
import { listRestoreSources } from './restore.js';
import { _resetSnapshotStateForTests, snapshotPath, writeSnapshotNow } from './snapshot.js';

let dataDir: string;

/** Corrupt the live cluster the way the HS-7889 tests do — overwriting
 *  `PG_VERSION` reliably makes PGLite's open abort with a recoverable error. */
function corruptLiveCluster(): void {
  writeFileSync(join(dataDir, 'db', 'PG_VERSION'), 'not-a-real-version\n');
}

beforeEach(() => {
  dataDir = join(tmpdir(), `hs-restore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dataDir, { recursive: true });
});

afterEach(async () => {
  await closeAllDatabases();
  _resetSnapshotStateForTests();
  vi.restoreAllMocks();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('listRestoreSources', () => {
  it('lists nothing when neither a snapshot nor backups exist', () => {
    expect(listRestoreSources(dataDir)).toEqual([]);
  });

  it('puts the canonical snapshot first, then existing backup tiers', () => {
    writeFileSync(snapshotPath(dataDir), 'x'); // existence-only; not loaded here
    const tierDir = join(dataDir, 'backups', '5min');
    mkdirSync(tierDir, { recursive: true });
    writeFileSync(join(tierDir, 'backup-2026-05-01T00-00-00Z.tar.gz'), 'x');

    const sources = listRestoreSources(dataDir);
    expect(sources[0].label).toBe('snapshot');
    expect(sources.some((s) => s.label.startsWith('backup:5min:'))).toBe(true);
  });
});

describe('auto-restore on corrupt open (HS-8587)', () => {
  it('restores from the canonical snapshot, preserving the corrupt dir aside', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('Restored via snapshot');
    await createTicket('Second ticket');
    await writeSnapshotNow(dataDir);
    expect(existsSync(snapshotPath(dataDir))).toBe(true);
    await closeAllDatabases();

    corruptLiveCluster();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb(); // triggers recovery → restore from snapshot
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.length).toBe(2);
    expect(tickets.some((t) => t.title === 'Restored via snapshot')).toBe(true);

    const marker = readRecoveryMarker(dataDir);
    expect(marker).not.toBeNull();
    expect(marker!.restoredFrom).toBe('snapshot');
    expect(marker!.restoredTicketCount).toBe(2);

    // The corrupt cluster is preserved aside for manual rescue, never deleted.
    const siblings = readdirSync(dataDir).filter((n) => n.startsWith('db-corrupt-'));
    expect(siblings.length).toBeGreaterThan(0);
  });

  it('falls back to a §7 backup tier tarball when no canonical snapshot exists', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('Restored via backup tier');
    await writeSnapshotNow(dataDir);

    // A snapshot tarball is byte-identical in format to a backup tarball
    // (both are dumpDataDir('gzip')). Stage it as a 5min-tier backup, then
    // remove the canonical snapshot so the fallback chain has to use it.
    const tierDir = join(dataDir, 'backups', '5min');
    mkdirSync(tierDir, { recursive: true });
    copyFileSync(snapshotPath(dataDir), join(tierDir, 'backup-2026-05-01T00-00-00Z.tar.gz'));
    rmSync(snapshotPath(dataDir));
    await closeAllDatabases();

    corruptLiveCluster();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb();
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.some((t) => t.title === 'Restored via backup tier')).toBe(true);
    const marker = readRecoveryMarker(dataDir);
    expect(marker!.restoredFrom).toMatch(/^backup:5min:/);
  });

  it('falls back to an empty cluster + banner marker when no source loads', async () => {
    setDataDir(dataDir);
    await getDb();
    await createTicket('unsaved — no snapshot was ever taken');
    await closeAllDatabases(); // NO snapshot, NO backups

    corruptLiveCluster();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    setDataDir(dataDir);
    await getDb();
    errSpy.mockRestore();

    const tickets = await getTickets();
    expect(tickets.length).toBe(0); // empty recreate

    const marker = readRecoveryMarker(dataDir);
    expect(marker).not.toBeNull();
    // No `restoredFrom` → the client shows the blocking restore banner, not a toast.
    expect(marker!.restoredFrom).toBeUndefined();
  });
});
