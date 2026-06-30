import { type PGlite } from '@electric-sql/pglite';

import type { MetricAggregation } from './otelWriters.js';

/**
 * HS-9233 (epic HS-9226 Phase 2) — maintain the compact telemetry ROLLUP tables
 * (`otel_rollup_daily` / `otel_rollup_ticket`, schema in HS-9232) at OTLP ingest
 * time, so the §70/§71 dashboards can later (HS-9235) read aggregates instead of
 * scanning the bulky raw `otel_*` rows.
 *
 * **Where the rows go.** Raw telemetry lives in the un-snapshotted
 * `<dataDir>/telemetry/db` cluster (HS-9230). The rollups instead live in the
 * SNAPSHOTTED main `<dataDir>/db` (HS-9232) — they're tiny, and the per-ticket
 * cost history is kept indefinitely, so it must be backed up. Hence the ingest
 * path passes TWO db handles here: `mainDb` (= `getDbForDir(targetDir)`, where
 * the rollup rows are written) and, for per-ticket attribution, `clusterDb`
 * (where `ticket_work_intervals` lives alongside the raw events).
 *
 * **Dual-write, not replace (yet).** Phase 2 writes rollups IN ADDITION to the
 * raw rows; Phase 3 (HS-9236/9237) moves raw to JSONL and drops the raw tables.
 * Until HS-9235 repoints the dashboard reads, NOTHING reads these rollups — so
 * this change is invisible to the UI and safe to land incrementally.
 *
 * **Parity with the current reads.** The dashboards today simply SUM raw rows
 * (no per-row dedup), so summing the same datapoint values at ingest is
 * behaviorally identical — an OTLP resend double-counts in both the old reads
 * and the new rollups. Cost/token/datapoint sums are therefore EXACT relative to
 * what the dashboards show today. The cumulative-monotonic guard
 * (`isCumulativeMonotonic`) mirrors the reads' `EXCLUDE_CUMULATIVE_MONOTONIC_SQL`
 * so a cumulative counter can't re-inflate the rollup (HS-8599/8600).
 *
 * **Documented gaps (see HS-9234 backfill + HS-9235 repoint, and the follow-ups):**
 *   - `otel_rollup_daily.prompt_count` / `session_count` are DISTINCT counts that
 *     can't be incrementally maintained exactly at ingest (distinct ids don't roll
 *     up across the model/source grain). They're left at their defaults here; the
 *     HS-9234 backfill computes exact historical values via `COUNT(DISTINCT …)`,
 *     and the HS-9235 repoint decides how ongoing counts are sourced.
 *   - `otel_rollup_ticket.duration_seconds` (sum per prompt of max-min ts) isn't
 *     additive at ingest; left at its default here, populated by the backfill.
 *   - Per-ticket attribution uses the TIME-WINDOW path (api_request ts inside an
 *     open `ticket_work_intervals` window) — the dominant agentic-worklist flow.
 *     The marker path (`<!-- hotsheet:ticket=HS-N -->` in a prompt body) is NOT
 *     attributed at ingest (it requires cross-referencing the prompt's earlier
 *     `user_prompt` event); the backfill's UNION covers it for history.
 *   - Daily buckets use the SERVER-LOCAL day at ingest (the maintainer's daily-grain
 *     choice). A server-tz≠viewer-tz mismatch is possible but irrelevant for the
 *     single-user local tool.
 *
 * Every function here is best-effort: ingest must never fail because a rollup
 * update threw. Callers wrap these in try/catch and continue (OTLP returns 200
 * regardless).
 */

/** The two metrics the dashboards SUM and that the daily rollup tracks. */
const COST_METRIC = 'claude_code.cost.usage';
const TOKEN_METRIC = 'claude_code.token.usage';

/** True for the cost/token metrics that the daily time-series rollup tracks. */
export function isRollupMetric(metricName: string): boolean {
  return metricName === COST_METRIC || metricName === TOKEN_METRIC;
}

/**
 * HS-8599/8600 parity — a cumulative monotonic counter carries the running total
 * in every export, so SUMming it re-inflates. The reads exclude these
 * (`EXCLUDE_CUMULATIVE_MONOTONIC_SQL`); the rollup must too.
 */
export function isCumulativeMonotonic(agg: MetricAggregation): boolean {
  return agg.temporality === 'cumulative' && agg.isMonotonic === true;
}

/** Server-local `YYYY-MM-DD` for the daily bucket (the maintainer's grain). */
export function serverLocalDay(ts: Date): string {
  const y = ts.getFullYear();
  const m = String(ts.getMonth() + 1).padStart(2, '0');
  const d = String(ts.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Coerce an OTLP `AnyValue`-unwrapped attribute (already flattened by
 *  `flattenAttributes`) to a non-empty string, else the fallback. */
function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v !== '' ? v : fallback;
}

/** Coerce a numeric-ish attribute / datapoint field to a finite number (OTLP
 *  often encodes integers as decimal strings — matches `(json->>'x')::numeric`). */
function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  return 0;
}

/**
 * Extract a metric data point's numeric value the same way the reads do:
 * `COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)`.
 */
export function dataPointValue(point: Record<string, unknown>): number {
  if (point.asDouble !== undefined && point.asDouble !== null) return num(point.asDouble);
  if (point.asInt !== undefined && point.asInt !== null) return num(point.asInt);
  return 0;
}

type TokenColumn = 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens' | null;

/** Map `claude_code.token.usage`'s `type` attribute to its rollup column. An
 *  unknown / missing type contributes to `datapoint_count` only (matches the
 *  reads, which bucket tokens by `type`). */
function tokenColumnFor(attrs: Record<string, unknown>): TokenColumn {
  const t = attrs['type'];
  if (t === 'input') return 'input_tokens';
  if (t === 'output') return 'output_tokens';
  if (t === 'cacheRead' || t === 'cache_read') return 'cache_read_tokens';
  if (t === 'cacheCreation' || t === 'cache_creation') return 'cache_creation_tokens';
  return null;
}

/**
 * Strip the redundant nested `attributes` array off a serialized OTLP data point
 * (`value_json`) or log record (`body_json`) before it's stored. The flattened
 * `attributes_json` column already holds the same key/values (and is what every
 * stats query reads), so the nested copy is ~40-50% dead weight (HS-9233). Pure;
 * returns a shallow clone so the caller's object is untouched.
 */
export function stripNestedAttributes<T extends Record<string, unknown>>(obj: T): T {
  if (!('attributes' in obj)) return obj;
  const clone = { ...obj };
  delete clone.attributes;
  return clone;
}

/** Match a stored event name against a bare Claude Code event name, tolerating
 *  both the bare (`api_request`) and dotted (`claude_code.api_request`) forms —
 *  mirrors `eventNameMatchSql` / `isClaudeCodeEvent` in otelRollups. */
export function eventNameMatches(stored: string, bare: string): boolean {
  return stored === bare || stored === `claude_code.${bare}`;
}

/**
 * Upsert one cost/token datapoint into the daily time-series rollup. Returns
 * `true` when the row was rolled up, `false` when the datapoint isn't a rollup
 * metric or was excluded (cumulative-monotonic). `secret` is the resource's
 * project secret (`null` for the central store → stored as `''` so the PK is
 * NOT NULL). Best-effort: throws only on a real DB error, which the caller
 * swallows.
 */
export async function updateDailyRollup(
  mainDb: PGlite,
  secret: string | null,
  ts: Date,
  metricName: string,
  value: number,
  attrs: Record<string, unknown>,
  agg: MetricAggregation,
): Promise<boolean> {
  if (!isRollupMetric(metricName)) return false;
  if (isCumulativeMonotonic(agg)) return false;

  const projectSecret = secret ?? '';
  const day = serverLocalDay(ts);
  const model = strOr(attrs['model'], '(unknown)');
  const querySource = strOr(attrs['query.source'], '(unknown)');

  let cost = 0;
  let inputT = 0;
  let outputT = 0;
  let cacheReadT = 0;
  let cacheCreationT = 0;
  if (metricName === COST_METRIC) {
    cost = value;
  } else {
    switch (tokenColumnFor(attrs)) {
      case 'input_tokens': inputT = value; break;
      case 'output_tokens': outputT = value; break;
      case 'cache_read_tokens': cacheReadT = value; break;
      case 'cache_creation_tokens': cacheCreationT = value; break;
      case null: break; // unknown token type → datapoint_count only
    }
  }

  await mainDb.query(
    `INSERT INTO otel_rollup_daily
       (project_secret, day, model, query_source,
        cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, datapoint_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
     ON CONFLICT (project_secret, day, model, query_source) DO UPDATE SET
       cost_usd              = otel_rollup_daily.cost_usd              + EXCLUDED.cost_usd,
       input_tokens          = otel_rollup_daily.input_tokens          + EXCLUDED.input_tokens,
       output_tokens         = otel_rollup_daily.output_tokens         + EXCLUDED.output_tokens,
       cache_read_tokens     = otel_rollup_daily.cache_read_tokens     + EXCLUDED.cache_read_tokens,
       cache_creation_tokens = otel_rollup_daily.cache_creation_tokens + EXCLUDED.cache_creation_tokens,
       datapoint_count       = otel_rollup_daily.datapoint_count       + 1`,
    [projectSecret, day, model, querySource, cost, inputT, outputT, cacheReadT, cacheCreationT],
  );
  return true;
}

/** Cost on an `api_request` event, COALESCEing the attribute-name variants the
 *  read uses (`cost` / `cost_usd`). */
function apiRequestCost(attrs: Record<string, unknown>): number {
  if (attrs['cost'] !== undefined) return num(attrs['cost']);
  if (attrs['cost_usd'] !== undefined) return num(attrs['cost_usd']);
  return 0;
}

/** Tokens on an `api_request` event, COALESCEing the variants the read uses
 *  (`tokens` / `total_tokens` / input+output). */
function apiRequestTokens(attrs: Record<string, unknown>): number {
  if (attrs['tokens'] !== undefined) return num(attrs['tokens']);
  if (attrs['total_tokens'] !== undefined) return num(attrs['total_tokens']);
  const io = num(attrs['input_tokens']) + num(attrs['output_tokens']);
  return io;
}

/**
 * Find the ticket (if any) whose work window covers `ts`, reading
 * `ticket_work_intervals` from the cluster db (where it lives, alongside the raw
 * events). Returns the ticket number or `null`. The window test uses the event
 * `ts` (not `NOW()`), so delayed/batched telemetry still attributes correctly to
 * a since-closed interval.
 */
async function ticketForInstant(clusterDb: PGlite, secret: string, ts: Date): Promise<string | null> {
  const res = await clusterDb.query<{ ticket_number: string }>(
    `SELECT ticket_number FROM ticket_work_intervals
     WHERE project_secret = $1 AND started_at <= $2 AND COALESCE(ended_at, NOW()) >= $2
     ORDER BY started_at DESC LIMIT 1`,
    [secret, ts],
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].ticket_number;
}

/**
 * Attribute one `api_request` event's cost/tokens to the open ticket at `ts`
 * (HS-9233 — the time-window path). No-op for the central store (it has no
 * tickets) or when no ticket window covers `ts`. The `otel_rollup_ticket` row is
 * read-modify-written (single-process sequential ingest, so no race) so the
 * `model_breakdown` JSON map can be merged. Best-effort.
 */
export async function attributeApiRequestToTicket(
  clusterDb: PGlite,
  mainDb: PGlite,
  secret: string | null,
  ts: Date,
  attrs: Record<string, unknown>,
): Promise<void> {
  if (secret === null || secret === '') return; // central store has no tickets
  const ticket = await ticketForInstant(clusterDb, secret, ts);
  if (ticket === null) return;

  const cost = apiRequestCost(attrs);
  const tokens = apiRequestTokens(attrs);
  const model = strOr(attrs['model'], '(unknown)');

  const existing = await mainDb.query<{
    cost_usd: string | number;
    total_tokens: string | number;
    model_breakdown: Record<string, { cost: number; tokens: number }> | string;
  }>(
    `SELECT cost_usd, total_tokens, model_breakdown FROM otel_rollup_ticket
     WHERE project_secret = $1 AND ticket_number = $2`,
    [secret, ticket],
  );

  const prev = existing.rows.length > 0 ? existing.rows[0] : undefined;
  const prevCost = prev !== undefined ? num(prev.cost_usd) : 0;
  const prevTokens = prev !== undefined ? num(prev.total_tokens) : 0;
  const breakdown = parseModelBreakdown(prev?.model_breakdown);
  const entry = breakdown[model] ?? { cost: 0, tokens: 0 };
  entry.cost += cost;
  entry.tokens += tokens;
  breakdown[model] = entry;

  await mainDb.query(
    `INSERT INTO otel_rollup_ticket
       (project_secret, ticket_number, cost_usd, total_tokens, model_breakdown, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (project_secret, ticket_number) DO UPDATE SET
       cost_usd        = $3,
       total_tokens    = $4,
       model_breakdown = $5::jsonb,
       updated_at      = NOW()`,
    [secret, ticket, prevCost + cost, prevTokens + tokens, JSON.stringify(breakdown)],
  );
}

/**
 * Increment a ticket's `prompt_count` for one `user_prompt` event attributed to
 * the open ticket at `ts` (each `user_prompt` is exactly one prompt, so this is
 * exact — unlike counting distinct `prompt_id` over api_request events). No-op
 * for the central store or when no ticket window covers `ts`. Best-effort.
 */
export async function attributeUserPromptToTicket(
  clusterDb: PGlite,
  mainDb: PGlite,
  secret: string | null,
  ts: Date,
): Promise<void> {
  if (secret === null || secret === '') return;
  const ticket = await ticketForInstant(clusterDb, secret, ts);
  if (ticket === null) return;
  await mainDb.query(
    `INSERT INTO otel_rollup_ticket (project_secret, ticket_number, prompt_count, updated_at)
     VALUES ($1, $2, 1, NOW())
     ON CONFLICT (project_secret, ticket_number) DO UPDATE SET
       prompt_count = otel_rollup_ticket.prompt_count + 1,
       updated_at   = NOW()`,
    [secret, ticket],
  );
}

/** Tolerantly parse the `model_breakdown` JSONB (PGlite may hand back a parsed
 *  object or a JSON string depending on the column type). Returns a fresh map. */
function parseModelBreakdown(raw: unknown): Record<string, { cost: number; tokens: number }> {
  const out: Record<string, { cost: number; tokens: number }> = {};
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return out; }
  }
  if (typeof obj !== 'object' || obj === null) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue;
    const vR = v as Record<string, unknown>;
    out[k] = { cost: num(vR.cost), tokens: num(vR.tokens) };
  }
  return out;
}
