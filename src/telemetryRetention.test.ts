// @vitest-environment node
/**
 * HS-8890 (§85.2.2/85.2.3) — per-table telemetry retention windows + span row
 * cap. Spans (§68, high-volume) age out on a SHORTER window than metrics/events,
 * and a hard row cap trims `otel_spans` to its newest N as a burst backstop.
 * Built in the `cleanupTelemetry.test.ts` style: a real temp DB, no mocks needed
 * (these exercise the per-project `cleanupTelemetryRows`, which reads
 * settings.json directly and never touches the project list or central store).
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { capSpanRows, cleanupTelemetryRows } from './cleanup.js';
import { getDb } from './db/connection.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

const SECRET = 'secret-A';
const DAY_MS = 24 * 60 * 60 * 1000;

function writeSettings(dataDir: string, extra: Record<string, unknown>): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ secret: SECRET, port: 4174, ...extra }));
}

let spanSeq = 0;
async function insertSpan(startTs: Date, secret: string = SECRET): Promise<void> {
  const db = await getDb();
  spanSeq += 1;
  await db.query(
    `INSERT INTO otel_spans (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
     VALUES ($1, $2, NULL, $3, 'sess', 'p', 'turn', $4, $4, '{}'::jsonb, 'OK')`,
    [`trace-${String(spanSeq)}`, `span-${String(spanSeq)}`, secret, startTs],
  );
}
async function insertMetric(ts: Date, secret: string = SECRET): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
     VALUES ($1, $2, 'sess', 'm', '{}'::jsonb, '{}'::jsonb)`,
    [ts, secret],
  );
}
async function countSpans(secret: string = SECRET): Promise<number> {
  const db = await getDb();
  const r = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_spans WHERE project_secret = $1`, [secret]);
  return Number(r.rows[0]?.c ?? 0);
}
async function countMetrics(secret: string = SECRET): Promise<number> {
  const db = await getDb();
  const r = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_metrics WHERE project_secret = $1`, [secret]);
  return Number(r.rows[0]?.c ?? 0);
}

describe('per-table retention windows (HS-8890 §85.2.2)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); spanSeq = 0; });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  it('spans use the 7-day default while metrics keep the 30-day default', async () => {
    writeSettings(tempDir, {}); // no overrides → spans 7d, metrics/events 30d
    await insertMetric(new Date(Date.now() - 10 * DAY_MS)); // 10d old, within 30d → kept
    await insertSpan(new Date(Date.now() - 10 * DAY_MS));   // 10d old, past 7d   → deleted
    await insertSpan(new Date(Date.now() - 3 * DAY_MS));    // 3d old,  within 7d → kept

    await cleanupTelemetryRows(tempDir);

    expect(await countMetrics()).toBe(1); // metric survives the longer window
    expect(await countSpans()).toBe(1);   // only the 3-day-old span survives
  });

  it('honors an explicit telemetry_span_retention_days', async () => {
    writeSettings(tempDir, { telemetry_span_retention_days: 1 });
    await insertSpan(new Date(Date.now() - 3 * DAY_MS));      // past 1d  → deleted
    await insertSpan(new Date(Date.now() - 12 * 60 * 60 * 1000)); // 12h   → kept

    await cleanupTelemetryRows(tempDir);
    expect(await countSpans()).toBe(1);
  });

  it('span window 0 keeps spans forever (no time-based delete)', async () => {
    writeSettings(tempDir, { telemetry_span_retention_days: 0 });
    await insertSpan(new Date(Date.now() - 100 * DAY_MS)); // ancient but kept forever

    await cleanupTelemetryRows(tempDir);
    expect(await countSpans()).toBe(1);
  });
});

describe('span row cap (HS-8890 §85.2.3)', () => {
  let tempDir: string;
  beforeEach(async () => { tempDir = await setupTestDb(); spanSeq = 0; });
  afterEach(async () => { await cleanupTestDb(tempDir); });

  it('capSpanRows trims to the newest N by start_ts, deleting the oldest overflow', async () => {
    // 5 spans, oldest → newest. spanSeq encodes age: trace-1 is oldest.
    for (let i = 5; i >= 1; i--) await insertSpan(new Date(Date.now() - i * DAY_MS));
    expect(await countSpans()).toBe(5);

    const db = await getDb();
    const deleted = await capSpanRows(db, SECRET, 3);
    expect(deleted).toBe(2);
    expect(await countSpans()).toBe(3);

    // The survivors are the 3 newest (the 2 oldest start_ts rows were trimmed).
    const survivors = await db.query<{ trace_id: string }>(
      `SELECT trace_id FROM otel_spans WHERE project_secret = $1 ORDER BY start_ts ASC`, [SECRET]);
    expect(survivors.rows.map(r => r.trace_id)).toEqual(['trace-3', 'trace-4', 'trace-5']);
  });

  it('is a no-op at or under the cap', async () => {
    await insertSpan(new Date());
    await insertSpan(new Date());
    const db = await getDb();
    expect(await capSpanRows(db, SECRET, 5)).toBe(0);
    expect(await countSpans()).toBe(2);
  });
});
