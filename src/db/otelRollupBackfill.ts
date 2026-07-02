/**
 * HS-9234 (epic HS-9226 Phase 2) — one-time BACKFILL of the compact telemetry
 * rollup tables (`otel_rollup_daily` / `otel_rollup_ticket`, schema in HS-9232)
 * from the EXISTING raw `otel_*` rows.
 *
 * HS-9233 started maintaining the rollups at OTLP ingest, but only for rows that
 * arrive AFTER it shipped. All the history written before then (the ~40 days /
 * hundreds of MB this epic is unwinding) has no rollup rows yet. When Phase 3
 * (HS-9236/9237) later moves raw to disposable JSONL and drops the raw tables,
 * that history would be lost from the dashboards. This pass derives the rollup
 * rows from the raw data so the §70/§71 displays keep their full history after
 * HS-9235 repoints them at the rollups.
 *
 * **Where the rows live.** Raw telemetry is in the un-snapshotted
 * `<dataDir>/telemetry/db` cluster (HS-9230); the rollups live in the SNAPSHOTTED
 * main `<dataDir>/db` (HS-9232 — they're tiny and the per-ticket cost history is
 * kept indefinitely, so it must be backed up). So each project is read from its
 * cluster db and written to its main db. The central store
 * (`~/.hotsheet/telemetry`) is its own cluster AND its own "main" — both handles
 * resolve to the same db there; it has no tickets, so only the daily rollup is
 * backfilled for it.
 *
 * **Recompute-from-scratch, so it's idempotent.** Unlike the ingest path (which
 * INCREMENTS), the backfill computes the COMPLETE aggregate from ALL raw rows and
 * OVERWRITES: it DELETEs the rollup tables in a project's main db, then inserts
 * the recomputed rows. Running it twice yields the same result, and it subsumes
 * whatever the dual-write ingest already wrote (the backfill's per-ticket UNION is
 * a superset of ingest's window-only attribution, so nothing is lost). The only
 * imprecision is a row ingested DURING the recompute (between the aggregate read
 * and the overwriting insert) — negligible for a one-time local migration, and
 * re-running reconciles it. A backup of the launched project is taken first.
 *
 * **Parity with the canonical reads.** The per-ticket scalars (cost / tokens /
 * prompt count / duration) come from `computeTicketRollupFromRaw` (run against the
 * cluster), so the backfilled `otel_rollup_ticket` numbers are byte-for-byte what
 * the dashboard shows today — the HS-9235 repoint is then a pure source swap. The
 * daily aggregate mirrors `getWindowTotals` / `getCostByModel` /
 * `getQuerySourceRollup` (same metric names, the same cumulative-monotonic
 * exclusion, the same token-`type` → column mapping, the same `(unknown)`
 * fallbacks) and uses the SERVER-LOCAL day (the maintainer's daily grain, matching
 * `serverLocalDay` at ingest).
 *
 * **Distinct counts + per-ticket duration.** These are NOT stored as rollup
 * columns (HS-9259 dropped them): distinct prompt/session counts live in the
 * `otel_daily_seen` dedup set and per-ticket duration in
 * `otel_ticket_prompt_span` (both HS-9243), backfilled by
 * `backfillTelemetryDailySeen` / `backfillTelemetryTicketSpans`. This module
 * backfills only the daily cost/token aggregate + the `otel_rollup_ticket`
 * scalars.
 *
 * Runs once at startup, guarded by `telemetryRollupBackfilledV1`, resumable per
 * project dir via `telemetryRollupBackfillV1DoneDirs`, best-effort: an unreadable
 * project is logged and skipped, never aborting the pass.
 */
import type { PGlite } from '@electric-sql/pglite';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { createBackup } from '../backup.js';
import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { readProjectList } from '../project-list.js';
import { centralTelemetryDataDir, getDbForDir, telemetryClusterDataDir } from './connection.js';
import { computeTicketRollupFromRaw } from './otelDashboard.js';
import { latencyBucketIndex } from './otelHistogram.js';
import { eventNameMatchSql } from './otelRollups.js';

/** Mirrors `getWindowTotals` / ingest: a cumulative monotonic counter carries its
 *  running total in every export, so SUMming re-inflates — exclude it. */
const EXCLUDE_CUMULATIVE_MONOTONIC_SQL =
  "(aggregation_temporality IS DISTINCT FROM 'cumulative' OR is_monotonic IS NOT TRUE)";

/** The two metrics the daily time-series rollup tracks (cost + split tokens). */
const COST_METRIC = 'claude_code.cost.usage';
const TOKEN_METRIC = 'claude_code.token.usage';

/** Yield the event loop between projects/tickets so a large backfill never
 *  starves the already-listening server (mirrors the HS-8874 migration). */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve); });
}

/** Minimal settings.json shape — just the project's own secret. */
const SettingsSecretSchema = z.object({ secret: z.string().optional() }).loose();

/** Read a project's secret from its `<dataDir>/settings.json`, or null. */
function readProjectSecret(dataDir: string): string | null {
  const path = join(dataDir, 'settings.json');
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = SettingsSecretSchema.safeParse(raw);
    if (!parsed.success) return null;
    const secret = parsed.data.secret;
    return typeof secret === 'string' && secret !== '' ? secret : null;
  } catch {
    return null;
  }
}

export interface RollupBackfillResult {
  /** Projects (+ central) successfully backfilled this pass. */
  scannedDirs: number;
  /** `otel_rollup_daily` rows written across all dirs. */
  dailyRows: number;
  /** `otel_rollup_ticket` rows written across all dirs. */
  ticketRows: number;
}

/**
 * Public entry point. Safe to call on every startup — self-guards via
 * `telemetryRollupBackfilledV1`, and resumes per-dir via
 * `telemetryRollupBackfillV1DoneDirs` if a prior run was interrupted.
 *
 * `launchedDataDir` is backed up once before the first backfill run (the
 * "take a backup first" requirement); it's also the seed of the dir set so a
 * just-launched, not-yet-registered project is still covered.
 */
export async function backfillTelemetryRollups(launchedDataDir: string): Promise<RollupBackfillResult> {
  const empty: RollupBackfillResult = { scannedDirs: 0, dailyRows: 0, ticketRows: 0 };
  if (readGlobalConfig().telemetryRollupBackfilledV1 === true) return empty;

  // A backup before the first run. The backfill only writes DERIVED rollup tables
  // (raw is never touched and remains the source of truth, and the pass is
  // re-runnable), so this is belt-and-suspenders — but the ticket asks for it.
  try {
    await createBackup(launchedDataDir, 'daily');
  } catch (err) {
    console.warn('[rollup-backfill] pre-backfill backup failed (non-fatal):', err);
  }

  // The server's local IANA timezone — used to bucket UTC `ts` into the same
  // server-local day `serverLocalDay` computes at ingest.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  const dirs = [...new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()])];
  const doneDirs = new Set(readGlobalConfig().telemetryRollupBackfillV1DoneDirs ?? []);

  let scannedDirs = 0;
  let dailyRows = 0;
  let ticketRows = 0;

  for (const dataDir of dirs) {
    if (doneDirs.has(dataDir)) { scannedDirs++; continue; }
    try {
      const clusterDb = await getDbForDir(telemetryClusterDataDir(dataDir));
      const mainDb = await getDbForDir(dataDir);
      const secret = readProjectSecret(dataDir); // null for the central store

      const daily = await backfillDailyForDir(clusterDb, mainDb, tz);
      const tickets = await backfillTicketsForDir(dataDir, clusterDb, mainDb, secret);
      dailyRows += daily;
      ticketRows += tickets;
      scannedDirs++;

      // Record progress AFTER this dir is fully recomputed, so a crash before
      // here re-runs it (the recompute is idempotent, so the re-run is safe).
      doneDirs.add(dataDir);
      writeGlobalConfig({ telemetryRollupBackfillV1DoneDirs: [...doneDirs] });
    } catch (err) {
      console.error(`[rollup-backfill] skipping ${dataDir}:`, err);
    }
    await yieldToEventLoop();
  }

  writeGlobalConfig({ telemetryRollupBackfilledV1: true, telemetryRollupBackfillV1DoneDirs: [] });
  console.log(`  [rollup-backfill] HS-9234: backfilled ${String(dailyRows)} daily + ${String(ticketRows)} ticket rollup row(s) across ${String(scannedDirs)} dir(s).`);
  return { scannedDirs, dailyRows, ticketRows };
}

/** A daily metric-aggregate grain row, read from the raw `otel_metrics`. */
interface DailyGrainRow {
  project_secret: string;
  day: string;
  model: string;
  query_source: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  datapoint_count: number;
}

/** Coerce a possibly-string numeric (PGlite hands NUMERIC/BIGINT back as strings)
 *  to a finite number. */
function n(v: unknown): number {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
}

/** Coerce a text column value (string | number | null) to a string, else the
 *  fallback — narrows away `unknown`/object so it never stringifies to
 *  `[object Object]`. */
function s(v: unknown, fallback: string): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return fallback;
}

/** PGlite returns a DATE column as a `YYYY-MM-DD` string OR a Date depending on
 *  the path; normalize to the `YYYY-MM-DD` string the rollup column stores. */
function dayString(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/**
 * Recompute `otel_rollup_daily` for one telemetry cluster and overwrite the main
 * db's daily rollups. Returns the number of rows written.
 */
export async function backfillDailyForDir(clusterDb: PGlite, mainDb: PGlite, tz: string): Promise<number> {
  // Per (secret, server-local day, model, query.source): cost + split-by-type
  // token sums + datapoint_count, mirroring the reads' metric handling exactly.
  const grain = await clusterDb.query<Record<string, unknown>>(
    `WITH pts AS (
       SELECT
         COALESCE(project_secret, '') AS secret,
         (ts AT TIME ZONE $1)::date AS day,
         COALESCE(attributes_json->>'model', '(unknown)') AS model,
         COALESCE(attributes_json->>'query.source', '(unknown)') AS query_source,
         metric_name AS mn,
         attributes_json->>'type' AS ttype,
         COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) AS val
       FROM otel_metrics
       WHERE metric_name IN ($2, $3) AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}
     )
     SELECT secret, day, model, query_source,
       COALESCE(SUM(val) FILTER (WHERE mn = $2), 0) AS cost_usd,
       COALESCE(SUM(val) FILTER (WHERE mn = $3 AND ttype = 'input'), 0) AS input_tokens,
       COALESCE(SUM(val) FILTER (WHERE mn = $3 AND ttype = 'output'), 0) AS output_tokens,
       COALESCE(SUM(val) FILTER (WHERE mn = $3 AND ttype IN ('cacheRead', 'cache_read')), 0) AS cache_read_tokens,
       COALESCE(SUM(val) FILTER (WHERE mn = $3 AND ttype IN ('cacheCreation', 'cache_creation')), 0) AS cache_creation_tokens,
       COUNT(*) AS datapoint_count
     FROM pts
     GROUP BY secret, day, model, query_source`,
    [tz, COST_METRIC, TOKEN_METRIC],
  );

  // HS-9259 — distinct prompt/session counts are no longer stored on
  // otel_rollup_daily (the reads derive them from otel_daily_seen, backfilled
  // separately by backfillDailySeenForDir). So the daily rollup is just the
  // metric grain.
  const rows = assembleDailyRows(grain.rows);

  // Recompute-overwrite: clear this db's daily rollups, then bulk-insert. The db
  // holds only this project's (or central's) rollups, so a full-table clear is
  // the clean "recompute from scratch" semantics.
  await mainDb.query('DELETE FROM otel_rollup_daily');
  await insertDailyRows(mainDb, rows);
  return rows.length;
}

/**
 * Map the raw `otel_metrics` grain query rows into `DailyGrainRow`s. HS-9259:
 * distinct prompt/session counts are no longer part of the daily rollup (they
 * live in `otel_daily_seen`), so this is a plain 1:1 map (no representative-row
 * stamping or carrier synthesis).
 */
export function assembleDailyRows(
  grainRaw: ReadonlyArray<Record<string, unknown>>,
): DailyGrainRow[] {
  return grainRaw.map(r => ({
    project_secret: s(r.secret, ''),
    day: dayString(r.day),
    model: s(r.model, '(unknown)'),
    query_source: s(r.query_source, '(unknown)'),
    cost_usd: n(r.cost_usd),
    input_tokens: n(r.input_tokens),
    output_tokens: n(r.output_tokens),
    cache_read_tokens: n(r.cache_read_tokens),
    cache_creation_tokens: n(r.cache_creation_tokens),
    datapoint_count: n(r.datapoint_count),
  }));
}

/** Bulk-insert daily rollup rows, batched under the bind-param ceiling. */
async function insertDailyRows(mainDb: PGlite, rows: DailyGrainRow[]): Promise<void> {
  if (rows.length === 0) return;
  const PER_BATCH = 400; // 400 rows x 10 cols = 4000 params, well under PostgreSQL's 65535.
  for (let i = 0; i < rows.length; i += PER_BATCH) {
    const batch = rows.slice(i, i + PER_BATCH);
    const params: unknown[] = [];
    const valueRows = batch.map(r => {
      const base = params.length;
      params.push(
        r.project_secret, r.day, r.model, r.query_source,
        r.cost_usd, r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens,
        r.datapoint_count,
      );
      const p = (k: number) => `$${String(base + k)}`;
      return `(${p(1)}, ${p(2)}::date, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)})`;
    });
    await mainDb.query(
      `INSERT INTO otel_rollup_daily
         (project_secret, day, model, query_source,
          cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          datapoint_count)
       VALUES ${valueRows.join(', ')}`,
      params,
    );
  }
}

/**
 * HS-9279 (epic HS-9226 Phase 3b) — one-time BACKFILL of the `kind='tool'`
 * `otel_rollup_activity` rows from the EXISTING raw `otel_events`, so `getToolRollup`
 * can repoint off raw without losing history (the ingest dual-write only covers
 * events that arrive after HS-9279 shipped). Own done-flag (separate from the
 * HS-9234 daily/ticket backfill, which may already be marked done on this machine).
 * Idempotent recompute-overwrite. Runs from `cli.ts` after `backfillTelemetryRollups`.
 */
export async function backfillTelemetryActivityRollups(launchedDataDir: string): Promise<{ scannedDirs: number; toolRows: number }> {
  const empty = { scannedDirs: 0, toolRows: 0 };
  if (readGlobalConfig().telemetryActivityRollupBackfilledV1 === true) return empty;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const dirs = [...new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()])];
  const doneDirs = new Set(readGlobalConfig().telemetryActivityRollupBackfillV1DoneDirs ?? []);

  let scannedDirs = 0;
  let toolRows = 0;
  for (const dataDir of dirs) {
    if (doneDirs.has(dataDir)) { scannedDirs++; continue; }
    try {
      const clusterDb = await getDbForDir(telemetryClusterDataDir(dataDir));
      const mainDb = await getDbForDir(dataDir);
      toolRows += await backfillActivityToolForDir(clusterDb, mainDb, tz);
      scannedDirs++;
      doneDirs.add(dataDir);
      writeGlobalConfig({ telemetryActivityRollupBackfillV1DoneDirs: [...doneDirs] });
    } catch (err) {
      console.error(`[activity-rollup-backfill] skipping ${dataDir}:`, err);
    }
    await yieldToEventLoop();
  }

  writeGlobalConfig({ telemetryActivityRollupBackfilledV1: true, telemetryActivityRollupBackfillV1DoneDirs: [] });
  console.log(`  [activity-rollup-backfill] HS-9279: backfilled ${String(toolRows)} tool rollup row(s) across ${String(scannedDirs)} dir(s).`);
  return { scannedDirs, toolRows };
}

/**
 * Recompute the `kind='tool'` activity rollup for one telemetry cluster and
 * overwrite the main db's tool rows. Groups raw `tool_result` events by
 * (secret, server-local day, tool) into count + duration sum / with-duration
 * count — the exact grain `getToolRollup` reads back (avg = sum_val / sum_n),
 * mirroring the old `COUNT(*)` + `AVG(duration_ms) FILTER (…)`. Returns rows written.
 */
export async function backfillActivityToolForDir(clusterDb: PGlite, mainDb: PGlite, tz: string): Promise<number> {
  const grain = await clusterDb.query<Record<string, unknown>>(
    `SELECT COALESCE(project_secret, '') AS secret,
            (ts AT TIME ZONE $1)::date AS day,
            COALESCE(attributes_json->>'tool_name', attributes_json->>'name', '(unknown)') AS tool,
            COUNT(*) AS c,
            COALESCE(SUM((attributes_json->>'duration_ms')::numeric) FILTER (WHERE attributes_json->>'duration_ms' IS NOT NULL), 0) AS dur_sum,
            COUNT(*) FILTER (WHERE attributes_json->>'duration_ms' IS NOT NULL) AS dur_n
       FROM otel_events
      WHERE ${eventNameMatchSql('event_name', 'tool_result')}
      GROUP BY secret, day, tool`,
    [tz],
  );
  // HS-9279 — per-(secret, day, tool, bucket) latency histogram counts, from the
  // duration-carrying tool_result events (buckets computed in JS via latencyBucketIndex
  // so the boundaries can't drift from ingest/read).
  const durs = await clusterDb.query<Record<string, unknown>>(
    `SELECT COALESCE(project_secret, '') AS secret,
            (ts AT TIME ZONE $1)::date AS day,
            COALESCE(attributes_json->>'tool_name', attributes_json->>'name', '(unknown)') AS tool,
            (attributes_json->>'duration_ms')::numeric AS dur
       FROM otel_events
      WHERE ${eventNameMatchSql('event_name', 'tool_result')} AND attributes_json->>'duration_ms' IS NOT NULL`,
    [tz],
  );
  const bucketCounts = new Map<string, { secret: string; day: string; tool: string; bucket: number; count: number }>();
  for (const r of durs.rows) {
    const secret = s(r.secret, '');
    const day = dayString(r.day);
    const tool = s(r.tool, '(unknown)');
    const bucket = latencyBucketIndex(n(r.dur));
    const key = `${secret} ${day} ${tool} ${String(bucket)}`;
    const existing = bucketCounts.get(key);
    if (existing !== undefined) existing.count++;
    else bucketCounts.set(key, { secret, day, tool, bucket, count: 1 });
  }

  // Recompute-overwrite: this db holds only its own project's (or central's)
  // activity rollups, so clearing the kind='tool'/'tool_latency' rows is the clean reset.
  await mainDb.query(`DELETE FROM otel_rollup_activity WHERE kind IN ('tool', 'tool_latency')`);
  for (const r of grain.rows) {
    await mainDb.query(
      `INSERT INTO otel_rollup_activity (project_secret, day, kind, dim1, dim2, count, sum_val, sum_n)
       VALUES ($1, $2::date, 'tool', $3, '', $4, $5, $6)`,
      [s(r.secret, ''), dayString(r.day), s(r.tool, '(unknown)'), n(r.c), n(r.dur_sum), n(r.dur_n)],
    );
  }
  for (const b of bucketCounts.values()) {
    await mainDb.query(
      `INSERT INTO otel_rollup_activity (project_secret, day, kind, dim1, dim2, count, sum_val, sum_n)
       VALUES ($1, $2::date, 'tool_latency', $3, $4, $5, 0, 0)`,
      [b.secret, b.day, b.tool, String(b.bucket), b.count],
    );
  }
  return grain.rows.length;
}

/**
 * Recompute `otel_rollup_ticket` for one project and overwrite its main db's
 * ticket rollups. The central store (`secret === null`) has no tickets, so it's
 * skipped. Returns the number of ticket rows written.
 */
export async function backfillTicketsForDir(
  dataDir: string,
  clusterDb: PGlite,
  mainDb: PGlite,
  secret: string | null,
): Promise<number> {
  if (secret === null || secret === '') return 0;

  const ticketNumbers = await collectTicketNumbers(clusterDb, secret);

  // Recompute-overwrite (see the module header): clear, then reinsert the full
  // UNION-derived set.
  await mainDb.query('DELETE FROM otel_rollup_ticket');
  if (ticketNumbers.length === 0) return 0;

  let written = 0;
  for (const ticket of ticketNumbers) {
    // Canonical scalars from the raw-scanning computation (HS-9257 extracted it
    // out of getPerTicketRollup, which now READS this rollup — calling it here
    // would be circular). Runs directly against THIS project's cluster db.
    const scalar = await computeTicketRollupFromRaw(clusterDb, ticket, secret);
    if (scalar.promptCount === 0 && scalar.totalCost === 0 && scalar.totalTokens === 0 && scalar.totalDurationSeconds === 0) {
      // No attributed api_request events — nothing to record for this ticket.
      continue;
    }
    const breakdown = await ticketModelBreakdown(clusterDb, ticket, secret);
    // HS-9259 — duration_seconds column dropped; per-ticket duration is now
    // recomputed at read time from otel_ticket_prompt_span (populated by
    // backfillTicketPromptSpansForDir), so the ticket rollup no longer stores it.
    await mainDb.query(
      `INSERT INTO otel_rollup_ticket
         (project_secret, ticket_number, cost_usd, total_tokens, prompt_count, model_breakdown, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
      [secret, ticket, scalar.totalCost, scalar.totalTokens, scalar.promptCount, JSON.stringify(breakdown)],
    );
    written++;
    await yieldToEventLoop();
  }
  return written;
}

/** Every ticket that has any telemetry to attribute: those referenced by a
 *  `hotsheet:ticket=…` marker in a `user_prompt` body, UNION those with a
 *  `ticket_work_intervals` window (the two sources `getPerTicketRollup` reads). */
async function collectTicketNumbers(clusterDb: PGlite, secret: string): Promise<string[]> {
  const markerRows = await clusterDb.query<{ ticket: string | null }>(
    `SELECT DISTINCT substring(body_json::text from 'hotsheet:ticket=([A-Za-z]+-[0-9]+)') AS ticket
     FROM otel_events
     WHERE ${eventNameMatchSql('event_name', 'user_prompt')} AND body_json::text LIKE '%hotsheet:ticket=%'`,
  );
  const intervalRows = await clusterDb.query<{ ticket: string | null }>(
    `SELECT DISTINCT ticket_number AS ticket FROM ticket_work_intervals WHERE project_secret = $1`,
    [secret],
  );
  const set = new Set<string>();
  for (const r of [...markerRows.rows, ...intervalRows.rows]) {
    if (typeof r.ticket === 'string' && r.ticket !== '') set.add(r.ticket);
  }
  return [...set].sort();
}

/**
 * Per-model cost/tokens breakdown for one ticket's attributed api_request
 * events — the new `model_breakdown` field the live read doesn't compute. Mirrors
 * `getPerTicketRollup`'s `matched` CTE (same marker + time-window UNION, the same
 * cost/token COALESCE variants), grouped by model. The summed costs/tokens here
 * equal the scalar totals (same matched set), so the breakdown is internally
 * consistent with the row's `cost_usd` / `total_tokens`.
 */
async function ticketModelBreakdown(
  clusterDb: PGlite,
  ticket: string,
  secret: string,
): Promise<Record<string, { cost: number; tokens: number }>> {
  const marker = `%hotsheet:ticket=${ticket}%`;
  const res = await clusterDb.query<{ model: string; cost: string | number; tokens: string | number }>(
    `WITH marker_prompts AS (
       SELECT DISTINCT prompt_id FROM otel_events
       WHERE ${eventNameMatchSql('event_name', 'user_prompt')}
         AND prompt_id IS NOT NULL
         AND body_json::text LIKE $1
     ),
     matched AS (
       SELECT
         COALESCE(e.attributes_json->>'model', '(unknown)') AS model,
         COALESCE(
           (e.attributes_json->>'cost')::numeric,
           (e.attributes_json->>'cost_usd')::numeric,
           0
         ) AS cost,
         COALESCE(
           (e.attributes_json->>'tokens')::numeric,
           (e.attributes_json->>'total_tokens')::numeric,
           (e.attributes_json->>'input_tokens')::numeric + (e.attributes_json->>'output_tokens')::numeric,
           0
         ) AS tokens
       FROM otel_events e
       WHERE ${eventNameMatchSql('e.event_name', 'api_request')}
         AND (
           e.prompt_id IN (SELECT prompt_id FROM marker_prompts)
           OR (
             e.project_secret = $2 AND EXISTS (
               SELECT 1 FROM ticket_work_intervals i
               WHERE i.project_secret = $2 AND i.ticket_number = $3
                 AND e.ts >= i.started_at AND e.ts <= COALESCE(i.ended_at, NOW())
             )
           )
         )
     )
     SELECT model, COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(tokens), 0) AS tokens
     FROM matched GROUP BY model`,
    [marker, secret, ticket],
  );

  const out: Record<string, { cost: number; tokens: number }> = {};
  for (const row of res.rows) {
    out[row.model] = { cost: n(row.cost), tokens: n(row.tokens) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// HS-9243 — backfill the daily distinct-count dedup set (`otel_daily_seen`) from
// existing raw, so the HS-9235 reads have exact historical prompt/session counts
// (ongoing days are maintained at ingest via `markDailySeen`). Separate one-shot
// from the rollup backfill above (that guard may already be spent), with its own
// `telemetryDailySeenBackfilledV1` flag + per-dir resumability.
// ---------------------------------------------------------------------------

export interface DailySeenBackfillResult {
  scannedDirs: number;
  /** `otel_daily_seen` rows inserted across all dirs. */
  seenRows: number;
}

/**
 * Public entry point. Self-guards via `telemetryDailySeenBackfilledV1`; resumes
 * per-dir via `telemetryDailySeenBackfillV1DoneDirs`. Best-effort per dir.
 */
export async function backfillTelemetryDailySeen(launchedDataDir: string): Promise<DailySeenBackfillResult> {
  const empty: DailySeenBackfillResult = { scannedDirs: 0, seenRows: 0 };
  if (readGlobalConfig().telemetryDailySeenBackfilledV1 === true) return empty;

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const dirs = [...new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()])];
  const doneDirs = new Set(readGlobalConfig().telemetryDailySeenBackfillV1DoneDirs ?? []);

  let scannedDirs = 0;
  let seenRows = 0;

  for (const dataDir of dirs) {
    if (doneDirs.has(dataDir)) { scannedDirs++; continue; }
    try {
      const clusterDb = await getDbForDir(telemetryClusterDataDir(dataDir));
      const mainDb = await getDbForDir(dataDir);
      seenRows += await backfillDailySeenForDir(clusterDb, mainDb, tz);
      scannedDirs++;
      doneDirs.add(dataDir);
      writeGlobalConfig({ telemetryDailySeenBackfillV1DoneDirs: [...doneDirs] });
    } catch (err) {
      console.error(`[daily-seen-backfill] skipping ${dataDir}:`, err);
    }
    await yieldToEventLoop();
  }

  writeGlobalConfig({ telemetryDailySeenBackfilledV1: true, telemetryDailySeenBackfillV1DoneDirs: [] });
  console.log(`  [daily-seen-backfill] HS-9243: inserted ${String(seenRows)} distinct prompt/session row(s) across ${String(scannedDirs)} dir(s).`);
  return { scannedDirs, seenRows };
}

/** One (kind, secret, day, id) dedup row to insert. */
interface SeenRow { secret: string; day: string; kind: 'prompt' | 'session'; id: string }

/**
 * Derive the distinct prompt / session ids per (project, server-local day) from
 * one cluster's raw and insert them into that project's main-db dedup set.
 * `ON CONFLICT DO NOTHING` makes it idempotent (and consistent with the ongoing
 * ingest path). Returns the number of rows the inserts actually added.
 */
export async function backfillDailySeenForDir(clusterDb: PGlite, mainDb: PGlite, tz: string): Promise<number> {
  const prompts = await clusterDb.query<Record<string, unknown>>(
    `SELECT DISTINCT COALESCE(project_secret, '') AS secret, (ts AT TIME ZONE $1)::date AS day, prompt_id AS id
     FROM otel_events
     WHERE prompt_id IS NOT NULL AND prompt_id <> ''`,
    [tz],
  );
  const sessions = await clusterDb.query<Record<string, unknown>>(
    `SELECT DISTINCT COALESCE(project_secret, '') AS secret, (ts AT TIME ZONE $1)::date AS day, attributes_json->>'session.id' AS id
     FROM otel_metrics
     WHERE metric_name IN ('claude_code.cost.usage', 'claude_code.token.usage')
       AND attributes_json->>'session.id' IS NOT NULL AND attributes_json->>'session.id' <> ''
       AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}`,
    [tz],
  );

  const rows: SeenRow[] = [
    ...prompts.rows.map(r => ({ secret: s(r.secret, ''), day: dayString(r.day), kind: 'prompt' as const, id: s(r.id, '') })),
    ...sessions.rows.map(r => ({ secret: s(r.secret, ''), day: dayString(r.day), kind: 'session' as const, id: s(r.id, '') })),
  ].filter(r => r.id !== '');

  return insertSeenRows(mainDb, rows);
}

/** Bulk-insert dedup rows (ON CONFLICT DO NOTHING), batched under the bind cap. */
async function insertSeenRows(mainDb: PGlite, rows: SeenRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const PER_BATCH = 800; // 800 × 4 cols = 3200 params, well under 65535.
  let inserted = 0;
  for (let i = 0; i < rows.length; i += PER_BATCH) {
    const batch = rows.slice(i, i + PER_BATCH);
    const params: unknown[] = [];
    const valueRows = batch.map(r => {
      const b = params.length;
      params.push(r.secret, r.day, r.kind, r.id);
      return `($${String(b + 1)}, $${String(b + 2)}::date, $${String(b + 3)}, $${String(b + 4)})`;
    });
    const res = await mainDb.query(
      `INSERT INTO otel_daily_seen (project_secret, day, kind, id)
       VALUES ${valueRows.join(', ')}
       ON CONFLICT (project_secret, day, kind, id) DO NOTHING`,
      params,
    );
    inserted += res.affectedRows ?? 0;
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// HS-9243 (part 2) — backfill per-ticket prompt-duration spans
// (`otel_ticket_prompt_span`) from existing raw, so the HS-9235 read can
// recompute per-ticket duration from the span table (ongoing spans are widened
// at ingest via `widenTicketPromptSpan`). Mirrors getPerTicketRollup's matched
// set (marker UNION time-window) but grouped per (ticket, prompt) → first/last.
// Separate guarded one-shot (`telemetryTicketSpanBackfilledV1`).
// ---------------------------------------------------------------------------

export interface TicketSpanBackfillResult {
  scannedDirs: number;
  /** `otel_ticket_prompt_span` rows written across all dirs. */
  spanRows: number;
}

export async function backfillTelemetryTicketSpans(launchedDataDir: string): Promise<TicketSpanBackfillResult> {
  const empty: TicketSpanBackfillResult = { scannedDirs: 0, spanRows: 0 };
  if (readGlobalConfig().telemetryTicketSpanBackfilledV1 === true) return empty;

  const dirs = [...new Set<string>([launchedDataDir, ...readProjectList(), centralTelemetryDataDir()])];
  const doneDirs = new Set(readGlobalConfig().telemetryTicketSpanBackfillV1DoneDirs ?? []);

  let scannedDirs = 0;
  let spanRows = 0;

  for (const dataDir of dirs) {
    if (doneDirs.has(dataDir)) { scannedDirs++; continue; }
    try {
      const clusterDb = await getDbForDir(telemetryClusterDataDir(dataDir));
      const mainDb = await getDbForDir(dataDir);
      const secret = readProjectSecret(dataDir); // null for central → skipped inside
      spanRows += await backfillTicketPromptSpansForDir(clusterDb, mainDb, secret);
      scannedDirs++;
      doneDirs.add(dataDir);
      writeGlobalConfig({ telemetryTicketSpanBackfillV1DoneDirs: [...doneDirs] });
    } catch (err) {
      console.error(`[ticket-span-backfill] skipping ${dataDir}:`, err);
    }
    await yieldToEventLoop();
  }

  writeGlobalConfig({ telemetryTicketSpanBackfilledV1: true, telemetryTicketSpanBackfillV1DoneDirs: [] });
  console.log(`  [ticket-span-backfill] HS-9243: wrote ${String(spanRows)} ticket-prompt span(s) across ${String(scannedDirs)} dir(s).`);
  return { scannedDirs, spanRows };
}

/**
 * Derive per-(ticket, prompt) first/last ts from one project's raw (the marker
 * UNION time-window matched set, mirroring getPerTicketRollup) and upsert into the
 * main-db span table. Idempotent via `ON CONFLICT` LEAST/GREATEST. Central store
 * (null secret) has no tickets → skipped. Returns the number of rows affected.
 */
export async function backfillTicketPromptSpansForDir(
  clusterDb: PGlite,
  mainDb: PGlite,
  secret: string | null,
): Promise<number> {
  if (secret === null || secret === '') return 0;

  const res = await clusterDb.query<Record<string, unknown>>(
    `WITH marker_prompts AS (
       SELECT DISTINCT prompt_id, substring(body_json::text from 'hotsheet:ticket=([A-Za-z]+-[0-9]+)') AS ticket
       FROM otel_events
       WHERE ${eventNameMatchSql('event_name', 'user_prompt')}
         AND prompt_id IS NOT NULL
         AND body_json::text LIKE '%hotsheet:ticket=%'
     ),
     matched AS (
       -- time-window path
       SELECT i.ticket_number AS ticket, e.prompt_id AS prompt_id, e.ts AS ts
       FROM otel_events e
       JOIN ticket_work_intervals i
         ON i.project_secret = $1
        AND e.ts >= i.started_at AND e.ts <= COALESCE(i.ended_at, NOW())
       WHERE ${eventNameMatchSql('e.event_name', 'api_request')}
         AND e.prompt_id IS NOT NULL AND e.project_secret = $1
       UNION ALL
       -- marker path
       SELECT mp.ticket AS ticket, e.prompt_id AS prompt_id, e.ts AS ts
       FROM otel_events e
       JOIN marker_prompts mp ON mp.prompt_id = e.prompt_id
       WHERE ${eventNameMatchSql('e.event_name', 'api_request')}
         AND e.prompt_id IS NOT NULL
     )
     SELECT ticket, prompt_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts
     FROM matched
     WHERE ticket IS NOT NULL AND prompt_id IS NOT NULL
     GROUP BY ticket, prompt_id`,
    [secret],
  );

  const rows = res.rows
    .map(r => ({ ticket: s(r.ticket, ''), promptId: s(r.prompt_id, ''), firstTs: r.first_ts, lastTs: r.last_ts }))
    .filter(r => r.ticket !== '' && r.promptId !== '' && r.firstTs != null && r.lastTs != null);

  if (rows.length === 0) return 0;

  const PER_BATCH = 300; // 300 × 5 cols = 1500 params, well under 65535.
  let affected = 0;
  for (let i = 0; i < rows.length; i += PER_BATCH) {
    const batch = rows.slice(i, i + PER_BATCH);
    const params: unknown[] = [];
    const valueRows = batch.map(r => {
      const b = params.length;
      params.push(secret, r.ticket, r.promptId, r.firstTs, r.lastTs);
      return `($${String(b + 1)}, $${String(b + 2)}, $${String(b + 3)}, $${String(b + 4)}::timestamptz, $${String(b + 5)}::timestamptz)`;
    });
    const out = await mainDb.query(
      `INSERT INTO otel_ticket_prompt_span (project_secret, ticket_number, prompt_id, first_ts, last_ts)
       VALUES ${valueRows.join(', ')}
       ON CONFLICT (project_secret, ticket_number, prompt_id) DO UPDATE SET
         first_ts = LEAST(otel_ticket_prompt_span.first_ts, EXCLUDED.first_ts),
         last_ts  = GREATEST(otel_ticket_prompt_span.last_ts, EXCLUDED.last_ts)`,
      params,
    );
    affected += out.affectedRows ?? 0;
  }
  return affected;
}
