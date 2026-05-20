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
}

export async function getPromptTimeline(promptId: string): Promise<PromptTimeline> {
  const db = await getDb();
  const result = await db.query<{
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
  );

  if (result.rows.length === 0) {
    return { promptId, projectSecret: null, firstTs: null, lastTs: null, model: null, entries: [] };
  }

  const entries: PromptTimelineEntry[] = result.rows.map(r => ({
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
    projectSecret: result.rows[0].project_secret,
    firstTs: entries[0].ts,
    lastTs: entries[entries.length - 1].ts,
    model,
    entries,
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
