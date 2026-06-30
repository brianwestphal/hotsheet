// @vitest-environment node
/**
 * HS-9232 (epic HS-9226 Phase 2) — the telemetry ROLLUP schema. These tables
 * live in the main snapshotted `<dataDir>/db` (the per-ticket cost history is
 * durable + backed up), unlike the raw `otel_*` tables which were relocated to
 * `<dataDir>/telemetry/db` (HS-9230). This pins that the tables exist with the
 * upsert-friendly primary keys the HS-9233 ingest will rely on, and that the
 * central-store `''` secret convention coexists with project rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getDb } from './connection.js';

let tempDir: string;
beforeEach(async () => { tempDir = await setupTestDb(); });
afterEach(async () => { await cleanupTestDb(tempDir); });

describe('telemetry rollup schema (HS-9232)', () => {
  it('creates otel_rollup_daily and otel_rollup_ticket in the main db cluster', async () => {
    const db = await getDb();
    const r = await db.query<{ daily: string | null; ticket: string | null }>(
      `SELECT to_regclass('otel_rollup_daily') AS daily, to_regclass('otel_rollup_ticket') AS ticket`);
    expect(r.rows[0].daily).not.toBeNull();
    expect(r.rows[0].ticket).not.toBeNull();
  });

  it('otel_rollup_daily upserts on (project_secret, day, model, query_source) — the HS-9233 ingest pattern', async () => {
    const db = await getDb();
    const upsert = async (cost: number, inTok: number): Promise<void> => {
      await db.query(
        `INSERT INTO otel_rollup_daily (project_secret, day, model, query_source, cost_usd, input_tokens, datapoint_count)
         VALUES ($1, $2, $3, $4, $5, $6, 1)
         ON CONFLICT (project_secret, day, model, query_source) DO UPDATE
           SET cost_usd = otel_rollup_daily.cost_usd + EXCLUDED.cost_usd,
               input_tokens = otel_rollup_daily.input_tokens + EXCLUDED.input_tokens,
               datapoint_count = otel_rollup_daily.datapoint_count + 1`,
        ['sec-A', '2026-06-01', 'sonnet', 'main_agent', cost, inTok],
      );
    };
    await upsert(1.5, 100);
    await upsert(2.5, 200); // same key → accumulates

    const row = await db.query<{ cost_usd: string; input_tokens: string; datapoint_count: number }>(
      `SELECT cost_usd, input_tokens, datapoint_count FROM otel_rollup_daily
       WHERE project_secret = 'sec-A' AND day = '2026-06-01' AND model = 'sonnet' AND query_source = 'main_agent'`);
    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0].cost_usd)).toBe(4.0);
    expect(Number(row.rows[0].input_tokens)).toBe(300);
    expect(row.rows[0].datapoint_count).toBe(2);
  });

  it('central (project_secret = "") and a project row coexist as distinct keys', async () => {
    const db = await getDb();
    for (const secret of ['', 'sec-A']) {
      await db.query(
        `INSERT INTO otel_rollup_daily (project_secret, day, model, query_source, cost_usd) VALUES ($1, '2026-06-02', 'haiku', 'main_agent', 1)`,
        [secret]);
    }
    const c = await db.query<{ c: bigint | number }>(`SELECT COUNT(*) AS c FROM otel_rollup_daily WHERE day = '2026-06-02'`);
    expect(Number(c.rows[0].c)).toBe(2);
  });

  it('otel_rollup_ticket upserts on (project_secret, ticket_number) and keeps a model breakdown', async () => {
    const db = await getDb();
    await db.query(
      `INSERT INTO otel_rollup_ticket (project_secret, ticket_number, cost_usd, total_tokens, prompt_count, model_breakdown)
       VALUES ('sec-A', 'HS-1', 3.0, 500, 2, '{"sonnet":{"cost":3.0,"tokens":500}}'::jsonb)
       ON CONFLICT (project_secret, ticket_number) DO UPDATE SET cost_usd = EXCLUDED.cost_usd`);
    const row = await db.query<{ cost_usd: string; prompt_count: number; model_breakdown: Record<string, unknown> }>(
      `SELECT cost_usd, prompt_count, model_breakdown FROM otel_rollup_ticket WHERE project_secret = 'sec-A' AND ticket_number = 'HS-1'`);
    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0].cost_usd)).toBe(3.0);
    expect(row.rows[0].model_breakdown).toEqual({ sonnet: { cost: 3.0, tokens: 500 } });
  });
});
