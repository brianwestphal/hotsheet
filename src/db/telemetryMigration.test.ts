/**
 * HS-8874 / HS-8885 — per-project telemetry migration tests. Seed a "launch-
 * default" DB with rows for projects A and B (+ a NULL-secret row), run the
 * migration, then assert:
 *   - A's rows now exist in A's DB, B's in B's DB, NULL-secret rows in central;
 *   - HS-8885 — the moved foreign rows are DELETED from the source (move, not
 *     copy); the source keeps only its own-secret rows;
 *   - a SECOND run adds nothing (idempotent), and a row left in both places by a
 *     simulated insert-then-crash is reconciled (re-deleted), never duplicated.
 */
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDbForDir, getTelemetryDb, runWithTelemetryDb, telemetryClusterDataDir } from './connection.js';

// HS-8874 — isolate the central store to a temp dir (see otelWriters.test.ts).
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

// --- Mocks: control the project list + the one-time migration flag + the
//     per-source-DB resumability list. ---
const mockReadProjectList = vi.fn<() => string[]>();
let migratedFlag = false;
let doneDirs: string[] = [];
// HS-9231 — relocation flags (separate one-shot from the HS-8874 migration).
let relocatedFlag = false;
let relocationDoneDirs: string[] = [];

vi.mock('../project-list.js', () => ({
  readProjectList: (): string[] => mockReadProjectList(),
}));

interface MigrationConfig {
  telemetryMigratedV1?: boolean;
  telemetryMigrationV1DoneDirs?: string[];
  telemetryRelocatedV1?: boolean;
  telemetryRelocationV1DoneDirs?: string[];
}
vi.mock('../global-config.js', () => ({
  readGlobalConfig: (): MigrationConfig => ({
    telemetryMigratedV1: migratedFlag, telemetryMigrationV1DoneDirs: doneDirs,
    telemetryRelocatedV1: relocatedFlag, telemetryRelocationV1DoneDirs: relocationDoneDirs,
  }),
  writeGlobalConfig: (updates: MigrationConfig): void => {
    if (updates.telemetryMigratedV1 !== undefined) migratedFlag = updates.telemetryMigratedV1;
    if (updates.telemetryMigrationV1DoneDirs !== undefined) doneDirs = updates.telemetryMigrationV1DoneDirs;
    if (updates.telemetryRelocatedV1 !== undefined) relocatedFlag = updates.telemetryRelocatedV1;
    if (updates.telemetryRelocationV1DoneDirs !== undefined) relocationDoneDirs = updates.telemetryRelocationV1DoneDirs;
  },
}));

const { migratePerProjectTelemetry, relocateTelemetryToSeparateCluster } = await import('./telemetryMigration.js');

const SECRET_A = 'secret-A';
const SECRET_B = 'secret-B';

/** Build a project dir with a settings.json carrying `secret`. */
function makeProjectDir(secret: string): string {
  const dir = createTempDir();
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ secret }), 'utf-8');
  return dir;
}

async function insertCost(dataDir: string, secret: string | null, cost: number, model = 'sonnet', tsIso = '2026-06-01T12:00:00Z'): Promise<void> {
  await runWithTelemetryDb(dataDir, async () => {
    // HS-9230 — go through `getTelemetryDb` (the relocated telemetry cluster) so
    // the seed lands in the SAME cluster the migration reads, not the project `db/`.
    const db = await getTelemetryDb();
    await db.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [new Date(tsIso), secret, 'sess', 'claude_code.cost.usage', JSON.stringify({ model }), JSON.stringify({ asDouble: cost })],
    );
  });
}

async function countCost(dataDir: string, secret: string | null): Promise<number> {
  return runWithTelemetryDb(dataDir, async () => {
    const db = await getTelemetryDb();
    const res = secret === null
      ? await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret IS NULL`)
      : await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret = $1`, [secret]);
    return Number(res.rows[0]?.c ?? 0);
  });
}

// HS-8875 — ticket_work_intervals is migrated alongside the otel tables.
async function insertWorkInterval(dataDir: string, secret: string, ticket: string): Promise<void> {
  await runWithTelemetryDb(dataDir, async () => {
    const db = await getTelemetryDb();
    await db.query(
      `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at)
       VALUES ($1, $2, $3, $4)`,
      [secret, ticket, new Date('2026-06-01T12:00:00Z'), new Date('2026-06-01T12:30:00Z')],
    );
  });
}

async function countWorkIntervals(dataDir: string, secret: string): Promise<number> {
  return runWithTelemetryDb(dataDir, async () => {
    const db = await getTelemetryDb();
    const res = await db.query<{ c: bigint | number }>(
      `SELECT COUNT(*) AS c FROM ticket_work_intervals WHERE project_secret = $1`, [secret]);
    return Number(res.rows[0]?.c ?? 0);
  });
}

describe('migratePerProjectTelemetry (HS-8874)', () => {
  let dirA: string;
  let dirB: string;
  // Unique marker so the central assertions/cleanup don't collide with anything
  // already in the real `~/.hotsheet/telemetry`.
  const NULL_MARKER = 0.555111;

  beforeEach(() => {
    migratedFlag = false;
    doneDirs = [];
    mockReadProjectList.mockReset();
    dirA = makeProjectDir(SECRET_A);
    dirB = makeProjectDir(SECRET_B);
    mockReadProjectList.mockReturnValue([dirA, dirB]);
  });

  afterEach(async () => {
    // Scrub the central marker rows we created.
    const central = await getDbForDir(centralTelemetryDataDir());
    await central.query(`DELETE FROM otel_metrics WHERE project_secret IS NULL AND (value_json->>'asDouble')::numeric = $1`, [NULL_MARKER]);
    await closeDbForDir(dirA);
    await closeDbForDir(dirB);
    // HS-9230 — telemetry now lives in the sibling `<dir>/telemetry/db` cluster;
    // close those handles too so they don't leak across tests.
    await closeDbForDir(telemetryClusterDataDir(dirA));
    await closeDbForDir(telemetryClusterDataDir(dirB));
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('moves foreign rows to their owning project DB + NULL-secret rows to central, deleting them from the source (HS-8885)', async () => {
    // dirA is the launch-default dumping ground: it holds its own row, B's row,
    // and a NULL-secret row.
    await insertCost(dirA, SECRET_A, 0.5);
    await insertCost(dirA, SECRET_B, 1.0);
    await insertCost(dirA, null, NULL_MARKER);

    const result = await migratePerProjectTelemetry();
    expect(result.scannedDbs).toBe(2);
    // B's row + the NULL row are the two foreign rows moved out of A.
    expect(result.moved).toBe(2);
    // HS-8885 — and both are now gone from the source.
    expect(result.deletedFromSource).toBe(2);

    // B's row now lives in B's DB.
    expect(await countCost(dirB, SECRET_B)).toBe(1);
    // The NULL row landed in central.
    expect(await countCost(centralTelemetryDataDir(), null)).toBeGreaterThanOrEqual(1);
    const centralMarker = await runWithTelemetryDb(centralTelemetryDataDir(), async () => {
      const db = await getDbForDir(centralTelemetryDataDir());
      const res = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret IS NULL AND (value_json->>'asDouble')::numeric = $1`, [NULL_MARKER]);
      return Number(res.rows[0]?.c ?? 0);
    });
    expect(centralMarker).toBe(1);

    // HS-8885 — move, not copy: A's DB now holds ONLY its own SECRET_A row; the
    // migrated foreign rows (B's + the NULL one) are deleted from the source.
    const remainingInA = await runWithTelemetryDb(dirA, async () => {
      const db = await getTelemetryDb();
      const res = await db.query<{ project_secret: string | null }>(`SELECT project_secret FROM otel_metrics`);
      return res.rows.map(r => r.project_secret);
    });
    expect(remainingInA).toEqual([SECRET_A]);
  });

  it('is idempotent — a second run (after resetting the flag) adds nothing', async () => {
    await insertCost(dirA, SECRET_B, 1.0);
    await insertCost(dirA, null, NULL_MARKER);

    const first = await migratePerProjectTelemetry();
    expect(first.moved).toBe(2);
    expect(await countCost(dirB, SECRET_B)).toBe(1);

    // Force a re-run by clearing the one-time flag the first run set.
    migratedFlag = false;
    const second = await migratePerProjectTelemetry();
    expect(second.moved).toBe(0);
    // B's DB still has exactly one row — no duplicate.
    expect(await countCost(dirB, SECRET_B)).toBe(1);
  });

  it('skips entirely when the one-time flag is already set', async () => {
    migratedFlag = true;
    await insertCost(dirA, SECRET_B, 1.0);
    const result = await migratePerProjectTelemetry();
    expect(result).toEqual({ moved: 0, deletedFromSource: 0, perTable: {}, scannedDbs: 0 });
    // Nothing moved into B.
    expect(await countCost(dirB, SECRET_B)).toBe(0);
  });

  it('migrates ticket_work_intervals to the owning project DB (HS-8875)', async () => {
    // dirA (launch-default) holds a work interval that belongs to project B.
    await insertWorkInterval(dirA, SECRET_B, 'HS-1');
    const result = await migratePerProjectTelemetry();
    expect(result.perTable.ticket_work_intervals).toBe(1);
    // It now lives in B's DB and is deleted from A's (HS-8885 — move, not copy).
    expect(await countWorkIntervals(dirB, SECRET_B)).toBe(1);
    expect(await countWorkIntervals(dirA, SECRET_B)).toBe(0);
  });

  it('migrates a volume that spans multiple keyset pages (batching)', async () => {
    // 700 distinct foreign rows for B in the launch-default A — well past the
    // 300-row page size, so this exercises keyset pagination + batched inserts.
    const N = 700;
    await runWithTelemetryDb(dirA, async () => {
      const db = await getTelemetryDb();
      await db.query(
        `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
         SELECT now(), $1, 'sess', 'claude_code.cost.usage', '{"model":"sonnet"}'::jsonb, jsonb_build_object('asDouble', g)
         FROM generate_series(1, $2) AS g`,
        [SECRET_B, N],
      );
    });
    const result = await migratePerProjectTelemetry();
    expect(result.moved).toBe(N);
    expect(await countCost(dirB, SECRET_B)).toBe(N);
  });

  it('collapses intra-page duplicate rows to a single insert', async () => {
    // Two byte-identical foreign rows in the same page. The target can't yet
    // contain them, so the NOT EXISTS guard wouldn't catch the second — the
    // in-JS intra-batch dedupe must.
    await insertCost(dirA, SECRET_B, 1.0);
    await insertCost(dirA, SECRET_B, 1.0);
    const result = await migratePerProjectTelemetry();
    expect(result.moved).toBe(1);
    expect(await countCost(dirB, SECRET_B)).toBe(1);
    // HS-8885 — BOTH source duplicates are removed even though only one canonical
    // copy was inserted downstream.
    expect(result.deletedFromSource).toBe(2);
    expect(await countCost(dirA, SECRET_B)).toBe(0);
  });

  // HS-8885 — crash-safety: a row that a prior interrupted run had already
  // inserted into the destination but crashed BEFORE deleting from the source is
  // present in both DBs at the start. Re-running must NOT duplicate it downstream
  // (the NOT EXISTS dedupe) and MUST reconcile the source (re-delete), so no data
  // is lost and nothing double-counts.
  it('reconciles a row left in both source and destination by a simulated insert-then-crash', async () => {
    await insertCost(dirA, SECRET_B, 7.0); // the "stranded" source copy
    await insertCost(dirB, SECRET_B, 7.0); // already copied to its destination
    expect(await countCost(dirB, SECRET_B)).toBe(1);

    const result = await migratePerProjectTelemetry();
    // Nothing new inserted (already present downstream), but the source copy is
    // recognized as present-in-destination and removed.
    expect(result.moved).toBe(0);
    expect(result.deletedFromSource).toBe(1);
    expect(await countCost(dirB, SECRET_B)).toBe(1); // still exactly one — no dup
    expect(await countCost(dirA, SECRET_B)).toBe(0); // source reconciled
  });

  it('skips source DBs already recorded as drained (resumability)', async () => {
    // A prior interrupted run had finished draining dirA.
    doneDirs = [dirA];
    await insertCost(dirA, SECRET_B, 1.0);
    const result = await migratePerProjectTelemetry();
    // dirA is skipped (counted as scanned), so its B-row is NOT moved.
    expect(result.moved).toBe(0);
    expect(await countCost(dirB, SECRET_B)).toBe(0);
    // Completing the pass sets the one-time flag and clears the progress list.
    expect(migratedFlag).toBe(true);
    expect(doneDirs).toEqual([]);
  });
});

// HS-9231 (epic HS-9226 Phase 1) — relocate telemetry out of the snapshotted
// `<dataDir>/db` into the separate `<dataDir>/telemetry/db` cluster, then DROP it
// from `db/` so the §73 snapshot / §7 backup stop serializing it.
describe('relocateTelemetryToSeparateCluster (HS-9231)', () => {
  let dir: string;

  beforeEach(() => {
    relocatedFlag = false;
    relocationDoneDirs = [];
    migratedFlag = true; // the HS-8874 migration is irrelevant here — skip it
    mockReadProjectList.mockReset();
    dir = makeProjectDir(SECRET_A);
    mockReadProjectList.mockReturnValue([dir]);
  });

  afterEach(async () => {
    await closeDbForDir(dir);
    await closeDbForDir(telemetryClusterDataDir(dir));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed the OLD location: the project's main `<dataDir>/db` cluster directly. */
  async function seedOldDb(dataDir: string, secret: string, cost: number): Promise<void> {
    const db = await getDbForDir(dataDir); // <dataDir>/db
    await db.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
       VALUES ($1, $2, 'sess', 'claude_code.cost.usage', '{}'::jsonb, $3::jsonb)`,
      [new Date('2026-06-01T12:00:00Z'), secret, JSON.stringify({ asDouble: cost })],
    );
  }
  /** Count rows in the NEW relocated `<dataDir>/telemetry/db` cluster. */
  async function countInTelemetryCluster(dataDir: string, secret: string): Promise<number> {
    const db = await getDbForDir(telemetryClusterDataDir(dataDir));
    const r = await db.query<{ c: bigint | number }>(
      `SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret = $1`, [secret]);
    return Number(r.rows[0]?.c ?? 0);
  }
  /** Whether `otel_metrics` still exists in the project's `<dataDir>/db`. */
  async function otelExistsInOldDb(dataDir: string): Promise<boolean> {
    const db = await getDbForDir(dataDir);
    const r = await db.query<{ t: string | null }>(`SELECT to_regclass('otel_metrics') AS t`);
    return r.rows[0]?.t !== null;
  }

  it('moves telemetry from <dataDir>/db into <dataDir>/telemetry/db, then drops the source tables', async () => {
    await seedOldDb(dir, SECRET_A, 1.5);
    await seedOldDb(dir, SECRET_A, 2.5);
    expect(await otelExistsInOldDb(dir)).toBe(true);

    const result = await relocateTelemetryToSeparateCluster(dir);
    expect(result.moved).toBe(2);
    expect(result.droppedDbs).toBe(1);

    // Rows now live in the relocated telemetry cluster…
    expect(await countInTelemetryCluster(dir, SECRET_A)).toBe(2);
    // …and the source tables are DROPPED from `db/` (so dumpDataDir won't see them).
    expect(await otelExistsInOldDb(dir)).toBe(false);
    expect(relocatedFlag).toBe(true);
  });

  it('is idempotent — a re-run after a fresh open (schema recreated, empty) moves nothing', async () => {
    await seedOldDb(dir, SECRET_A, 1.0);
    await relocateTelemetryToSeparateCluster(dir);
    expect(await countInTelemetryCluster(dir, SECRET_A)).toBe(1);

    // Simulate the next launch: closing + reopening `db/` re-runs initSchema, which
    // recreates the (now empty) telemetry tables the relocation dropped.
    relocatedFlag = false;
    relocationDoneDirs = [];
    await closeDbForDir(dir);

    const second = await relocateTelemetryToSeparateCluster(dir);
    expect(second.moved).toBe(0);
    expect(await countInTelemetryCluster(dir, SECRET_A)).toBe(1); // no duplicate
  });

  it('skips entirely when the relocation flag is already set', async () => {
    await seedOldDb(dir, SECRET_A, 1.0);
    relocatedFlag = true;
    const result = await relocateTelemetryToSeparateCluster(dir);
    expect(result).toEqual({ moved: 0, droppedDbs: 0 });
    // Untouched — still in the old db/, not relocated.
    expect(await otelExistsInOldDb(dir)).toBe(true);
    expect(await countInTelemetryCluster(dir, SECRET_A)).toBe(0);
  });
});
