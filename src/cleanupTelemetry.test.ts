/**
 * HS-8154 — telemetry retention sweep tests. Per the ticket:
 *   1. Rows older than retention are deleted.
 *   2. Rows newer than retention are kept.
 *   3. Retention = 0 (or unset = keep-forever via default 30 OR explicit
 *      `0` = forever) keeps everything when explicitly 0.
 */
import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupAllProjectsTelemetry, cleanupTelemetryRows } from './cleanup.js';
import { centralTelemetryDataDir, closeDbForDir, getDb } from './db/connection.js';
import type * as ProjectListModule from './project-list.js';
import { cleanupTestDb, createTempDir, setupTestDb } from './test-helpers.js';

// HS-8874 — `cleanupAllProjectsTelemetry` also sweeps the central store; isolate
// it to a temp dir so the sweep never instantiates a PGlite cluster in the
// developer's real `~/.hotsheet/telemetry`.
let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

// HS-8607 — `cleanupAllProjectsTelemetry` reads the persisted project list
// from `~/.hotsheet/projects.json`. Mock it so the test never touches the
// real user file and can control which dataDirs get swept.
const { mockReadProjectList } = vi.hoisted(() => ({ mockReadProjectList: vi.fn<() => string[]>(() => []) }));
vi.mock('./project-list.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectListModule>();
  return { ...actual, readProjectList: mockReadProjectList };
});

const KNOWN_SECRET = 'secret-A';

async function insertMetric(ts: Date, secret = KNOWN_SECRET): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [ts, secret, 'session-1', 'claude_code.cost.usage', JSON.stringify({}), JSON.stringify({ value: 0.5 })],
  );
}

async function countMetrics(): Promise<number> {
  const db = await getDb();
  const r = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics`);
  return Number(r.rows[0].c);
}

function writeRetentionSetting(dataDir: string, days: number | null): void {
  const obj: Record<string, unknown> = { secret: KNOWN_SECRET, port: 4174 };
  if (days !== null) obj.telemetry_retention_days = days;
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(obj));
}

describe('cleanupTelemetryRows (HS-8154 / §67.6)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb(tempDir);
  });

  it('deletes rows older than telemetry_retention_days', async () => {
    writeRetentionSetting(tempDir, 7);
    // 10 days old — should be deleted.
    await insertMetric(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    // 30 days old — should also be deleted.
    await insertMetric(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    expect(await countMetrics()).toBe(2);

    const result = await cleanupTelemetryRows(tempDir);
    expect(result.deleted).toBe(2);
    expect(await countMetrics()).toBe(0);
  });

  it('keeps rows newer than telemetry_retention_days', async () => {
    writeRetentionSetting(tempDir, 7);
    // 1 day old — well within the 7-day window.
    await insertMetric(new Date(Date.now() - 24 * 60 * 60 * 1000));
    // 5 days old — also within window.
    await insertMetric(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));

    const result = await cleanupTelemetryRows(tempDir);
    expect(result.deleted).toBe(0);
    expect(await countMetrics()).toBe(2);
  });

  it('retention=0 keeps everything (forever)', async () => {
    writeRetentionSetting(tempDir, 0);
    // 999 days old — would normally be way past any reasonable retention.
    await insertMetric(new Date(Date.now() - 999 * 24 * 60 * 60 * 1000));

    const result = await cleanupTelemetryRows(tempDir);
    expect(result.deleted).toBe(0);
    expect(await countMetrics()).toBe(1);
  });

  it('default retention is 30 days when telemetry_retention_days is unset', async () => {
    writeRetentionSetting(tempDir, null);
    // 31 days old — past the 30-day default.
    await insertMetric(new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    // 29 days old — within default.
    await insertMetric(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));

    const result = await cleanupTelemetryRows(tempDir);
    expect(result.deleted).toBe(1);
    expect(await countMetrics()).toBe(1);
  });

  it('sweeps otel_events + otel_spans alongside otel_metrics', async () => {
    writeRetentionSetting(tempDir, 7);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const db = await getDb();
    await insertMetric(old);
    await db.query(
      `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
      [old, KNOWN_SECRET, 'session-1', 'prompt-x', 'claude_code.user_prompt', JSON.stringify({}), JSON.stringify({})],
    );
    await db.query(
      `INSERT INTO otel_spans
         (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      ['trace-x', 'span-x', KNOWN_SECRET, 'session-1', 'prompt-x', 'turn', old, old, JSON.stringify({}), 'OK'],
    );

    const result = await cleanupTelemetryRows(tempDir);
    expect(result.deleted).toBe(3);
    expect(await countMetrics()).toBe(0);
    const events = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_events`);
    const spans = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_spans`);
    expect(Number(events.rows[0].c)).toBe(0);
    expect(Number(spans.rows[0].c)).toBe(0);
  });

  // HS-8607 — the otel tables are a single shared store keyed by
  // `project_secret`. The sweep must prune ONLY the calling project's rows,
  // not every project's. Pre-fix the DELETE had no `project_secret` filter,
  // so one project's sweep wiped every project's old rows.
  it('scopes deletion to the project\'s own secret, leaving other projects\' rows untouched (HS-8607)', async () => {
    const OTHER_SECRET = 'secret-B';
    writeRetentionSetting(tempDir, 7); // settings.secret === KNOWN_SECRET
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Old rows for BOTH projects in the shared DB.
    await insertMetric(old, KNOWN_SECRET);
    await insertMetric(old, OTHER_SECRET);
    expect(await countMetrics()).toBe(2);

    const result = await cleanupTelemetryRows(tempDir);
    // Only KNOWN_SECRET's row is pruned.
    expect(result.deleted).toBe(1);
    const db = await getDb();
    const remaining = await db.query<{ project_secret: string }>(`SELECT project_secret FROM otel_metrics`);
    expect(remaining.rows.map(r => r.project_secret)).toEqual([OTHER_SECRET]);
  });
});

describe('cleanupAllProjectsTelemetry (HS-8607)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
    mockReadProjectList.mockReset();
    mockReadProjectList.mockReturnValue([]);
  });

  afterEach(async () => {
    await cleanupTestDb(tempDir);
  });

  function writeSettings(dataDir: string, secret: string, days: number): void {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ secret, port: 4174, telemetry_retention_days: days }));
  }

  it('sweeps every registered project by its OWN secret + retention window', async () => {
    // Launched project (the default/shared DB lives here): 7-day retention.
    const SECRET_A = 'secret-A';
    writeSettings(tempDir, SECRET_A, 7);

    // A second registered project with a LONGER 60-day retention. Its
    // settings live in a separate dir; its rows live in the shared DB.
    const SECRET_B = 'secret-B';
    const dirB = createTempDir();
    writeSettings(dirB, SECRET_B, 60);
    mockReadProjectList.mockReturnValue([dirB]);

    const days20 = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    // Project A, 20 days old → past A's 7-day window → deleted.
    await insertMetric(days20, SECRET_A);
    // Project B, 20 days old → within B's 60-day window → kept.
    await insertMetric(days20, SECRET_B);

    const result = await cleanupAllProjectsTelemetry(tempDir);
    expect(result.deleted).toBe(1);

    const db = await getDb();
    const remaining = await db.query<{ project_secret: string }>(`SELECT project_secret FROM otel_metrics`);
    expect(remaining.rows.map(r => r.project_secret)).toEqual([SECRET_B]);
  });

  it('still sweeps the launched project even when it is not in the persisted list', async () => {
    writeSettings(tempDir, KNOWN_SECRET, 7);
    mockReadProjectList.mockReturnValue([]); // launched dir absent from the list
    await insertMetric(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), KNOWN_SECRET);

    const result = await cleanupAllProjectsTelemetry(tempDir);
    expect(result.deleted).toBe(1);
    expect(await countMetrics()).toBe(0);
  });

  it('does not double-count when the launched dir is also in the persisted list', async () => {
    writeSettings(tempDir, KNOWN_SECRET, 7);
    mockReadProjectList.mockReturnValue([tempDir]); // duplicate of launchedDataDir
    await insertMetric(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), KNOWN_SECRET);

    const result = await cleanupAllProjectsTelemetry(tempDir);
    // Deduped via the Set — the single old row is counted once, not twice.
    expect(result.deleted).toBe(1);
    expect(await countMetrics()).toBe(0);
  });
});
