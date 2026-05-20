/**
 * HS-8154 — telemetry retention sweep tests. Per the ticket:
 *   1. Rows older than retention are deleted.
 *   2. Rows newer than retention are kept.
 *   3. Retention = 0 (or unset = keep-forever via default 30 OR explicit
 *      `0` = forever) keeps everything when explicitly 0.
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTelemetryRows } from './cleanup.js';
import { getDb } from './db/connection.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

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
});
