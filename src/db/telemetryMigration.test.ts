/**
 * HS-8874 — per-project telemetry migration tests. Seed a "launch-default" DB
 * with rows for projects A and B (+ a NULL-secret row), run the migration, then
 * assert:
 *   - A's rows now exist in A's DB, B's in B's DB, NULL-secret rows in central;
 *   - source rows are untouched (non-destructive);
 *   - a SECOND run adds nothing (idempotent).
 */
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDbForDir, runWithTelemetryDb } from './connection.js';

// HS-8874 — isolate the central store to a temp dir (see otelWriters.test.ts).
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

// --- Mocks: control the project list + the one-time migration flag. ---
const mockReadProjectList = vi.fn<() => string[]>();
let migratedFlag = false;

vi.mock('../project-list.js', () => ({
  readProjectList: (): string[] => mockReadProjectList(),
}));

vi.mock('../global-config.js', () => ({
  readGlobalConfig: (): { telemetryMigratedV1?: boolean } => ({ telemetryMigratedV1: migratedFlag }),
  writeGlobalConfig: (updates: { telemetryMigratedV1?: boolean }): void => {
    if (updates.telemetryMigratedV1 !== undefined) migratedFlag = updates.telemetryMigratedV1;
  },
}));

const { migratePerProjectTelemetry } = await import('./telemetryMigration.js');

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
    const db = await getDbForDir(dataDir);
    await db.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [new Date(tsIso), secret, 'sess', 'claude_code.cost.usage', JSON.stringify({ model }), JSON.stringify({ asDouble: cost })],
    );
  });
}

async function countCost(dataDir: string, secret: string | null): Promise<number> {
  return runWithTelemetryDb(dataDir, async () => {
    const db = await getDbForDir(dataDir);
    const res = secret === null
      ? await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret IS NULL`)
      : await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret = $1`, [secret]);
    return Number(res.rows[0]?.c ?? 0);
  });
}

// HS-8875 — ticket_work_intervals is migrated alongside the otel tables.
async function insertWorkInterval(dataDir: string, secret: string, ticket: string): Promise<void> {
  await runWithTelemetryDb(dataDir, async () => {
    const db = await getDbForDir(dataDir);
    await db.query(
      `INSERT INTO ticket_work_intervals (project_secret, ticket_number, started_at, ended_at)
       VALUES ($1, $2, $3, $4)`,
      [secret, ticket, new Date('2026-06-01T12:00:00Z'), new Date('2026-06-01T12:30:00Z')],
    );
  });
}

async function countWorkIntervals(dataDir: string, secret: string): Promise<number> {
  return runWithTelemetryDb(dataDir, async () => {
    const db = await getDbForDir(dataDir);
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
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it('copies foreign rows to their owning project DB + NULL-secret rows to central, leaving sources intact', async () => {
    // dirA is the launch-default dumping ground: it holds its own row, B's row,
    // and a NULL-secret row.
    await insertCost(dirA, SECRET_A, 0.5);
    await insertCost(dirA, SECRET_B, 1.0);
    await insertCost(dirA, null, NULL_MARKER);

    const result = await migratePerProjectTelemetry();
    expect(result.scannedDbs).toBe(2);
    // B's row + the NULL row are the two foreign rows moved out of A.
    expect(result.moved).toBe(2);

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

    // Non-destructive: A's DB still has all three of its original rows.
    const totalInA = await runWithTelemetryDb(dirA, async () => {
      const db = await getDbForDir(dirA);
      const res = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics`);
      return Number(res.rows[0]?.c ?? 0);
    });
    expect(totalInA).toBe(3);
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
    expect(result).toEqual({ moved: 0, perTable: {}, scannedDbs: 0 });
    // Nothing moved into B.
    expect(await countCost(dirB, SECRET_B)).toBe(0);
  });

  it('migrates ticket_work_intervals to the owning project DB (HS-8875)', async () => {
    // dirA (launch-default) holds a work interval that belongs to project B.
    await insertWorkInterval(dirA, SECRET_B, 'HS-1');
    const result = await migratePerProjectTelemetry();
    expect(result.perTable.ticket_work_intervals).toBe(1);
    // It now lives in B's DB; A's copy is left intact (non-destructive).
    expect(await countWorkIntervals(dirB, SECRET_B)).toBe(1);
    expect(await countWorkIntervals(dirA, SECRET_B)).toBe(1);
  });
});
