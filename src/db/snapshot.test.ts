/**
 * HS-8586 — Snapshot Protection Phase 1 tests. Exercises the canonical
 * snapshot writer + setting gate + debounce trigger against a real PGLite
 * temp instance (no mocks for the happy path — the whole point is proving
 * the produced tarball round-trips).
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeFileSettings } from '../file-settings.js';
import { cleanupTestDb, isInsideHotSheetTerminal, setupTestDb } from '../test-helpers.js';
import { getDbForDir } from './connection.js';
import { _resetEmptyClusterGuardForTests, noteClusterCreatedEmpty } from './emptyClusterGuard.js';
import { createPglite } from './pglite.js';
import {
  _resetSnapshotStateForTests,
  getSnapshotStatus,
  isSnapshotProtectionEnabled,
  previousSnapshotPath,
  scheduleSnapshot,
  snapshotAllForShutdown,
  snapshotPath,
  writeSnapshotNow,
} from './snapshot.js';

let dataDir: string;
let seedSeq = 0;

async function seedTickets(n: number): Promise<void> {
  const db = await getDbForDir(dataDir);
  for (let i = 0; i < n; i++) {
    seedSeq += 1;
    await db.query("INSERT INTO tickets (ticket_number, title) VALUES ($1, $2)", [`HS-${seedSeq}`, `t${seedSeq}`]);
  }
}

/** Restore the produced snapshot into a throwaway in-memory PGLite and return
 *  its ticket count — proves the tarball is a valid, loadable cluster. */
async function ticketCountInSnapshot(): Promise<number> {
  const buf = readFileSync(snapshotPath(dataDir));
  const db = createPglite(undefined, { loadDataDir: new Blob([buf]) });
  await db.waitReady;
  const res = await db.query<{ c: number }>("SELECT count(*)::int AS c FROM tickets");
  await db.close();
  return res.rows[0].c;
}

beforeEach(async () => {
  dataDir = await setupTestDb();
  seedSeq = 0;
});

afterEach(async () => {
  _resetSnapshotStateForTests();
  _resetEmptyClusterGuardForTests();
  vi.restoreAllMocks();
  await cleanupTestDb(dataDir);
});

describe('isSnapshotProtectionEnabled', () => {
  it('defaults to ON when unset', () => {
    expect(isSnapshotProtectionEnabled(dataDir)).toBe(true);
  });

  it('respects an explicit boolean false', () => {
    writeFileSettings(dataDir, { db_snapshot_protection: false });
    expect(isSnapshotProtectionEnabled(dataDir)).toBe(false);
  });

  it('respects the stringified "false" the project-settings API stores', () => {
    writeFileSettings(dataDir, { db_snapshot_protection: 'false' });
    expect(isSnapshotProtectionEnabled(dataDir)).toBe(false);
  });

  it('treats "true" / true as enabled', () => {
    writeFileSettings(dataDir, { db_snapshot_protection: 'true' });
    expect(isSnapshotProtectionEnabled(dataDir)).toBe(true);
    writeFileSettings(dataDir, { db_snapshot_protection: true });
    expect(isSnapshotProtectionEnabled(dataDir)).toBe(true);
  });
});

describe('writeSnapshotNow', () => {
  it('produces a gzip tarball that round-trips to the same row count', async () => {
    await seedTickets(3);
    const result = await writeSnapshotNow(dataDir);

    expect(result).not.toBeNull();
    expect(result!.path).toBe(snapshotPath(dataDir));
    expect(existsSync(snapshotPath(dataDir))).toBe(true);

    // gzip magic bytes (1f 8b) — confirms it's the gzipped dump, not raw.
    const head = readFileSync(snapshotPath(dataDir)).subarray(0, 2);
    expect(head[0]).toBe(0x1f);
    expect(head[1]).toBe(0x8b);

    expect(await ticketCountInSnapshot()).toBe(3);
    expect(result!.sizeBytes).toBeGreaterThan(0);
  });

  it('leaves no .tmp staging file behind after a successful write', async () => {
    await seedTickets(1);
    await writeSnapshotNow(dataDir);
    expect(existsSync(`${snapshotPath(dataDir)}.tmp`)).toBe(false);
  });

  it('records last-snapshot status for the Settings line', async () => {
    await seedTickets(2);
    const before = Date.now();
    await writeSnapshotNow(dataDir);
    const status = getSnapshotStatus(dataDir);
    expect(status.lastSnapshotAt).toBeGreaterThan(0);
    expect(status.lastSizeBytes).toBeGreaterThan(0);
    // HS-9361 — the start time is the content-cutoff bound: recorded, bounded
    // by the call window, and never after the completion stamp. Consumers
    // waiting for "a snapshot capturing mutation X" must compare against THIS,
    // not lastSnapshotAt (a slow dump finishes long after its cutoff).
    expect(status.lastSnapshotStartedAt).toBeGreaterThanOrEqual(before);
    expect(status.lastSnapshotStartedAt).toBeLessThanOrEqual(status.lastSnapshotAt!);
  });

  it('HS-9361 — start/completion stamps stay null before any snapshot', () => {
    const status = getSnapshotStatus(join(dataDir, 'nonexistent'));
    expect(status.lastSnapshotAt).toBeNull();
    expect(status.lastSnapshotStartedAt).toBeNull();
  });

  it('returns null + writes nothing when protection is disabled', async () => {
    writeFileSettings(dataDir, { db_snapshot_protection: false });
    await seedTickets(1);
    const result = await writeSnapshotNow(dataDir);
    expect(result).toBeNull();
    expect(existsSync(snapshotPath(dataDir))).toBe(false);
  });

  it('on a dump failure: returns null, writes no file, and leaves no .tmp', async () => {
    await seedTickets(1);
    const db = await getDbForDir(dataDir);
    vi.spyOn(db, 'dumpDataDir').mockRejectedValue(new Error('boom'));
    const result = await writeSnapshotNow(dataDir);
    expect(result).toBeNull();
    expect(existsSync(snapshotPath(dataDir))).toBe(false);
    expect(existsSync(`${snapshotPath(dataDir)}.tmp`)).toBe(false);
  });

  it('a failed write keeps the previous good snapshot intact (atomic rename)', async () => {
    await seedTickets(2);
    await writeSnapshotNow(dataDir);          // good snapshot with 2 tickets
    expect(await ticketCountInSnapshot()).toBe(2);

    await seedTickets(3);                       // now 5 tickets in the live DB
    const db = await getDbForDir(dataDir);
    vi.spyOn(db, 'dumpDataDir').mockRejectedValue(new Error('boom'));
    const result = await writeSnapshotNow(dataDir);

    expect(result).toBeNull();
    // The canonical snapshot still loads + still holds the previous 2 rows —
    // the failed write never replaced it with a partial file.
    expect(await ticketCountInSnapshot()).toBe(2);
  });

  // HS-9573 — the 2026-08-04 incident. A corrupt-open recovery crashed after
  // renaming `db/` aside, the next start created an empty cluster, and the
  // snapshot writer dumped that over 432 tickets. The pre-existing guard only
  // asked whether `db/` EXISTED — it did; it was seconds old.
  it('refuses to overwrite a good snapshot from a cluster that was created empty', async () => {
    await seedTickets(3);
    await writeSnapshotNow(dataDir);
    expect(await ticketCountInSnapshot()).toBe(3);

    // The state after the crash: same dataDir, a cluster with no rows, and this
    // process having created it rather than opened it.
    const db = await getDbForDir(dataDir);
    await db.query('DELETE FROM tickets');
    noteClusterCreatedEmpty(dataDir);

    const result = await writeSnapshotNow(dataDir);

    expect(result).toBeNull();
    // The 3 tickets are still there. This assertion is the whole ticket.
    expect(await ticketCountInSnapshot()).toBe(3);
  });

  it('still writes for a genuinely new project, which is empty innocently', async () => {
    // Same two facts as the case above (created empty, zero tickets) minus the
    // history. Over-blocking here would mean a new project never gets a first
    // snapshot — the guard has to tell these apart.
    noteClusterCreatedEmpty(dataDir);
    const result = await writeSnapshotNow(dataDir);
    expect(result).not.toBeNull();
    expect(await ticketCountInSnapshot()).toBe(0);
  });

  it('keeps one previous generation so a single bad write is not terminal', async () => {
    await seedTickets(2);
    await writeSnapshotNow(dataDir);
    await seedTickets(3);
    await writeSnapshotNow(dataDir);

    const prev = readFileSync(previousSnapshotPath(dataDir));
    const db = createPglite(undefined, { loadDataDir: new Blob([prev]) });
    await db.waitReady;
    const res = await db.query<{ c: number }>('SELECT count(*)::int AS c FROM tickets');
    await db.close();

    expect(await ticketCountInSnapshot()).toBe(5);  // current
    expect(res.rows[0].c).toBe(2);                  // the generation behind it
  });
});

// HS-8202 — skip inside a Hot Sheet terminal: the debounced CHECKPOINT + gzip
// dump must land inside a tight `vi.waitFor` window, which PGLite contention
// with a live co-resident Hot Sheet routinely misses. CI still runs it.
describe.skipIf(isInsideHotSheetTerminal())('scheduleSnapshot (debounce trigger)', () => {
  it('fires a debounced snapshot after the configured interval', async () => {
    writeFileSettings(dataDir, { db_snapshot_debounce_ms: 10 });
    await seedTickets(1);
    scheduleSnapshot(dataDir);
    expect(existsSync(snapshotPath(dataDir))).toBe(false); // not yet
    await vi.waitFor(() => expect(existsSync(snapshotPath(dataDir))).toBe(true), { timeout: 2000 });
    expect(await ticketCountInSnapshot()).toBe(1);
  });

  it('is a no-op when protection is disabled', async () => {
    writeFileSettings(dataDir, { db_snapshot_protection: false, db_snapshot_debounce_ms: 10 });
    await seedTickets(1);
    scheduleSnapshot(dataDir);
    await new Promise((r) => setTimeout(r, 60));
    expect(existsSync(snapshotPath(dataDir))).toBe(false);
  });

  it('throttles back-to-back debounced snapshots to the min spacing (HS-9240)', async () => {
    writeFileSettings(dataDir, { db_snapshot_debounce_ms: 10, db_snapshot_min_spacing_ms: 400 });
    await seedTickets(1);
    // First snapshot has no prior, so it fires after the debounce.
    scheduleSnapshot(dataDir);
    await vi.waitFor(() => expect(getSnapshotStatus(dataDir).lastSnapshotAt).not.toBeNull(), { timeout: 2000 });
    const first = getSnapshotStatus(dataDir).lastSnapshotAt;

    // Schedule again immediately — within the 400 ms spacing it must NOT re-dump;
    // the debounce body re-arms instead, so lastSnapshotAt stays put for now.
    await seedTickets(1);
    scheduleSnapshot(dataDir);
    await new Promise((r) => setTimeout(r, 60)); // past the 10 ms debounce, well inside the spacing
    expect(getSnapshotStatus(dataDir).lastSnapshotAt).toBe(first);

    // Once the spacing window elapses, the re-armed timer fires the deferred snapshot.
    await vi.waitFor(
      () => expect(getSnapshotStatus(dataDir).lastSnapshotAt).not.toBe(first),
      { timeout: 3000 },
    );
  });
});

describe('snapshotAllForShutdown', () => {
  it('writes a final snapshot for the registered project', async () => {
    // Touch state so the project is registered in the snapshot map.
    scheduleSnapshot(dataDir);
    await seedTickets(4);
    await snapshotAllForShutdown();
    expect(existsSync(snapshotPath(dataDir))).toBe(true);
    expect(await ticketCountInSnapshot()).toBe(4);
  });
});
