import { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gunzipSync } from 'zlib';

import { type BackupInfo, createBackup, findOverdueTiers, listBackups, triggerMissedBackups } from './backup.js';
import { getDb, SCHEMA_VERSION } from './db/connection.js';
import { createTicket } from './db/queries.js';
import { type JsonDbExport, jsonSiblingFilename } from './dbJsonExport.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

/** HS-7891: dumpDataDir without a preceding CHECKPOINT can produce a tarball
 *  whose pg_control points at a WAL position the dump captured as garbage.
 *  Loading that tarball via `new PGlite(dir, { loadDataDir })` then PANICs
 *  with "could not locate a valid checkpoint record". This test creates
 *  fresh data, takes a backup, and then immediately reloads the backup —
 *  the load + a SELECT must succeed. The test must run on every CI run so
 *  the checkpoint guard cannot be silently removed. */
describe('createBackup round-trip (HS-7891)', () => {
  it('produces a tarball that PGLite can re-load and read tickets from', async () => {
    const before = await createTicket('Round-trip ticket A');
    await createTicket('Round-trip ticket B');
    await createTicket('Round-trip ticket C');

    const info = await createBackup(tempDir, '5min');
    expect(info).not.toBeNull();
    expect(info!.ticketCount).toBeGreaterThanOrEqual(3);

    const all = listBackups(tempDir);
    const match = all.find(b => b.filename === info!.filename);
    expect(match).toBeDefined();

    const tarPath = join(tempDir, 'backups', info!.tier, info!.filename);
    expect(existsSync(tarPath)).toBe(true);
    const buffer = readFileSync(tarPath);
    const blob = new Blob([buffer]);

    // The crucial assertion: PGLite must be able to open the dumped data
    // directory. Without `CHECKPOINT;` before `dumpDataDir()` this
    // constructor throws with `PANIC: could not locate a valid checkpoint
    // record` on freshly-modified databases.
    const restoreDir = join(tempDir, 'roundtrip-restore');
    const restored = new PGlite(restoreDir, { loadDataDir: blob });
    try {
      await restored.waitReady;

      const result = await restored.query<{ id: number; title: string }>(
        `SELECT id, title FROM tickets WHERE title LIKE 'Round-trip ticket %' ORDER BY id`
      );
      expect(result.rows.length).toBe(3);
      expect(result.rows[0].title).toBe('Round-trip ticket A');
      expect(result.rows.some(r => r.id === before.id)).toBe(true);
    } finally {
      await restored.close();
      rmSync(restoreDir, { recursive: true, force: true });
    }
  }, 60_000);

  /** Defense-in-depth assertion. The reproducible production failure was
   *  timing-dependent — a small in-test workload may not trigger it because
   *  PGLite auto-checkpoints quickly. The only stable regression guard is
   *  to verify the explicit `CHECKPOINT` is issued before every
   *  `dumpDataDir`. If a future refactor drops the call, this test fails. */
  it('issues CHECKPOINT before dumpDataDir on every backup', async () => {
    const db = await getDb();
    const execSpy = vi.spyOn(db, 'exec');
    const dumpSpy = vi.spyOn(db, 'dumpDataDir');
    try {
      const info = await createBackup(tempDir, '5min');
      expect(info).not.toBeNull();

      const checkpointCallIndex = execSpy.mock.calls.findIndex(
        ([sql]) => typeof sql === 'string' && /^\s*CHECKPOINT\b/i.test(sql)
      );
      expect(checkpointCallIndex).toBeGreaterThanOrEqual(0);

      const dumpCallTime = dumpSpy.mock.invocationCallOrder[0];
      const checkpointCallTime = execSpy.mock.invocationCallOrder[checkpointCallIndex];
      expect(checkpointCallTime).toBeLessThan(dumpCallTime);
    } finally {
      execSpy.mockRestore();
      dumpSpy.mockRestore();
    }
  });
});

/** HS-7894: daily backups don't fire for users who restart Hot Sheet
 *  within 24 hours of starting it. setInterval timers reset on every
 *  process launch, so a user with frequent restarts never sees a daily
 *  backup. The fix is a startup catch-up: any tier whose newest backup
 *  is older than its interval gets a fresh one. These tests pin the
 *  contract so the regression cannot return silently. */
describe('overdue tier detection (HS-7894)', () => {
  function fakeBackup(tier: BackupInfo['tier'], minutesAgo: number, now: number): BackupInfo {
    return {
      tier,
      filename: `backup-${tier}-${minutesAgo}.tar.gz`,
      createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
      ticketCount: 1,
      sizeBytes: 100,
    };
  }

  it('reports every tier as overdue when there are no backups', () => {
    const overdue = findOverdueTiers([], Date.now());
    expect(overdue).toEqual(['5min', 'hourly', 'daily']);
  });

  it('reports daily as overdue when the newest daily is 25h old', () => {
    const now = Date.now();
    const backups: BackupInfo[] = [
      fakeBackup('5min', 1, now),
      fakeBackup('hourly', 30, now),
      fakeBackup('daily', 25 * 60, now),
    ];
    const overdue = findOverdueTiers(backups, now);
    expect(overdue).toEqual(['daily']);
  });

  it('reports nothing overdue when every tier has a fresh backup', () => {
    const now = Date.now();
    const backups: BackupInfo[] = [
      fakeBackup('5min', 1, now),
      fakeBackup('hourly', 30, now),
      fakeBackup('daily', 60, now),
    ];
    expect(findOverdueTiers(backups, now)).toEqual([]);
  });

  it('reports both hourly and daily overdue after a quiet weekend', () => {
    const now = Date.now();
    const backups: BackupInfo[] = [
      fakeBackup('5min', 4, now), // 4 min ago — fresh
      fakeBackup('hourly', 70, now), // 70 min ago — overdue
      fakeBackup('daily', 48 * 60, now), // 48h ago — overdue
    ];
    const overdue = findOverdueTiers(backups, now);
    expect(overdue).toContain('hourly');
    expect(overdue).toContain('daily');
    expect(overdue).not.toContain('5min');
  });

  it('uses only the newest backup per tier (older entries are ignored)', () => {
    const now = Date.now();
    const backups: BackupInfo[] = [
      fakeBackup('5min', 1, now),
      fakeBackup('hourly', 1, now),
      fakeBackup('daily', 48 * 60, now), // older
      fakeBackup('daily', 5, now), // newer — should make daily fresh
    ];
    expect(findOverdueTiers(backups, now)).toEqual([]);
  });
});

/** HS-7893: JSON co-save is wired into createBackup. Every tarball must
 *  ship with a `.json.gz` sibling holding the full row dump, and pruning
 *  one must take out the other so orphans don't accumulate. */
describe('JSON co-save integration (HS-7893)', () => {
  it('writes a .json.gz sibling next to every tarball, with the current schemaVersion and ticket rows', async () => {
    await createTicket('JSON cosave ticket');
    const info = await createBackup(tempDir, '5min');
    expect(info).not.toBeNull();

    const dir = join(tempDir, 'backups', info!.tier);
    const tarPath = join(dir, info!.filename);
    const jsonPath = join(dir, jsonSiblingFilename(info!.filename));
    expect(existsSync(tarPath)).toBe(true);
    expect(existsSync(jsonPath)).toBe(true);

    const decoded = JSON.parse(gunzipSync(readFileSync(jsonPath)).toString('utf8')) as JsonDbExport;
    expect(decoded.schemaVersion).toBe(SCHEMA_VERSION);
    const tickets = decoded.tables.tickets as { title: string }[];
    expect(tickets.some(t => t.title === 'JSON cosave ticket')).toBe(true);
  }, 60_000);
});

describe('triggerMissedBackups (HS-7894)', () => {
  it('creates a fresh backup for each overdue tier — at first launch every tier fires', async () => {
    // The shared test DB has no backups yet at this point in the file
    // (a couple were just created above; clean those out so we observe a
    // pristine catch-up).
    const dir = join(tempDir, 'backups');
    rmSync(dir, { recursive: true, force: true });

    await triggerMissedBackups(tempDir);

    const all = listBackups(tempDir);
    const tiers = new Set(all.map(b => b.tier));
    expect(tiers.has('5min')).toBe(true);
    expect(tiers.has('hourly')).toBe(true);
    expect(tiers.has('daily')).toBe(true);
  }, 60_000);
});
