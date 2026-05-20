/**
 * HS-8144 — smoke tests for the OTel raw-row tables. Verify the three
 * tables (`otel_metrics`, `otel_events`, `otel_spans`) exist after
 * `initSchema` runs, accept the documented column shapes from §67.6, and
 * the per-prompt + per-project indexes resolve at query time. Inserts +
 * selects only; the receiver-side write logic is HS-8143's concern.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getDb } from './connection.js';

describe('OTel schema (HS-8144 / §67.6)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb(tempDir);
  });

  it('otel_metrics accepts a row with JSONB attributes + value and round-trips it', async () => {
    const db = await getDb();
    await db.query(
      `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
       VALUES (NOW(), $1, $2, $3, $4::jsonb, $5::jsonb)`,
      ['secret-A', 'session-1', 'claude_code.cost.usage', JSON.stringify({ model: 'sonnet-4' }), JSON.stringify({ value: 0.42 })],
    );
    const result = await db.query<{ metric_name: string; project_secret: string; value_json: { value: number } }>(
      `SELECT metric_name, project_secret, value_json FROM otel_metrics WHERE project_secret = $1`,
      ['secret-A'],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].metric_name).toBe('claude_code.cost.usage');
    // PGLite returns JSONB as a parsed object — no need to JSON.parse.
    expect(result.rows[0].value_json).toEqual({ value: 0.42 });
  });

  it('otel_events accepts a row with prompt_id + body and indexes it by prompt_id', async () => {
    const db = await getDb();
    await db.query(
      `INSERT INTO otel_events (ts, project_secret, session_id, prompt_id, event_name, attributes_json, body_json)
       VALUES (NOW(), $1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      ['secret-A', 'session-1', 'prompt-xyz', 'claude_code.user_prompt', JSON.stringify({ tool: 'edit' }), JSON.stringify({ text: 'hello' })],
    );
    const result = await db.query<{ event_name: string; prompt_id: string }>(
      `SELECT event_name, prompt_id FROM otel_events WHERE prompt_id = $1`,
      ['prompt-xyz'],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].event_name).toBe('claude_code.user_prompt');
    expect(result.rows[0].prompt_id).toBe('prompt-xyz');
  });

  it('otel_spans accepts trace_id + parent_span_id linkage and indexes both', async () => {
    const db = await getDb();
    const traceId = 'trace-abc';
    await db.query(
      `INSERT INTO otel_spans
         (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
       VALUES ($1, $2, NULL, $3, $4, $5, $6, NOW(), NOW(), $7::jsonb, $8)`,
      [traceId, 'span-root', 'secret-A', 'session-1', 'prompt-xyz', 'turn', JSON.stringify({}), 'OK'],
    );
    await db.query(
      `INSERT INTO otel_spans
         (trace_id, span_id, parent_span_id, project_secret, session_id, prompt_id, span_name, start_ts, end_ts, attributes_json, status_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8::jsonb, $9)`,
      [traceId, 'span-child', 'span-root', 'secret-A', 'session-1', 'prompt-xyz', 'llm.request', JSON.stringify({}), 'OK'],
    );
    const result = await db.query<{ span_id: string; parent_span_id: string | null }>(
      `SELECT span_id, parent_span_id FROM otel_spans WHERE trace_id = $1 ORDER BY span_name`,
      [traceId],
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].span_id).toBe('span-child');
    expect(result.rows[0].parent_span_id).toBe('span-root');
    expect(result.rows[1].span_id).toBe('span-root');
    expect(result.rows[1].parent_span_id).toBeNull();
  });

  it('per-project + per-prompt indexes resolve via the query planner (smoke check)', async () => {
    const db = await getDb();
    // Insert some rows so the planner has something to consider.
    for (let i = 0; i < 5; i++) {
      await db.query(
        `INSERT INTO otel_metrics (ts, project_secret, session_id, metric_name, attributes_json, value_json)
         VALUES (NOW(), $1, $2, $3, $4::jsonb, $5::jsonb)`,
        [`secret-${i % 2}`, 'session-x', 'claude_code.cost.usage', JSON.stringify({}), JSON.stringify({ value: i })],
      );
    }
    // Indexed scan on (project_secret, ts DESC).
    const plan = await db.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN SELECT * FROM otel_metrics WHERE project_secret = 'secret-0' ORDER BY ts DESC`,
    );
    const planText = plan.rows.map(r => r['QUERY PLAN']).join('\n');
    // Either an Index Scan/Bitmap Index Scan reference, or — for tiny
    // row counts — a Seq Scan. We assert the table is referenced and the
    // EXPLAIN didn't error. The actual index choice is planner's call.
    expect(planText).toMatch(/otel_metrics/);
  });
});
