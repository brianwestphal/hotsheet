import { getTelemetryDb } from './connection.js';

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
  /** HS-8627 — real-work tokens (input + output, excludes cache). Kept as the
   *  combined headline number; `inputTokens` + `outputTokens` break it down. */
  tokens: number;
  /** HS-8628 — `type='input'` tokens only. */
  inputTokens: number;
  /** HS-8628 — `type='output'` tokens only. */
  outputTokens: number;
  /** HS-8639 — `type='cacheRead'` tokens (billed ~0.1× input). Excluded from
   *  `tokens` but surfaced so the cost breakdown shows every contributing piece. */
  cacheReadTokens: number;
  /** HS-8639 — `type='cacheCreation'` tokens (cache write, billed ~1.25× input). */
  cacheCreationTokens: number;
  promptCount: number;
}

export interface ModelRollup {
  model: string;
  cost: number;
  tokens: number;
  /** HS-8628 — `type='input'` tokens for this model. */
  inputTokens: number;
  /** HS-8628 — `type='output'` tokens for this model. */
  outputTokens: number;
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
/**
 * HS-8625 — build a `project_secret IN (...)` clause restricting a
 * cross-project rollup to the set of **currently-loaded** project secrets
 * (the registered project tabs, per `getAllProjects()`). Returns the BARE
 * clause (no leading ` AND `) + its params, with placeholder indices starting
 * at `baseParamCount + 1`. `null` ⇒ no restriction (every project, the
 * pre-HS-8625 behavior + the per-project-rollup callers that already scope by
 * a single `project_secret`). Empty array ⇒ the literal `FALSE` (no project is
 * loaded ⇒ nothing to show), avoiding the invalid `IN ()` SQL.
 */
function buildSecretsInClause(
  allowedSecrets: readonly string[] | null,
  baseParamCount: number,
): { clause: string; params: string[] } {
  if (allowedSecrets === null) return { clause: '', params: [] };
  if (allowedSecrets.length === 0) return { clause: 'FALSE', params: [] };
  const placeholders = allowedSecrets.map((_, i) => `$${String(baseParamCount + i + 1)}`);
  return { clause: `project_secret IN (${placeholders.join(', ')})`, params: [...allowedSecrets] };
}

function buildProjectAndWindowClauses(
  projectSecret: string | null,
  sinceTs: Date | null,
  tsColumn: string,
  baseParamCount: number,
  allowedSecrets: readonly string[] | null = null,
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
  // HS-8625 — cross-project rollups (projectSecret === null) restrict to the
  // currently-loaded project secrets when `allowedSecrets` is supplied.
  const secrets = buildSecretsInClause(allowedSecrets, baseParamCount + params.length);
  if (secrets.clause !== '') {
    clauses.push(secrets.clause);
    params.push(...secrets.params);
  }
  return { clauses: clauses.length === 0 ? '' : ' AND ' + clauses.join(' AND '), params };
}

/**
 * HS-8627 — headline token totals count only the "real work" tokens
 * (input + output), EXCLUDING the cache types. `claude_code.token.usage` is
 * tagged with a `type` dimension (input / output / cacheRead / cacheCreation);
 * `cacheRead` re-counts the ENTIRE cached prompt on every turn, so summing all
 * types inflated the token count far beyond the actual work — the over-count
 * the user kept seeing even after the HS-8599 delta fix (which only addressed
 * the cumulative-counter axis). Cost is deliberately NOT filtered: the
 * `claude_code.cost.usage` metric is already-priced USD that accounts for the
 * cache-read discount, so cache does not inflate it.
 *
 * Exclusion (not `type IN ('input','output')` inclusion) is chosen so an absent
 * or unknown `type` still counts — it fails OPEN to the old "include it"
 * behavior rather than silently zeroing the token count if the attribute shape
 * differs. Both Claude Code's camelCase values (`cacheRead` / `cacheCreation`)
 * and the snake_case spelling documented in §67 (`cache_read` / `cache_creation`)
 * are excluded. This is a pure literal predicate (no bind params), safe to
 * append to any token.usage WHERE / CASE without disturbing `$N` indices.
 */
const REAL_WORK_TOKEN_TYPE_SQL = "(attributes_json->>'type' IS NULL OR attributes_json->>'type' NOT IN ('cacheRead', 'cacheCreation', 'cache_read', 'cache_creation'))";

// HS-8628 — input vs output are priced very differently, so the stats surfaces
// break the real-work total down by `type`. Pure literal predicates (no bind
// params), safe to drop into a FILTER / CASE WHEN. `type` is always exactly
// 'input' / 'output' from Claude Code's `claude_code.token.usage` exporter — a
// NULL or unknown type counts toward the real-work total (HS-8627 fail-open) but
// not toward either input or output, so `inputTokens + outputTokens <= tokens`.
const INPUT_TOKEN_TYPE_SQL = "attributes_json->>'type' = 'input'";
const OUTPUT_TOKEN_TYPE_SQL = "attributes_json->>'type' = 'output'";
// HS-8639 — cache token types, surfaced so the cost breakdown can show "all the
// pieces that come together to create the cost". These are EXCLUDED from the
// headline token total (HS-8627) but DO drive cost: `cacheCreation` (cache
// write) is billed at ~1.25× input, `cacheRead` at ~0.1× input, and a large
// cached context is also what pushes a turn over the 200K threshold that
// doubles rates on the 1M-context (`[1m]`) models — which is why the
// authoritative `cost.usage` can dwarf a naive input+output estimate. Both
// Claude Code's camelCase + the §67 snake_case spellings are matched.
const CACHE_READ_TOKEN_TYPE_SQL = "attributes_json->>'type' IN ('cacheRead', 'cache_read')";
const CACHE_CREATION_TOKEN_TYPE_SQL = "attributes_json->>'type' IN ('cacheCreation', 'cache_creation')";

/**
 * Window totals: total cost + total tokens + count of distinct prompts
 * over the given window. Cost comes from `claude_code.cost.usage`
 * metric data points; tokens from `claude_code.token.usage`; prompt
 * count from distinct `prompt_id` on `claude_code.user_prompt` events.
 */
export async function getWindowTotals(
  projectSecret: string | null,
  sinceTs: Date | null,
  allowedSecrets: readonly string[] | null = null,
): Promise<WindowTotals> {
  const db = await getTelemetryDb();
  const metricsClause = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 1, allowedSecrets);

  const costResult = await db.query<{ total: string | null }>(
    `SELECT SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1${metricsClause.clauses}`,
    ['claude_code.cost.usage', ...metricsClause.params],
  );
  // HS-8627 — `total` is input + output (excludes cacheRead / cacheCreation).
  // HS-8628 — `input` / `output` break the same total down by `type` in one
  // pass via FILTER (WHERE …) aggregates.
  const tokensResult = await db.query<{ total: string | null; input: string | null; output: string | null; cache_read: string | null; cache_creation: string | null }>(
    `SELECT
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) FILTER (WHERE ${REAL_WORK_TOKEN_TYPE_SQL}) AS total,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) FILTER (WHERE ${INPUT_TOKEN_TYPE_SQL}) AS input,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) FILTER (WHERE ${OUTPUT_TOKEN_TYPE_SQL}) AS output,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) FILTER (WHERE ${CACHE_READ_TOKEN_TYPE_SQL}) AS cache_read,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) FILTER (WHERE ${CACHE_CREATION_TOKEN_TYPE_SQL}) AS cache_creation
     FROM otel_metrics
     WHERE metric_name = $1${metricsClause.clauses}`,
    ['claude_code.token.usage', ...metricsClause.params],
  );

  // HS-8639 — count distinct `prompt_id` across ALL log events, not only
  // `claude_code.user_prompt`. `prompt.id` is the per-prompt correlation key
  // Claude Code stamps on user_prompt / api_request / tool_result events + spans
  // (docs/67 §"prompt.id"), so counting it broadly still counts each prompt once
  // (one prompt_id spans many api_request/tool_result rows) while staying robust
  // when the `user_prompt` event specifically doesn't flush — the HS-8514
  // observation where the headline showed a misleading "1 prompts". Offset 0:
  // no leading bind param now that the `event_name = $1` filter is gone.
  const eventsClause = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0, allowedSecrets);
  const promptsResult = await db.query<{ c: bigint | number }>(
    `SELECT COUNT(DISTINCT prompt_id) AS c
     FROM otel_events
     WHERE prompt_id IS NOT NULL${eventsClause.clauses}`,
    eventsClause.params,
  );

  // HS-8514 / HS-8639 — when NO log event carries a prompt_id (e.g. Claude
  // Code's bundled exporter isn't flushing log events to a self-hosted OTLP
  // receiver in this config — observed: healthy `cost.usage` metrics but zero
  // events), fall back to a session-count proxy from the metrics table so the
  // user still sees a meaningful non-zero activity count. `session.id` is
  // stamped on every cost.usage data point. This is a SESSION count, not a true
  // prompt count — see the `/api/telemetry/_debug` endpoint (HS-8639) to
  // diagnose whether log events are arriving.
  let promptCount = Number(promptsResult.rows[0]?.c ?? 0);
  if (promptCount === 0) {
    const sessionsResult = await db.query<{ c: bigint | number }>(
      `SELECT COUNT(DISTINCT attributes_json->>'session.id') AS c
       FROM otel_metrics
       WHERE metric_name = $1
         AND attributes_json->>'session.id' IS NOT NULL${metricsClause.clauses}`,
      ['claude_code.cost.usage', ...metricsClause.params],
    );
    promptCount = Number(sessionsResult.rows[0]?.c ?? 0);
  }

  return {
    cost: Number(costResult.rows[0]?.total ?? 0),
    tokens: Number(tokensResult.rows[0]?.total ?? 0),
    inputTokens: Number(tokensResult.rows[0]?.input ?? 0),
    outputTokens: Number(tokensResult.rows[0]?.output ?? 0),
    cacheReadTokens: Number(tokensResult.rows[0]?.cache_read ?? 0),
    cacheCreationTokens: Number(tokensResult.rows[0]?.cache_creation ?? 0),
    promptCount,
  };
}

/**
 * HS-8639 — read-only diagnostic for the "prompt count = 1 / empty
 * recent-prompts + tool histogram" report. Surfaces (a) the distinct
 * `event_name` values actually stored in `otel_events` + how many carry a
 * `prompt_id`, and (b) the `token.usage` `type` breakdown — so we can tell
 * whether Claude Code's LOG events (user_prompt / api_request / tool_result)
 * are arriving at all, arriving under an unexpected `event_name`, or arriving
 * without a `prompt_id`. Project-scoped; powers `GET /api/telemetry/_debug`.
 */
export interface TelemetryDebugInfo {
  eventNames: { eventName: string; count: number; withPromptId: number }[];
  tokenTypes: { type: string; points: number; tokens: number }[];
  totalEvents: number;
  distinctPromptIds: number;
  distinctSessions: number;
}

export async function getTelemetryDebugInfo(projectSecret: string | null): Promise<TelemetryDebugInfo> {
  const db = await getTelemetryDb();
  const ev = buildProjectAndWindowClauses(projectSecret, null, 'ts', 0);
  const events = await db.query<{ event_name: string; c: bigint | number; with_pid: bigint | number }>(
    `SELECT event_name, COUNT(*) AS c, COUNT(prompt_id) AS with_pid
     FROM otel_events
     WHERE 1=1${ev.clauses}
     GROUP BY event_name ORDER BY c DESC`,
    ev.params,
  );
  const totals = await db.query<{ total: bigint | number; pids: bigint | number; sessions: bigint | number }>(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT prompt_id) AS pids, COUNT(DISTINCT session_id) AS sessions
     FROM otel_events
     WHERE 1=1${ev.clauses}`,
    ev.params,
  );
  const mt = buildProjectAndWindowClauses(projectSecret, null, 'ts', 1);
  const tokenTypes = await db.query<{ typ: string | null; points: bigint | number; toks: string | null }>(
    `SELECT COALESCE(attributes_json->>'type', '(none)') AS typ, COUNT(*) AS points,
            SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS toks
     FROM otel_metrics
     WHERE metric_name = $1${mt.clauses}
     GROUP BY attributes_json->>'type' ORDER BY points DESC`,
    ['claude_code.token.usage', ...mt.params],
  );
  return {
    eventNames: events.rows.map(r => ({ eventName: r.event_name, count: Number(r.c), withPromptId: Number(r.with_pid) })),
    tokenTypes: tokenTypes.rows.map(r => ({ type: r.typ ?? '(none)', points: Number(r.points), tokens: Number(r.toks ?? 0) })),
    totalEvents: Number(totals.rows[0]?.total ?? 0),
    distinctPromptIds: Number(totals.rows[0]?.pids ?? 0),
    distinctSessions: Number(totals.rows[0]?.sessions ?? 0),
  };
}

/**
 * Cost by model. Groups `claude_code.cost.usage` data points by the
 * `model` attribute. Returns rows sorted by cost descending.
 */
export async function getCostByModel(
  projectSecret: string | null,
  sinceTs: Date | null,
  allowedSecrets: readonly string[] | null = null,
): Promise<ModelRollup[]> {
  const db = await getTelemetryDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0, allowedSecrets);

  // HS-8514 — `COUNT(DISTINCT session_id)` was returning 0 because
  // the `session_id` column is sourced from the resource attributes
  // and Claude Code's exporter stamps `session.id` on the
  // per-data-point attributes instead. `COALESCE(session_id,
  // attributes_json->>'session.id')` picks whichever path is
  // populated.
  const result = await db.query<{ model: string | null; cost: string; tokens: string; input_tokens: string; output_tokens: string; prompt_count: string }>(
    `SELECT
        COALESCE(attributes_json->>'model', '(unknown)') AS model,
        SUM(CASE WHEN metric_name = 'claude_code.cost.usage' THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS cost,
        SUM(CASE WHEN metric_name = 'claude_code.token.usage' AND ${REAL_WORK_TOKEN_TYPE_SQL} THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS tokens,
        SUM(CASE WHEN metric_name = 'claude_code.token.usage' AND ${INPUT_TOKEN_TYPE_SQL} THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN metric_name = 'claude_code.token.usage' AND ${OUTPUT_TOKEN_TYPE_SQL} THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS output_tokens,
        COUNT(DISTINCT COALESCE(session_id, attributes_json->>'session.id')) AS prompt_count
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
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
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
  const db = await getTelemetryDb();
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
  const db = await getTelemetryDb();
  const clauses = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 0);

  // HS-8514 — same `session_id` issue as `getCostByModel`; fall back
  // to `attributes_json->>'session.id'` when the column is null.
  const result = await db.query<{ source: string | null; cost: string; tokens: string; prompt_count: string }>(
    `SELECT
        COALESCE(attributes_json->>'query.source', '(unknown)') AS source,
        SUM(CASE WHEN metric_name = 'claude_code.cost.usage' THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS cost,
        SUM(CASE WHEN metric_name = 'claude_code.token.usage' AND ${REAL_WORK_TOKEN_TYPE_SQL} THEN COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0) ELSE 0 END) AS tokens,
        COUNT(DISTINCT COALESCE(session_id, attributes_json->>'session.id')) AS prompt_count
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
  const db = await getTelemetryDb();
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
  const db = await getTelemetryDb();
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
 * HS-8606 — clear ALL telemetry for one project. Deletes every row across
 * `otel_metrics` / `otel_events` / `otel_spans` whose `project_secret`
 * matches, with no time filter (unlike the §67.6 retention sweep). The one
 * mutation in this otherwise read-only module — it lives here because the
 * telemetry tables are a single shared store (the primary project's DB,
 * keyed by `project_secret`; see `getTelemetryDb` / §67.6), so the delete
 * MUST go through `getTelemetryDb()` and MUST be secret-scoped exactly like
 * every rollup. Returns the total rows removed across the three tables.
 *
 * Backs the Settings → Telemetry → Retention "Clear telemetry data" button
 * (§74). An empty / missing `projectSecret` is rejected by the caller before
 * we get here — an unscoped delete across the shared store would wipe every
 * project's data, so this function never runs without a concrete secret.
 */
export async function clearProjectTelemetry(projectSecret: string): Promise<{ deleted: number }> {
  const db = await getTelemetryDb();
  let deleted = 0;
  for (const table of ['otel_metrics', 'otel_events', 'otel_spans'] as const) {
    const result = await db.query(
      `DELETE FROM ${table} WHERE project_secret = $1`,
      [projectSecret],
    );
    deleted += result.affectedRows ?? 0;
  }
  return { deleted };
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
  const db = await getTelemetryDb();

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
  const db = await getTelemetryDb();
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
  const db = await getTelemetryDb();
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
  const db = await getTelemetryDb();
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
  const db = await getTelemetryDb();
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
  const db = await getTelemetryDb();

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
  //
  // HS-8600 reconciliation: this per-ticket rollup sums `claude_code.api_request`
  // EVENTS — a deliberately DIFFERENT source than the `claude_code.cost.usage`
  // METRIC the window/model/dashboard rollups SUM. That's safe on both axes:
  // (1) **no cumulative-overcount risk** — `api_request` events are emitted
  // once per LLM call carrying THAT call's cost/tokens (inherently per-call
  // deltas; log events aren't counters, so the OTLP aggregation-temporality
  // concern that motivated HS-8599/HS-8600 doesn't apply here); (2) **no
  // double-count** — the events path feeds only the per-ticket detail-panel
  // figure, the metric path feeds only the dashboards; the two are never
  // added together in a single displayed number.
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
export async function getCostByProject(
  sinceTs: Date | null,
  allowedSecrets: readonly string[] | null = null,
): Promise<ProjectCostRow[]> {
  const db = await getTelemetryDb();
  const tsClause = sinceTs === null ? '' : ' AND ts >= $2';
  const tsParams: Array<string | Date> = sinceTs === null ? [] : [sinceTs];
  // HS-8625 — restrict to currently-loaded projects. All five queries below
  // share the same `[metric/event, ...tsParams]` param layout, so the secrets
  // placeholders start at the same base for each.
  const secrets = buildSecretsInClause(allowedSecrets, 1 + tsParams.length);
  const secretsClause = secrets.clause === '' ? '' : ` AND ${secrets.clause}`;

  const [costResult, tokensResult, promptsResult, sessionsResult, lastTsResult] = await Promise.all([
    db.query<{ project_secret: string; total: string | null }>(
      `SELECT project_secret, SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}${secretsClause}
       GROUP BY project_secret`,
      ['claude_code.cost.usage', ...tsParams, ...secrets.params],
    ),
    db.query<{ project_secret: string; total: string | null }>(
      // HS-8627 — input + output only (exclude cacheRead / cacheCreation).
      `SELECT project_secret, SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}${secretsClause} AND ${REAL_WORK_TOKEN_TYPE_SQL}
       GROUP BY project_secret`,
      ['claude_code.token.usage', ...tsParams, ...secrets.params],
    ),
    // HS-8514 — events-based prompt count falls back to a
    // session-count proxy when no `user_prompt` events were captured
    // (Claude Code's exporter sometimes doesn't flush log events to a
    // self-hosted OTLP receiver even when metrics are flowing fine).
    // Two queries — primary (events) + fallback (metrics distinct
    // session.id) — merged per project below so any project with zero
    // events still surfaces a meaningful activity count.
    db.query<{ project_secret: string; c: bigint | number }>(
      `SELECT project_secret, COUNT(DISTINCT prompt_id) AS c
       FROM otel_events
       WHERE event_name = $1 AND prompt_id IS NOT NULL${tsClause}${secretsClause}
       GROUP BY project_secret`,
      ['claude_code.user_prompt', ...tsParams, ...secrets.params],
    ),
    db.query<{ project_secret: string; c: bigint | number }>(
      `SELECT project_secret, COUNT(DISTINCT attributes_json->>'session.id') AS c
       FROM otel_metrics
       WHERE metric_name = $1
         AND attributes_json->>'session.id' IS NOT NULL${tsClause}${secretsClause}
       GROUP BY project_secret`,
      ['claude_code.cost.usage', ...tsParams, ...secrets.params],
    ),
    db.query<{ project_secret: string; last_ts: string }>(
      `SELECT project_secret, MAX(ts) AS last_ts
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}${secretsClause}
       GROUP BY project_secret`,
      ['claude_code.cost.usage', ...tsParams, ...secrets.params],
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
  // HS-8514 — fall back to the session-count proxy for projects with
  // zero `user_prompt` events. Keeps the events-based count for any
  // project where it surfaced a value (events are the more precise
  // signal when they're flowing).
  for (const r of sessionsResult.rows) {
    const row = byProject.get(r.project_secret);
    if (row !== undefined && row.promptCount === 0) row.promptCount = Number(r.c);
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
  allowedSecrets: readonly string[] | null = null,
): Promise<HourlyActivityCell[]> {
  const db = await getTelemetryDb();
  const tsClause = sinceTs === null ? '' : ' AND ts >= $3';
  const tsParams: Array<string | Date> = sinceTs === null ? [] : [sinceTs];
  // HS-8625 — restrict to currently-loaded projects. Both queries share the
  // `[metric/event, timezone, ...tsParams]` layout (timezone is $2), so the
  // secrets placeholders start at 2 + tsParams.length for both.
  const secrets = buildSecretsInClause(allowedSecrets, 2 + tsParams.length);
  const secretsClause = secrets.clause === '' ? '' : ` AND ${secrets.clause}`;

  // Cost per (dow, hour) bucket.
  const costResult = await db.query<{ dow: string | number; hour: string | number; total: string | null }>(
    `SELECT
        EXTRACT(DOW FROM ts AT TIME ZONE $2)::int AS dow,
        EXTRACT(HOUR FROM ts AT TIME ZONE $2)::int AS hour,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1${tsClause}${secretsClause}
     GROUP BY dow, hour`,
    ['claude_code.cost.usage', timezone, ...tsParams, ...secrets.params],
  );

  // Distinct-prompt count per (dow, hour) bucket.
  const promptsClause = sinceTs === null ? '' : ' AND ts >= $3';
  const promptsResult = await db.query<{ dow: string | number; hour: string | number; c: bigint | number }>(
    `SELECT
        EXTRACT(DOW FROM ts AT TIME ZONE $2)::int AS dow,
        EXTRACT(HOUR FROM ts AT TIME ZONE $2)::int AS hour,
        COUNT(DISTINCT prompt_id) AS c
     FROM otel_events
     WHERE event_name = $1 AND prompt_id IS NOT NULL${promptsClause}${secretsClause}
     GROUP BY dow, hour`,
    ['claude_code.user_prompt', timezone, ...tsParams, ...secrets.params],
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
  /** HS-8503 / §69.10.4 — densified daily cost series for the
   *  Stacked / Overlay cost-over-time chart. One point per
   *  (date, project, model) tuple in the window. */
  costOverTime: CostOverTimePoint[];
}

/**
 * HS-8503 Phase 1 / §69.10.4 — single point in the cost-over-time
 * series. Densified per (date, projectSecret, model) so the chart's
 * stacked-area math has zero gaps to special-case.
 *
 * `date` is a `YYYY-MM-DD` string in the requested timezone — the
 * SQL bucket uses `DATE_TRUNC('day', ts AT TIME ZONE $tz)`. The
 * string format (not `Date`) keeps the wire shape JSON-safe and
 * timezone-pinned to the value the client requested.
 */
export interface CostOverTimePoint {
  date: string;
  projectSecret: string;
  model: string;
  cost: number;
}

/**
 * Format a Date as `YYYY-MM-DD` in the given IANA timezone. Used
 * for both the date-range bounds (start / end) AND the densification
 * keys so the bucket math matches the SQL `DATE_TRUNC … AT TIME ZONE`
 * output.
 */
function formatDateInTimezone(d: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find(p => p.type === 'year')?.value ?? '0000';
  const m = parts.find(p => p.type === 'month')?.value ?? '01';
  const day = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${y}-${m}-${day}`;
}

/**
 * Add `days` to a `YYYY-MM-DD` string. UTC arithmetic — safe because
 * we're treating each day as a calendar entity (not a wall-clock
 * interval), so DST transitions don't affect the result.
 */
function addDaysToDateString(dateStr: string, days: number): string {
  const parts = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * HS-8503 Phase 1 / §69.10.4 — cost-over-time daily series.
 *
 * Returns one `CostOverTimePoint` per (date, projectSecret, model) in
 * the window. The (projectSecret, model) tuple set is sourced from
 * the rows that actually have data in the window — tuples with NO
 * activity in the window aren't densified (would be all zeros
 * everywhere, useless to the chart). Within that tuple set, every
 * day in the date range is filled with the actual cost or zero.
 *
 * Date range:
 *   - `sinceTs !== null`: from the local-tz date of `sinceTs` through
 *     the local-tz date of `now`.
 *   - `sinceTs === null` (`all` window): from the earliest data row's
 *     date through `now`. Empty data → empty result.
 *
 * Passing `projectSecret !== null` scopes the query to a single
 * project (per-project analytics-dashboard variant); `null` is
 * cross-project (cross-project stats page variant). The shape is
 * identical so a single chart component handles both surfaces.
 */
export async function getCostOverTime(
  sinceTs: Date | null,
  projectSecret: string | null,
  timezone = 'UTC',
  now: Date = new Date(),
  allowedSecrets: readonly string[] | null = null,
): Promise<CostOverTimePoint[]> {
  const db = await getTelemetryDb();

  const params: Array<string | Date> = [timezone, 'claude_code.cost.usage'];
  let projectClause = '';
  let windowClause = '';
  if (projectSecret !== null) {
    params.push(projectSecret);
    projectClause = ` AND project_secret = $${String(params.length)}`;
  }
  if (sinceTs !== null) {
    params.push(sinceTs);
    windowClause = ` AND ts >= $${String(params.length)}`;
  }
  // HS-8625 — restrict to currently-loaded projects (cross-project use;
  // ignored when a single projectSecret already scopes the query). Appended
  // last, so placeholders follow whatever params were pushed above.
  const secrets = buildSecretsInClause(allowedSecrets, params.length);
  const secretsClause = secrets.clause === '' ? '' : ` AND ${secrets.clause}`;
  params.push(...secrets.params);

  const result = await db.query<{ date: string; project_secret: string; model: string; total: string | null }>(
    `SELECT
        to_char(DATE_TRUNC('day', ts AT TIME ZONE $1), 'YYYY-MM-DD') AS date,
        project_secret,
        COALESCE(attributes_json->>'model', '(unknown)') AS model,
        SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $2${projectClause}${windowClause}${secretsClause}
     GROUP BY 1, 2, 3
     ORDER BY 1 ASC`,
    params,
  );

  if (result.rows.length === 0) return [];

  // Build the (project, model) tuple list + index actual data by composite key.
  // Tuples kept as a structured list (instead of a Set<string> with a delimiter
  // that could in theory collide with model-name characters) so the rebuild
  // step doesn't have to parse anything back out.
  const tuples: Array<{ projectSecret: string; model: string }> = [];
  const seenTuples = new Set<string>();
  const dataByKey = new Map<string, number>();
  for (const r of result.rows) {
    // JSON.stringify here only for the set-membership check — never parsed back.
    const seenKey = JSON.stringify([r.project_secret, r.model]);
    if (!seenTuples.has(seenKey)) {
      seenTuples.add(seenKey);
      tuples.push({ projectSecret: r.project_secret, model: r.model });
    }
    dataByKey.set(`${r.date}|${seenKey}`, Number(r.total ?? 0));
  }

  // Resolve the date range.
  const endDateStr = formatDateInTimezone(now, timezone);
  const startDateStr = sinceTs !== null
    ? formatDateInTimezone(sinceTs, timezone)
    : result.rows[0].date;

  // Generate every date string from start through end, inclusive.
  const dateStrs: string[] = [];
  let cursor = startDateStr;
  // Safety bound — at single-user scale `all` window is years at most,
  // but cap at 10000 days (~27 years) just in case `sinceTs` is bogus.
  for (let i = 0; i < 10000 && cursor <= endDateStr; i++) {
    dateStrs.push(cursor);
    cursor = addDaysToDateString(cursor, 1);
  }

  // Densify: one point per (date × tuple), filled with zero when no row matched.
  const out: CostOverTimePoint[] = [];
  for (const date of dateStrs) {
    for (const tuple of tuples) {
      const seenKey = JSON.stringify([tuple.projectSecret, tuple.model]);
      out.push({
        date,
        projectSecret: tuple.projectSecret,
        model: tuple.model,
        cost: dataByKey.get(`${date}|${seenKey}`) ?? 0,
      });
    }
  }
  return out;
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
  allowedSecrets: readonly string[] | null = null,
  now: Date = new Date(),
): Promise<DashboardPayload> {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(midnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(midnight.getTime() - 29 * 24 * 60 * 60 * 1000);
  const windowSinceTs = resolveDashboardWindowSinceTs(window, now);

  // HS-8625 — `allowedSecrets` restricts every cross-project aggregate to the
  // currently-loaded project tabs (passed from the route as
  // `getAllProjects().map(p => p.secret)`); null means "every project"
  // (back-compat / tests). Threaded into all eight sub-queries so totals,
  // cost-by-project, donut, heatmap, and cost-over-time agree.
  const [today, week, month, allTime, costByProject, costByModel, hourlyActivity, costOverTime] = await Promise.all([
    getWindowTotals(null, midnight, allowedSecrets),
    getWindowTotals(null, weekStart, allowedSecrets),
    getWindowTotals(null, monthStart, allowedSecrets),
    getWindowTotals(null, null, allowedSecrets),
    getCostByProject(windowSinceTs, allowedSecrets),
    getCostByModel(null, windowSinceTs, allowedSecrets),
    getHourlyActivityHeatmap(windowSinceTs, timezone, allowedSecrets),
    getCostOverTime(windowSinceTs, null, timezone, now, allowedSecrets),
  ]);

  return {
    window,
    windowTotals: { today, week, month, allTime },
    costByProject,
    costByModel,
    hourlyActivity,
    costOverTime,
  };
}

/**
 * HS-8503 Phase 1 / §69.10.5 — per-project rollup payload for the
 * analytics dashboard's new telemetry sub-region. Bundles every
 * section the per-project telemetry view renders into one round-trip:
 *
 *   - `windowTotals` chips (today / week / month / all-time —
 *     fixed regardless of `window`).
 *   - `costByModel` donut data narrowed by `window`.
 *   - `toolLatencyHistogram` per-tool inline-SVG bars narrowed by `window`.
 *   - `recentPrompts` last 10 prompts (newest-first; drilldown entry).
 *   - `costOverTime` densified daily series for the Stacked / Overlay
 *     chart, scoped to this project.
 *
 * Mirrors `getDashboardPayload`'s shape so the analytics dashboard's
 * window-selector drives the same set of rollups the cross-project
 * page does, just with a project filter applied.
 */
export interface ProjectRollupPayload {
  window: DashboardWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByModel: ModelRollup[];
  toolLatencyHistogram: ToolLatencyHistogram[];
  recentPrompts: RecentPrompt[];
  costOverTime: CostOverTimePoint[];
}

export async function getProjectRollupPayload(
  projectSecret: string,
  window: DashboardWindow,
  timezone = 'UTC',
  now: Date = new Date(),
): Promise<ProjectRollupPayload> {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(midnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(midnight.getTime() - 29 * 24 * 60 * 60 * 1000);
  const windowSinceTs = resolveDashboardWindowSinceTs(window, now);

  const [today, week, month, allTime, costByModel, toolLatencyHistogram, recentPrompts, costOverTime] = await Promise.all([
    getWindowTotals(projectSecret, midnight),
    getWindowTotals(projectSecret, weekStart),
    getWindowTotals(projectSecret, monthStart),
    getWindowTotals(projectSecret, null),
    getCostByModel(projectSecret, windowSinceTs),
    getToolLatencyHistogram(projectSecret, windowSinceTs),
    // §69.10.5 point 5 — 10 most recent prompts (not the drawer's 50,
    // and explicitly NOT top-N-expensive; ts DESC is sorted by
    // `getRecentPrompts` already).
    getRecentPrompts(projectSecret, 10),
    getCostOverTime(windowSinceTs, projectSecret, timezone, now),
  ]);

  return {
    window,
    windowTotals: { today, week, month, allTime },
    costByModel,
    toolLatencyHistogram,
    recentPrompts,
    costOverTime,
  };
}
