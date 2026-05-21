import { getDb } from './connection.js';

/**
 * HS-8148 — rollup queries for the footer drawer Telemetry tab (§67.10.2).
 * All queries run live against the raw `otel_metrics` / `otel_events` /
 * `otel_spans` tables (§67.6 — "no precomputed rollup tables"). At single-
 * user scale the indexed scans return in milliseconds.
 *
 * **Project scoping:** every query takes `projectSecret: string | null`.
 * `null` = "all projects" (the drawer's toolbar toggle). When non-null,
 * adds `WHERE project_secret = $`.
 *
 * **Time windows:** `sinceTs: Date | null` = "since this timestamp."
 * `null` = "all time" (no time filter). Callers pass midnight-local for
 * today's window, midnight-local-minus-7-days for the week window, etc.
 *
 * **Attribute keys we look for** in the JSONB columns:
 *   - `attributes_json->>'model'` — model name (e.g. "claude-sonnet-4")
 *   - `attributes_json->>'query.source'` — main_agent / subagent / auxiliary
 *   - `attributes_json->>'tool_name'` — tool invoked (on tool_result events)
 *   - `attributes_json->>'duration_ms'` — tool duration (when traces off)
 *   - `value_json->>'asDouble'` — metric data-point value (cost / tokens)
 *   - `value_json->>'asInt'` — alt metric value type (token counts)
 *
 * These keys mirror what Claude Code's exporter emits per §67.2. If a
 * future version of Claude Code renames attributes, the queries return
 * empty rows but don't throw — fixed by updating the key names here.
 */

export interface WindowTotals {
  cost: number;
  tokens: number;
  promptCount: number;
}

export interface ModelRollup {
  model: string;
  cost: number;
  tokens: number;
  promptCount: number;
}

export interface ToolRollup {
  tool: string;
  count: number;
  avgDurationMs: number | null;
}

export interface QuerySourceRollup {
  source: string;
  cost: number;
  tokens: number;
  promptCount: number;
}

export interface RecentPrompt {
  promptId: string;
  ts: string;
  projectSecret: string;
  /** Model name from the user_prompt event's attributes, when present. */
  model: string | null;
}

/**
 * Build the WHERE-clause + params tail used by every rollup query.
 * Returns `[clauses, params]` ready to interpolate into the prepared
 * statement. `baseParamCount` is the number of params the caller has
 * already supplied (positional, before these clauses are appended) —
 * so the placeholder indices start at `baseParamCount + 1`. Pass `0`
 * when the rollup query has no leading params (all metric names are
 * literals); pass `1` when the caller passes a single `metric_name`
 * (or event_name) param as `$1`.
 */
function buildProjectAndWindowClauses(
  projectSecret: string | null,
  sinceTs: Date | null,
  tsColumn: string,
  baseParamCount: number,
): { clauses: string; params: Array<string | Date> } {
  const clauses: string[] = [];
  const params: Array<string | Date> = [];
  if (projectSecret !== null) {
    params.push(projectSecret);
    clauses.push(`project_secret = $${String(baseParamCount + params.length)}`);
  }
  if (sinceTs !== null) {
    params.push(sinceTs);
    clauses.push(`${tsColumn} >= $${String(baseParamCount + params.length)}`);
  }
  return { clauses: clauses.length === 0 ? '' : ' AND ' + clauses.join(' AND '), params };
}

/**
 * Window totals: total cost + total tokens + count of distinct prompts
 * over the given window. Cost comes from `claude_code.cost.usage`
 * metric data points; tokens from `claude_code.token.usage`; prompt
 * count from distinct `prompt_id` on `claude_code.user_prompt` events.
 */
export async function getWindowTotals(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<WindowTotals> {
  const db = await getDb();
  const metricsClause = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 1);

  const costResult = await db.query<{ total: string | null }>(
    `SELECT SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1${metricsClause.clauses}`,
    ['claude_code.cost.usage', ...metricsClause.params],
  );
  const tokensResult = await db.query<{ total: string | null }>(
    `SELECT SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1${metricsClause.clauses}`,
    ['claude_code.token.usage', ...metricsClause.params],
  );

  const eventsClause = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 1);
  const promptsResult = await db.query<{ c: bigint | number }>(
    `SELECT COUNT(DISTINCT prompt_id) AS c
     FROM otel_events
     WHERE event_name = $1 AND prompt_id IS NOT NULL${eventsClause.clauses}`,
    ['claude_code.user_prompt', ...eventsClause.params],
  );

  return {
    cost: Number(costResult.rows[0]?.total ?? 0),
    tokens: Number(tokensResult.rows[0]?.total ?? 0),
    promptCount: Number(promptsResult.rows[0]?.c ?? 0),
  };
}

/**
 * Cost by model. Groups `claude_code.cost.usage` data points by the
 * `model` attribute. Returns rows sorted by cost descending.
 */
export async function getCostByModel(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<ModelRollup[]> {
  const db = await getDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0);

  const result = await db.query<{ model: string | null; cost: string; tokens: string; prompt_count: string }>(
    `SELECT
        COALESCE(attributes_json->>'model', '(unknown)') AS model,
        SUM(CASE WHEN metric_name = 'claude_code.cost.usage' THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS cost,
        SUM(CASE WHEN metric_name = 'claude_code.token.usage' THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS tokens,
        COUNT(DISTINCT session_id) AS prompt_count
     FROM otel_metrics
     WHERE metric_name IN ('claude_code.cost.usage', 'claude_code.token.usage')${clauses.clauses}
     GROUP BY attributes_json->>'model'
     ORDER BY cost DESC`,
    clauses.params,
  );
  return result.rows.map(r => ({
    model: r.model ?? '(unknown)',
    cost: Number(r.cost),
    tokens: Number(r.tokens),
    promptCount: Number(r.prompt_count),
  }));
}

/**
 * Tool usage rollup. Counts tool_result events grouped by tool name
 * + averages duration. Cost contribution per-tool isn't directly
 * derivable (cost metric isn't tagged with tool_name) — left as null
 * for v1; a future revision could compute it from spans (HS-8155).
 */
export async function getToolRollup(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<ToolRollup[]> {
  const db = await getDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0);

  const result = await db.query<{ tool: string | null; c: bigint | number; avg_ms: string | null }>(
    `SELECT
        COALESCE(attributes_json->>'tool_name', attributes_json->>'name', '(unknown)') AS tool,
        COUNT(*) AS c,
        AVG((attributes_json->>'duration_ms')::numeric) FILTER (WHERE attributes_json->>'duration_ms' IS NOT NULL) AS avg_ms
     FROM otel_events
     WHERE event_name = 'claude_code.tool_result'${clauses.clauses}
     GROUP BY tool
     ORDER BY c DESC`,
    clauses.params,
  );
  return result.rows.map(r => ({
    tool: r.tool ?? '(unknown)',
    count: Number(r.c),
    avgDurationMs: r.avg_ms !== null ? Number(r.avg_ms) : null,
  }));
}

/**
 * Cost / tokens by query source. The `query.source` attribute on
 * Claude Code metrics distinguishes main-agent / subagent / auxiliary
 * work; this helps users understand subagent overhead.
 */
export async function getQuerySourceRollup(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<QuerySourceRollup[]> {
  const db = await getDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0);

  const result = await db.query<{ source: string | null; cost: string; tokens: string; prompt_count: string }>(
    `SELECT
        COALESCE(attributes_json->>'query.source', '(unknown)') AS source,
        SUM(CASE WHEN metric_name = 'claude_code.cost.usage' THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS cost,
        SUM(CASE WHEN metric_name = 'claude_code.token.usage' THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS tokens,
        COUNT(DISTINCT session_id) AS prompt_count
     FROM otel_metrics
     WHERE metric_name IN ('claude_code.cost.usage', 'claude_code.token.usage')${clauses.clauses}
     GROUP BY attributes_json->>'query.source'
     ORDER BY cost DESC`,
    clauses.params,
  );
  return result.rows.map(r => ({
    source: r.source ?? '(unknown)',
    cost: Number(r.cost),
    tokens: Number(r.tokens),
    promptCount: Number(r.prompt_count),
  }));
}

/**
 * Recent prompts list. Returns the last `limit` `claude_code.user_prompt`
 * events, newest first. Lightweight — just the headline row data the
 * drawer renders. The per-prompt drilldown (HS-8149) fetches the full
 * timeline lazily on click.
 */
export async function getRecentPrompts(
  projectSecret: string | null,
  limit: number,
): Promise<RecentPrompt[]> {
  const db = await getDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, null, 'ts', 1);
  // Clamp limit to a sane bound — caller validates but defense-in-depth.
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));

  const result = await db.query<{ prompt_id: string; ts: string; project_secret: string; model: string | null }>(
    `SELECT
        prompt_id,
        ts,
        project_secret,
        attributes_json->>'model' AS model
     FROM otel_events
     WHERE event_name = $1 AND prompt_id IS NOT NULL${clauses.clauses}
     ORDER BY ts DESC
     LIMIT ${String(safeLimit)}`,
    ['claude_code.user_prompt', ...clauses.params],
  );
  return result.rows.map(r => ({
    promptId: r.prompt_id,
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
    projectSecret: r.project_secret,
    model: r.model,
  }));
}

/**
 * HS-8147 — cheap "today's cost" query for the per-project tab cost
 * chip. Equivalent to `getWindowTotals(secret, midnight).cost` but
 * returns just the number, no tokens / prompt count overhead. Used
 * on the bell-state poll cadence so it has to be fast — single
 * indexed SUM over `(project_secret, ts DESC)`.
 */
export async function getTodayCost(projectSecret: string): Promise<number> {
  const db = await getDb();
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const result = await db.query<{ total: string | null }>(
    `SELECT SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1 AND project_secret = $2 AND ts >= $3`,
    ['claude_code.cost.usage', projectSecret, midnight],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * HS-8150 — per-tool latency histogram (§67.10.5). For each tool the
 * user has invoked in the selected window, returns count + total ms
 * + p50/p90/p99 percentiles + bucket counts for the inline-SVG bars.
 *
 * Bucket scheme: logarithmic, 8 buckets covering 0ms→10s+:
 *   [0,10), [10,50), [50,100), [100,500), [500,1000), [1000,5000), [5000,10000), [10000,∞)
 * Logarithmic spacing because tool durations span orders of magnitude
 * (a `Read` is sub-ms; an MCP tool that does network can be 5s+) and
 * linear buckets would put 99% of mass in one bin.
 *
 * Source: `claude_code.tool_result` events' `attributes_json.duration_ms`.
 * §67.10.5 mentions falling back to `otel_spans` when traces aren't
 * enabled; we prefer events because they're always-on (metrics + logs
 * are the §67.7 default cadence; traces are beta-only). Spans-based
 * histogram could be a follow-up if richer per-span breakdowns matter.
 */
export interface ToolLatencyHistogram {
  tool: string;
  count: number;
  totalMs: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  /** Bucket counts in the logarithmic scheme described above. */
  buckets: number[];
}

const HISTOGRAM_BUCKET_UPPER_MS = [10, 50, 100, 500, 1000, 5000, 10000];
const HISTOGRAM_BUCKET_LABELS = ['<10ms', '10-50ms', '50-100ms', '100-500ms', '500ms-1s', '1-5s', '5-10s', '10s+'];

export async function getToolLatencyHistogram(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<ToolLatencyHistogram[]> {
  const db = await getDb();

  // HS-8478 — prefer `otel_spans` when traces are enabled. Probe for
  // at least one `claude_code.tool.*` span in the project + window; if
  // present, source the histogram from spans (higher-fidelity duration,
  // measured by the runtime instead of the tool reporting it). When no
  // spans exist (the common non-beta case), fall back to the events-
  // based path which has been the source since HS-8150.
  const probeClauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'start_ts', 0);
  const probe = await db.query<{ x: number }>(
    `SELECT 1 AS x FROM otel_spans
     WHERE span_name LIKE 'claude_code.tool.%'${probeClauses.clauses}
     LIMIT 1`,
    probeClauses.params,
  );
  const useSpans = probe.rows.length > 0;

  if (useSpans) {
    return getToolLatencyHistogramFromSpans(projectSecret, sinceTs);
  }
  return getToolLatencyHistogramFromEvents(projectSecret, sinceTs);
}

async function getToolLatencyHistogramFromEvents(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<ToolLatencyHistogram[]> {
  const db = await getDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0);

  // First query: count + total + p50/p90/p99 per tool. PostgreSQL's
  // `percentile_cont(p) WITHIN GROUP (ORDER BY col)` interpolates;
  // exact enough for visual percentile markers.
  const stats = await db.query<{
    tool: string | null;
    c: bigint | number;
    total_ms: string | null;
    p50: string | null;
    p90: string | null;
    p99: string | null;
  }>(
    `SELECT
        COALESCE(attributes_json->>'tool_name', attributes_json->>'name', '(unknown)') AS tool,
        COUNT(*) AS c,
        SUM((attributes_json->>'duration_ms')::numeric) AS total_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY (attributes_json->>'duration_ms')::numeric) AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY (attributes_json->>'duration_ms')::numeric) AS p90,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY (attributes_json->>'duration_ms')::numeric) AS p99
     FROM otel_events
     WHERE event_name = 'claude_code.tool_result'
       AND attributes_json->>'duration_ms' IS NOT NULL${clauses.clauses}
     GROUP BY tool
     ORDER BY c DESC`,
    clauses.params,
  );

  if (stats.rows.length === 0) return [];

  // Second query: bucket counts per tool. Uses a CASE expression to
  // map each duration into its bucket index. One row per (tool, bucket)
  // — we densify to fixed-size arrays in JS.
  const bucketsResult = await db.query<{ tool: string; bucket: number; c: bigint | number }>(
    `SELECT
        COALESCE(attributes_json->>'tool_name', attributes_json->>'name', '(unknown)') AS tool,
        CASE
          WHEN (attributes_json->>'duration_ms')::numeric < 10 THEN 0
          WHEN (attributes_json->>'duration_ms')::numeric < 50 THEN 1
          WHEN (attributes_json->>'duration_ms')::numeric < 100 THEN 2
          WHEN (attributes_json->>'duration_ms')::numeric < 500 THEN 3
          WHEN (attributes_json->>'duration_ms')::numeric < 1000 THEN 4
          WHEN (attributes_json->>'duration_ms')::numeric < 5000 THEN 5
          WHEN (attributes_json->>'duration_ms')::numeric < 10000 THEN 6
          ELSE 7
        END AS bucket,
        COUNT(*) AS c
     FROM otel_events
     WHERE event_name = 'claude_code.tool_result'
       AND attributes_json->>'duration_ms' IS NOT NULL${clauses.clauses}
     GROUP BY tool, bucket
     ORDER BY tool, bucket`,
    clauses.params,
  );

  // Densify into a per-tool bucket array of fixed length 8.
  const bucketsByTool = new Map<string, number[]>();
  for (const row of bucketsResult.rows) {
    let arr = bucketsByTool.get(row.tool);
    if (arr === undefined) {
      arr = new Array<number>(8).fill(0);
      bucketsByTool.set(row.tool, arr);
    }
    arr[row.bucket] = Number(row.c);
  }

  return stats.rows.map(r => ({
    tool: r.tool ?? '(unknown)',
    count: Number(r.c),
    totalMs: Number(r.total_ms ?? 0),
    p50: r.p50 !== null ? Number(r.p50) : null,
    p90: r.p90 !== null ? Number(r.p90) : null,
    p99: r.p99 !== null ? Number(r.p99) : null,
    buckets: bucketsByTool.get(r.tool ?? '(unknown)') ?? new Array<number>(8).fill(0),
  }));
}

/**
 * HS-8478 — spans-based variant. Source = `otel_spans` rows whose
 * `span_name` matches `claude_code.tool.%`. Tool name is the suffix
 * after `claude_code.tool.` (e.g. `claude_code.tool.bash` → `bash`).
 * Duration computed as `EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000`
 * — higher fidelity than the event-based `duration_ms` attribute since
 * it's measured at the span boundary by the runtime instead of being
 * self-reported by the tool wrapper.
 */
async function getToolLatencyHistogramFromSpans(
  projectSecret: string | null,
  sinceTs: Date | null,
): Promise<ToolLatencyHistogram[]> {
  const db = await getDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'start_ts', 0);

  const stats = await db.query<{
    tool: string;
    c: bigint | number;
    total_ms: string | null;
    p50: string | null;
    p90: string | null;
    p99: string | null;
  }>(
    `SELECT
        SUBSTRING(span_name FROM 18) AS tool,
        COUNT(*) AS c,
        SUM(EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000) AS total_ms,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000) AS p50,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000) AS p90,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000) AS p99
     FROM otel_spans
     WHERE span_name LIKE 'claude_code.tool.%'${clauses.clauses}
     GROUP BY tool
     ORDER BY c DESC`,
    clauses.params,
  );

  if (stats.rows.length === 0) return [];

  const bucketsResult = await db.query<{ tool: string; bucket: number; c: bigint | number }>(
    `SELECT
        SUBSTRING(span_name FROM 18) AS tool,
        CASE
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 10 THEN 0
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 50 THEN 1
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 100 THEN 2
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 500 THEN 3
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 1000 THEN 4
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 5000 THEN 5
          WHEN EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000 < 10000 THEN 6
          ELSE 7
        END AS bucket,
        COUNT(*) AS c
     FROM otel_spans
     WHERE span_name LIKE 'claude_code.tool.%'${clauses.clauses}
     GROUP BY tool, bucket
     ORDER BY tool, bucket`,
    clauses.params,
  );

  const bucketsByTool = new Map<string, number[]>();
  for (const row of bucketsResult.rows) {
    let arr = bucketsByTool.get(row.tool);
    if (arr === undefined) {
      arr = new Array<number>(8).fill(0);
      bucketsByTool.set(row.tool, arr);
    }
    arr[row.bucket] = Number(row.c);
  }

  return stats.rows.map(r => ({
    tool: r.tool,
    count: Number(r.c),
    totalMs: Number(r.total_ms ?? 0),
    p50: r.p50 !== null ? Number(r.p50) : null,
    p90: r.p90 !== null ? Number(r.p90) : null,
    p99: r.p99 !== null ? Number(r.p99) : null,
    buckets: bucketsByTool.get(r.tool) ?? new Array<number>(8).fill(0),
  }));
}

/** HS-8150 — bucket labels for the inline-SVG renderer. Re-exported
 *  for the client so it doesn't have to hard-code the boundary set. */
export const TOOL_LATENCY_BUCKET_LABELS = HISTOGRAM_BUCKET_LABELS;
// Re-exported so eslint doesn't strip the const after lint-fix passes.
export const TOOL_LATENCY_BUCKET_UPPER_MS = HISTOGRAM_BUCKET_UPPER_MS;

/**
 * HS-8147 — bulk variant. Returns `{secret → cost}` for every project
 * with any cost today, all in one round trip. Polled on the
 * bell-state cadence so the chip stays cheap to refresh.
 *
 * Projects not in the result map have zero cost (the chip is hidden
 * entirely in that case per §67.10.1 — chip rendered only when
 * `cost > 0`).
 */
export async function getTodayCostByProject(): Promise<Record<string, number>> {
  const db = await getDb();
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const result = await db.query<{ project_secret: string; total: string | null }>(
    `SELECT project_secret, SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1 AND ts >= $2
     GROUP BY project_secret
     HAVING SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) > 0`,
    ['claude_code.cost.usage', midnight],
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) {
    out[row.project_secret] = Number(row.total ?? 0);
  }
  return out;
}

/**
 * HS-8149 — per-prompt timeline query. Returns every event correlated
 * by `prompt_id` in start-ts order. The drilldown modal renders each
 * row as a timeline entry; clicking expands to show `attributes_json`
 * + `body_json` verbatim for debugging.
 */
export interface PromptTimelineEntry {
  id: number;
  ts: string;
  eventName: string;
  attributesJson: Record<string, unknown>;
  bodyJson: Record<string, unknown> | null;
}

export interface PromptTimeline {
  promptId: string;
  /** Project secret of the first event in the timeline — used to
   *  display a project-name badge in the drilldown header. */
  projectSecret: string | null;
  /** Earliest ts among the entries — the "prompt fired at" timestamp. */
  firstTs: string | null;
  /** Latest ts among the entries — the "prompt last activity" timestamp. */
  lastTs: string | null;
  /** Best-effort model name pulled from the first user_prompt event's
   *  attributes (when present). */
  model: string | null;
  entries: PromptTimelineEntry[];
  /** HS-8475 / §68.4 — every `otel_spans` row tagged with this prompt
   *  id, ordered by `start_ts ASC`. Empty when traces are off or the
   *  prompt happened to land before traces were enabled. The §68.5.1
   *  drilldown switches its body to a recursive span tree when this
   *  array is non-empty. */
  spans: SpanRow[];
}

/** HS-8475 / §68.4 — raw `otel_spans` row shape returned by
 *  `getPromptTimeline`. The client-side `assembleSpanTree` helper
 *  in `src/client/spanTree.ts` builds the parent-child tree from
 *  these rows. */
export interface SpanRow {
  id: number;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  spanName: string;
  startTs: string;
  endTs: string;
  attributesJson: Record<string, unknown>;
  statusCode: string | null;
}

export async function getPromptTimeline(promptId: string): Promise<PromptTimeline> {
  const db = await getDb();
  const [eventsResult, spansResult] = await Promise.all([
    db.query<{
      id: number;
      ts: string;
      project_secret: string;
      event_name: string;
      attributes_json: Record<string, unknown> | null;
      body_json: Record<string, unknown> | null;
    }>(
      `SELECT id, ts, project_secret, event_name, attributes_json, body_json
       FROM otel_events
       WHERE prompt_id = $1
       ORDER BY ts ASC, id ASC`,
      [promptId],
    ),
    db.query<{
      id: number;
      trace_id: string;
      span_id: string;
      parent_span_id: string | null;
      span_name: string;
      start_ts: string;
      end_ts: string;
      attributes_json: Record<string, unknown> | null;
      status_code: string | null;
    }>(
      `SELECT id, trace_id, span_id, parent_span_id, span_name, start_ts, end_ts, attributes_json, status_code
       FROM otel_spans
       WHERE prompt_id = $1
       ORDER BY start_ts ASC, id ASC`,
      [promptId],
    ),
  ]);

  const spans: SpanRow[] = spansResult.rows.map(r => ({
    id: r.id,
    traceId: r.trace_id,
    spanId: r.span_id,
    parentSpanId: r.parent_span_id,
    spanName: r.span_name,
    startTs: typeof r.start_ts === 'string' ? r.start_ts : new Date(r.start_ts).toISOString(),
    endTs: typeof r.end_ts === 'string' ? r.end_ts : new Date(r.end_ts).toISOString(),
    attributesJson: r.attributes_json ?? {},
    statusCode: r.status_code,
  }));

  if (eventsResult.rows.length === 0) {
    return { promptId, projectSecret: null, firstTs: null, lastTs: null, model: null, entries: [], spans };
  }

  const entries: PromptTimelineEntry[] = eventsResult.rows.map(r => ({
    id: r.id,
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
    eventName: r.event_name,
    attributesJson: r.attributes_json ?? {},
    bodyJson: r.body_json,
  }));

  // Pull model from the first user_prompt event's attributes when present.
  const userPromptEntry = entries.find(e => e.eventName === 'claude_code.user_prompt');
  const model = userPromptEntry !== undefined && typeof userPromptEntry.attributesJson['model'] === 'string'
    ? userPromptEntry.attributesJson['model']
    : null;

  return {
    promptId,
    projectSecret: eventsResult.rows[0].project_secret,
    firstTs: entries[0].ts,
    lastTs: entries[entries.length - 1].ts,
    model,
    entries,
    spans,
  };
}

/**
 * HS-8152 / §67.10.7 — per-ticket cost rollup. Returns aggregate
 * cost / tokens / prompt count / total duration attributed to a
 * given Hot Sheet ticket number via the HS-8151 marker mechanism.
 *
 * Attribution path: when Hot Sheet's channel-trigger flow fires with
 * an active ticket, the client (in `triggerChannelAndMarkBusy`)
 * prepends `<!-- hotsheet:ticket=HS-NNNN -->` to the prompt message.
 * Claude Code captures the user's prompt verbatim, so the marker
 * lands in the `claude_code.user_prompt` event's body. This query
 * uses a string-LIKE match against `body_json` to find tagged
 * prompts + then joins on `prompt_id` to sum the cost/tokens from
 * `claude_code.api_request` events (which carry the per-LLM-call
 * cost + token attributes).
 *
 * The LIKE is fast in practice because the marker is rare in
 * arbitrary text + the events table is bounded by retention (§67.6).
 * If a future user reports slow per-ticket rollups, migrate to a
 * dedicated `ticket_id` column on `otel_events` (the HS-8151 design
 * note's "Option B" — schema bump, indexable).
 */
export interface TicketRollup {
  ticketNumber: string;
  promptCount: number;
  totalCost: number;
  totalTokens: number;
  /** Total wall-clock duration across the tagged prompts, in seconds.
   *  Derived as the sum of `(lastEventTs - firstEventTs)` per prompt
   *  — represents "time Claude spent working on this ticket" rather
   *  than the user's calendar time. */
  totalDurationSeconds: number;
}

export async function getPerTicketRollup(ticketNumber: string): Promise<TicketRollup> {
  const db = await getDb();

  // The marker substring we LIKE for. Same format the client
  // injects in `channelUI.tsx::tagMessageWithActiveTicket`.
  const marker = `hotsheet:ticket=${ticketNumber}`;

  // Find every prompt id whose user_prompt event body carries the
  // marker. Body_json is JSONB; LIKE on the cast-to-text matches
  // anywhere in the serialized form (including inside the body
  // string field).
  const tagged = await db.query<{ prompt_id: string }>(
    `SELECT DISTINCT prompt_id FROM otel_events
     WHERE event_name = $1
       AND prompt_id IS NOT NULL
       AND body_json::text LIKE $2`,
    ['claude_code.user_prompt', `%${marker}%`],
  );

  if (tagged.rows.length === 0) {
    return { ticketNumber, promptCount: 0, totalCost: 0, totalTokens: 0, totalDurationSeconds: 0 };
  }

  const promptIds = tagged.rows.map(r => r.prompt_id);

  // Sum cost + tokens from api_request events for the tagged prompts.
  // The per-LLM-call attributes Claude Code emits on api_request
  // include `cost` (USD) and `tokens` (total). Different versions of
  // Claude Code may name them differently; this query is permissive +
  // tries common variants via COALESCE.
  const sumsResult = await db.query<{ total_cost: string | null; total_tokens: string | null }>(
    `SELECT
        SUM(COALESCE(
          (attributes_json->>'cost')::numeric,
          (attributes_json->>'cost_usd')::numeric,
          0
        )) AS total_cost,
        SUM(COALESCE(
          (attributes_json->>'tokens')::numeric,
          (attributes_json->>'total_tokens')::numeric,
          (attributes_json->>'input_tokens')::numeric + (attributes_json->>'output_tokens')::numeric,
          0
        )) AS total_tokens
     FROM otel_events
     WHERE event_name = 'claude_code.api_request'
       AND prompt_id = ANY($1::text[])`,
    [promptIds],
  );

  // Per-prompt wall-clock duration (last event ts - first event ts),
  // summed across every tagged prompt.
  const durationsResult = await db.query<{ total_seconds: string | null }>(
    `SELECT SUM(EXTRACT(EPOCH FROM (max_ts - min_ts))) AS total_seconds
     FROM (
       SELECT MIN(ts) AS min_ts, MAX(ts) AS max_ts
       FROM otel_events
       WHERE prompt_id = ANY($1::text[])
       GROUP BY prompt_id
     ) AS per_prompt`,
    [promptIds],
  );

  return {
    ticketNumber,
    promptCount: promptIds.length,
    totalCost: Number(sumsResult.rows[0]?.total_cost ?? 0),
    totalTokens: Number(sumsResult.rows[0]?.total_tokens ?? 0),
    totalDurationSeconds: Number(durationsResult.rows[0]?.total_seconds ?? 0),
  };
}

/**
 * Combined drawer payload — one round trip returns every section the
 * footer drawer Telemetry tab renders. The drawer triggers a refetch
 * on tab activation + on every export-tick poll; bundling reduces
 * the number of round-trips.
 */
export interface DrawerPayload {
  today: WindowTotals;
  thisWeek: WindowTotals;
  allTime: WindowTotals;
  costByModel: ModelRollup[];
  toolRollup: ToolRollup[];
  toolLatencyHistogram: ToolLatencyHistogram[];
  querySourceRollup: QuerySourceRollup[];
  recentPrompts: RecentPrompt[];
}

export async function getDrawerPayload(
  projectSecret: string | null,
): Promise<DrawerPayload> {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(midnight.getTime() - 6 * 24 * 60 * 60 * 1000);

  const [today, thisWeek, allTime, costByModel, toolRollup, toolLatencyHistogram, querySourceRollup, recentPrompts] = await Promise.all([
    getWindowTotals(projectSecret, midnight),
    getWindowTotals(projectSecret, weekStart),
    getWindowTotals(projectSecret, null),
    getCostByModel(projectSecret, null),
    getToolRollup(projectSecret, null),
    getToolLatencyHistogram(projectSecret, null),
    getQuerySourceRollup(projectSecret, null),
    getRecentPrompts(projectSecret, 50),
  ]);

  return { today, thisWeek, allTime, costByModel, toolRollup, toolLatencyHistogram, querySourceRollup, recentPrompts };
}

/**
 * HS-8480 — cross-project rollup queries for the global Telemetry
 * dashboard view (§69.3 / docs/69-telemetry-dashboard.md). These are
 * always cross-project — no `projectSecret` parameter; the dashboard
 * is explicitly the "all projects" surface.
 */

export interface ProjectCostRow {
  projectSecret: string;
  cost: number;
  tokens: number;
  promptCount: number;
  /** Latest activity ts across this project's metrics in the window. */
  lastActivityTs: string | null;
}

/**
 * Cost-by-project: one row per project that has any cost-bearing
 * `claude_code.cost.usage` data points in the window. Tokens come
 * from `claude_code.token.usage` over the same per-project group;
 * promptCount is distinct `prompt_id` count over `user_prompt` events.
 * `lastActivityTs` is the latest metric ts in the window.
 *
 * Three subqueries grouped by project_secret + a single client-side
 * merge so the SQL stays straightforward — at single-user scale the
 * three indexed scans each return in well under 10 ms per §67.6's
 * "no precomputed rollup tables" decision.
 */
export async function getCostByProject(sinceTs: Date | null): Promise<ProjectCostRow[]> {
  const db = await getDb();
  const tsClause = sinceTs === null ? '' : ' AND ts >= $2';
  const tsParams: Array<string | Date> = sinceTs === null ? [] : [sinceTs];

  const [costResult, tokensResult, promptsResult, lastTsResult] = await Promise.all([
    db.query<{ project_secret: string; total: string | null }>(
      `SELECT project_secret, SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}
       GROUP BY project_secret`,
      ['claude_code.cost.usage', ...tsParams],
    ),
    db.query<{ project_secret: string; total: string | null }>(
      `SELECT project_secret, SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}
       GROUP BY project_secret`,
      ['claude_code.token.usage', ...tsParams],
    ),
    db.query<{ project_secret: string; c: bigint | number }>(
      `SELECT project_secret, COUNT(DISTINCT prompt_id) AS c
       FROM otel_events
       WHERE event_name = $1 AND prompt_id IS NOT NULL${tsClause}
       GROUP BY project_secret`,
      ['claude_code.user_prompt', ...tsParams],
    ),
    db.query<{ project_secret: string; last_ts: string }>(
      `SELECT project_secret, MAX(ts) AS last_ts
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}
       GROUP BY project_secret`,
      ['claude_code.cost.usage', ...tsParams],
    ),
  ]);

  // Merge by project_secret. Cost-row is the primary key set — projects
  // with no cost in the window don't appear even if they have tokens
  // or prompts.
  const byProject = new Map<string, ProjectCostRow>();
  for (const r of costResult.rows) {
    byProject.set(r.project_secret, {
      projectSecret: r.project_secret,
      cost: Number(r.total ?? 0),
      tokens: 0,
      promptCount: 0,
      lastActivityTs: null,
    });
  }
  for (const r of tokensResult.rows) {
    const row = byProject.get(r.project_secret);
    if (row !== undefined) row.tokens = Number(r.total ?? 0);
  }
  for (const r of promptsResult.rows) {
    const row = byProject.get(r.project_secret);
    if (row !== undefined) row.promptCount = Number(r.c);
  }
  for (const r of lastTsResult.rows) {
    const row = byProject.get(r.project_secret);
    if (row !== undefined) {
      row.lastActivityTs = typeof r.last_ts === 'string' ? r.last_ts : new Date(r.last_ts).toISOString();
    }
  }
  return Array.from(byProject.values()).sort((a, b) => b.cost - a.cost);
}

export interface HourlyActivityCell {
  /** Day of week, 0 = Sunday … 6 = Saturday (PostgreSQL EXTRACT(DOW) convention). */
  dow: number;
  /** Hour of day, 0 → 23. */
  hour: number;
  cost: number;
  promptCount: number;
}

/**
 * 7×24 hourly activity heatmap. Cells densified client-side so the
 * 168-entry array always contains every (dow, hour) combination
 * regardless of whether data exists for that bucket. Server-side
 * uses PG's `EXTRACT(DOW … AT TIME ZONE …)` against the user's
 * local timezone (passed in `timezone`) so the buckets match the
 * user's clock.
 *
 * `timezone` defaults to `UTC` for tests + headless usage; the
 * dashboard endpoint resolves the user's timezone from the
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` value (passed
 * as a query parameter from the client so the server doesn't have
 * to guess).
 */
export async function getHourlyActivityHeatmap(
  sinceTs: Date | null,
  timezone = 'UTC',
): Promise<HourlyActivityCell[]> {
  const db = await getDb();
  const tsClause = sinceTs === null ? '' : ' AND ts >= $3';
  const tsParams: Array<string | Date> = sinceTs === null ? [] : [sinceTs];

  // Cost per (dow, hour) bucket.
  const costResult = await db.query<{ dow: string | number; hour: string | number; total: string | null }>(
    `SELECT
        EXTRACT(DOW FROM ts AT TIME ZONE $2)::int AS dow,
        EXTRACT(HOUR FROM ts AT TIME ZONE $2)::int AS hour,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1${tsClause}
     GROUP BY dow, hour`,
    ['claude_code.cost.usage', timezone, ...tsParams],
  );

  // Distinct-prompt count per (dow, hour) bucket.
  const promptsClause = sinceTs === null ? '' : ' AND ts >= $3';
  const promptsResult = await db.query<{ dow: string | number; hour: string | number; c: bigint | number }>(
    `SELECT
        EXTRACT(DOW FROM ts AT TIME ZONE $2)::int AS dow,
        EXTRACT(HOUR FROM ts AT TIME ZONE $2)::int AS hour,
        COUNT(DISTINCT prompt_id) AS c
     FROM otel_events
     WHERE event_name = $1 AND prompt_id IS NOT NULL${promptsClause}
     GROUP BY dow, hour`,
    ['claude_code.user_prompt', timezone, ...tsParams],
  );

  // Densify to 168 entries — every (dow, hour) combination.
  const cells: HourlyActivityCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({ dow, hour, cost: 0, promptCount: 0 });
    }
  }
  for (const r of costResult.rows) {
    const dow = Number(r.dow);
    const hour = Number(r.hour);
    const idx = dow * 24 + hour;
    if (idx >= 0 && idx < 168) cells[idx].cost = Number(r.total ?? 0);
  }
  for (const r of promptsResult.rows) {
    const dow = Number(r.dow);
    const hour = Number(r.hour);
    const idx = dow * 24 + hour;
    if (idx >= 0 && idx < 168) cells[idx].promptCount = Number(r.c);
  }
  return cells;
}

export interface TopPromptRow {
  promptId: string;
  ts: string;
  projectSecret: string;
  cost: number;
  model: string | null;
  /** First-line preview pulled from `user_prompt.body_json.prompt_preview`
   *  or `body_json.prompt` when present (Claude Code emits both shapes
   *  across versions); truncated to 80 chars. `null` when neither key
   *  exists in the body. */
  preview: string | null;
}

/**
 * Top-N most expensive prompts across every project. Joins per-prompt
 * cost sums (from `claude_code.api_request` events that carry the
 * cost attribute) against the `claude_code.user_prompt` event for
 * the preview text + model.
 */
export async function getTopExpensivePrompts(
  sinceTs: Date | null,
  limit = 10,
): Promise<TopPromptRow[]> {
  const db = await getDb();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const tsClause = sinceTs === null ? '' : ' AND ts >= $2';
  const tsParams: Array<string | Date> = sinceTs === null ? [] : [sinceTs];

  // Sum per-prompt cost from api_request events (the same source
  // getPerTicketRollup uses). Use COALESCE across the common attribute-
  // name variants so a Claude Code rename doesn't break the query.
  const result = await db.query<{
    prompt_id: string;
    project_secret: string;
    cost: string | null;
    first_ts: string;
  }>(
    `SELECT
        prompt_id,
        MIN(project_secret) AS project_secret,
        SUM(COALESCE((attributes_json->>'cost')::numeric, (attributes_json->>'cost_usd')::numeric, 0)) AS cost,
        MIN(ts) AS first_ts
     FROM otel_events
     WHERE event_name = $1 AND prompt_id IS NOT NULL${tsClause}
     GROUP BY prompt_id
     HAVING SUM(COALESCE((attributes_json->>'cost')::numeric, (attributes_json->>'cost_usd')::numeric, 0)) > 0
     ORDER BY cost DESC
     LIMIT ${String(safeLimit)}`,
    ['claude_code.api_request', ...tsParams],
  );

  if (result.rows.length === 0) return [];

  // Pull model + preview from the user_prompt event for each top prompt.
  const promptIds = result.rows.map(r => r.prompt_id);
  const promptParams = promptIds.map((_, i) => `$${String(i + 2)}`).join(', ');
  const userPromptsResult = await db.query<{
    prompt_id: string;
    model: string | null;
    body_json: Record<string, unknown> | null;
  }>(
    `SELECT prompt_id, attributes_json->>'model' AS model, body_json
     FROM otel_events
     WHERE event_name = $1 AND prompt_id IN (${promptParams})`,
    ['claude_code.user_prompt', ...promptIds],
  );
  const byPromptId = new Map<string, { model: string | null; preview: string | null }>();
  for (const r of userPromptsResult.rows) {
    const body = r.body_json ?? {};
    const previewRaw = typeof body['prompt_preview'] === 'string'
      ? body['prompt_preview']
      : typeof body['prompt'] === 'string' ? body['prompt'] : null;
    const preview = previewRaw === null ? null : previewRaw.split('\n')[0].slice(0, 80);
    byPromptId.set(r.prompt_id, { model: r.model, preview });
  }

  return result.rows.map(r => {
    const meta = byPromptId.get(r.prompt_id) ?? { model: null, preview: null };
    return {
      promptId: r.prompt_id,
      ts: typeof r.first_ts === 'string' ? r.first_ts : new Date(r.first_ts).toISOString(),
      projectSecret: r.project_secret,
      cost: Number(r.cost ?? 0),
      model: meta.model,
      preview: meta.preview,
    };
  });
}

/**
 * Window enum for the dashboard endpoint. Resolves to a `Date | null`
 * sinceTs in the user's local time:
 *   - `today` → midnight local
 *   - `week` → midnight 6 days ago (start-of-week, ISO-flexible)
 *   - `month` → midnight 30 days ago (trailing 30 days, not calendar month)
 *   - `90d` → midnight 89 days ago (trailing 90 days)
 *   - `all` → null (no time filter)
 */
export type DashboardWindow = 'today' | 'week' | 'month' | '90d' | 'all';

export function resolveDashboardWindowSinceTs(window: DashboardWindow, now: Date = new Date()): Date | null {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (window === 'today') return midnight;
  if (window === 'week') return new Date(midnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  if (window === 'month') return new Date(midnight.getTime() - 29 * 24 * 60 * 60 * 1000);
  if (window === '90d') return new Date(midnight.getTime() - 89 * 24 * 60 * 60 * 1000);
  return null;
}

export interface DashboardPayload {
  window: DashboardWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByProject: ProjectCostRow[];
  costByModel: ModelRollup[];
  hourlyActivity: HourlyActivityCell[];
  topExpensivePrompts: TopPromptRow[];
}

/**
 * Bundled dashboard payload — one round-trip + one error point for
 * the §69.3 cross-project dashboard view. Matches the drawer-tab
 * `getDrawerPayload` precedent.
 *
 * `windowTotals` always carries today / week / month / allTime
 * regardless of the selected `window` because the three chips at
 * the top of the dashboard always show all three breakdowns. The
 * `window` parameter narrows the cost-by-project / cost-by-model /
 * heatmap / top-prompts sections.
 */
export async function getDashboardPayload(
  window: DashboardWindow,
  timezone = 'UTC',
  now: Date = new Date(),
): Promise<DashboardPayload> {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(midnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(midnight.getTime() - 29 * 24 * 60 * 60 * 1000);
  const windowSinceTs = resolveDashboardWindowSinceTs(window, now);

  const [today, week, month, allTime, costByProject, costByModel, hourlyActivity, topExpensivePrompts] = await Promise.all([
    getWindowTotals(null, midnight),
    getWindowTotals(null, weekStart),
    getWindowTotals(null, monthStart),
    getWindowTotals(null, null),
    getCostByProject(windowSinceTs),
    getCostByModel(null, windowSinceTs),
    getHourlyActivityHeatmap(windowSinceTs, timezone),
    getTopExpensivePrompts(windowSinceTs, 10),
  ]);

  return {
    window,
    windowTotals: { today, week: week, month, allTime },
    costByProject,
    costByModel,
    hourlyActivity,
    topExpensivePrompts,
  };
}
