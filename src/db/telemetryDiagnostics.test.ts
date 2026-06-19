/**
 * HS-8888 (§85.2.4) — per-table telemetry diagnostic tests.
 *
 * `telemetryTableBreakdown` counts the OTLP tables + measures the cluster size;
 * `scheduleTelemetryBreakdownLog` fans one log job per telemetry DB onto the
 * scheduler. The project list is mocked so the scheduling test never touches the
 * developer's real `~/.hotsheet`.
 */
import { rmSync } from 'fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBackgroundScheduler } from '../scheduler/backgroundScheduler.js';
import { cleanupTestDb, createTempDir, setupTestDb } from '../test-helpers.js';
import { centralTelemetryDataDir, closeDbForDir, getDb } from './connection.js';

let centralOverrideDir: string;
beforeAll(() => { centralOverrideDir = createTempDir(); process.env.HOTSHEET_TELEMETRY_DIR = centralOverrideDir; });
afterAll(async () => {
  await closeDbForDir(centralTelemetryDataDir());
  delete process.env.HOTSHEET_TELEMETRY_DIR;
  rmSync(centralOverrideDir, { recursive: true, force: true });
});

const { mockReadProjectList } = vi.hoisted(() => ({ mockReadProjectList: vi.fn<() => string[]>(() => []) }));
vi.mock('../project-list.js', () => ({ readProjectList: mockReadProjectList }));

const { telemetryTableBreakdown, formatTelemetryBreakdown, scheduleTelemetryBreakdownLog } =
  await import('./telemetryDiagnostics.js');

async function insertSpan(): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO otel_spans (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
     VALUES ($1, $2, NULL, 's', 'sess', 'p', 'turn', NOW(), NOW(), '{}'::jsonb, 'OK')`,
    [`t-${Math.random().toString(36).slice(2)}`, `s-${Math.random().toString(36).slice(2)}`],
  );
}
async function insertMetric(): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
     VALUES (NOW(), 's', 'sess', 'm', '{}'::jsonb, '{}'::jsonb)`,
  );
}

describe('telemetryTableBreakdown (HS-8888)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  it('counts rows per OTLP table and reports a non-zero on-disk size', async () => {
    await insertSpan();
    await insertSpan();
    await insertSpan();
    await insertMetric();

    const b = await telemetryTableBreakdown(tempDir);
    expect(b.rows.otel_spans).toBe(3);
    expect(b.rows.otel_metrics).toBe(1);
    expect(b.rows.otel_events).toBe(0);
    expect(b.sizeBytes).toBeGreaterThan(0); // the PGLite cluster baseline alone is ~38 MB
    expect(b.dbDir).toContain('db');
  });
});

describe('formatTelemetryBreakdown (HS-8888)', () => {
  it('renders a one-line summary with MB + dir', () => {
    const s = formatTelemetryBreakdown({
      dbDir: '/proj/.hotsheet/db',
      sizeBytes: 150 * 1024 * 1024,
      rows: { otel_spans: 900000, otel_metrics: 1000, otel_events: 500 },
    });
    expect(s).toBe('otel_spans=900000 otel_metrics=1000 otel_events=500 (150 MB on disk: /proj/.hotsheet/db)');
  });
});

describe('scheduleTelemetryBreakdownLog (HS-8888)', () => {
  beforeEach(() => { mockReadProjectList.mockReset(); mockReadProjectList.mockReturnValue([]); });

  it('runs one breakdown job per distinct DB (launched + listed + central)', async () => {
    const launched = '/proj/launched';
    const listed = '/proj/other';
    mockReadProjectList.mockReturnValue([listed, launched]); // launched duplicated on purpose
    const scheduler = createBackgroundScheduler();
    const seen: string[] = [];
    const promises = scheduleTelemetryBreakdownLog(launched, {
      scheduler,
      breakdown: (dir) => { seen.push(dir); return Promise.resolve({ dbDir: dir, sizeBytes: 0, rows: { otel_spans: 0, otel_metrics: 0, otel_events: 0 } }); },
    });
    await Promise.all(promises);
    expect(new Set(seen)).toEqual(new Set([launched, listed, centralTelemetryDataDir()]));
    expect(seen.length).toBe(3);
  });
});
