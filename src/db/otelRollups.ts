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
 * HS-8708 — exclude CUMULATIVE monotonic cost/token rows from SUM aggregations.
 * The dashboards SUM `claude_code.cost.usage` / `claude_code.token.usage`
 * data-point values, which is only correct for DELTA temporality (each row is
 * the increment since the last export). A CUMULATIVE monotonic counter reports
 * the running total on every export, so summing those rows re-inflates totals
 * 18-60× (the HS-8599 overcount). HS-8600 added the `aggregation_temporality` +
 * `is_monotonic` columns and a stderr warning when such a row arrives; this
 * predicate is what actually keeps those rows OUT of the totals so the dashboards
 * self-heal instead of needing a manual `DELETE`.
 *
 * Hot Sheet's own spawn env forces delta
 * (`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta`, HS-8599), so this
 * is a no-op on Hot-Sheet-spawned data; it only drops rows from a FOREIGN
 * telemetry source (an externally-launched `claude`, a different version/config)
 * that landed as `aggregation_temporality='cumulative' AND is_monotonic=true`.
 *
 * Null-safe via `IS DISTINCT FROM` / `IS NOT TRUE` so every row we MUST keep
 * passes:
 *   - delta counters (`temporality='delta'`),
 *   - non-monotonic points (gauges, `is_monotonic=false`),
 *   - legacy pre-HS-8600 rows (both columns NULL — already correct, since the
 *     delta-forcing spawn env predates the columns; existing seeded test rows
 *     hit this branch).
 *
 * Pure literal predicate (no bind params), safe to append with ` AND ${...}` to
 * any `otel_metrics` WHERE clause without disturbing `$N` indices — same
 * contract as `REAL_WORK_TOKEN_TYPE_SQL`. Only valid against `otel_metrics` (the
 * columns don't exist on `otel_events` / `otel_spans`), so it is appended per
 * metric query rather than inside the shared `buildProjectAndWindowClauses`
 * helper, which also serves event/span queries.
 */
const EXCLUDE_CUMULATIVE_MONOTONIC_SQL = "(aggregation_temporality IS DISTINCT FROM 'cumulative' OR is_monotonic IS NOT TRUE)";

/**
 * HS-8639 — Claude Code's OTLP log records carry event names WITHOUT a
 * `claude_code.` prefix on current Claude Code versions (the native OTLP
 * `eventName` field — e.g. `user_prompt`, `tool_result`, `api_request`),
 * whereas older builds (and the `event.name` attribute fallback the writer
 * reads — see `persistLogsPayload`) used the dotted `claude_code.user_prompt`
 * form. A live `otel_events` table therefore holds a MIX of both spellings, so
 * EVERY event-name filter MUST match BOTH or it silently matches zero rows.
 *
 * That mismatch is exactly the reported bug: the user's `/api/telemetry/_debug`
 * paste showed `user_prompt` / `tool_result` / `api_request` stored BARE, yet
 * these queries filtered the dotted form — so the recent-prompts list, the
 * tool-latency histogram, the per-prompt model, the per-ticket rollup, and the
 * cross-project / heatmap prompt counts all matched zero rows while the
 * metric-derived cost/token figures (which never key on `event_name`) stayed
 * healthy. The broadened headline count in `getWindowTotals` sidesteps the
 * problem only because it dropped the `event_name` filter entirely.
 */
const CLAUDE_CODE_EVENT_PREFIX = 'claude_code.';

/** Both spellings Claude Code may stamp for a given bare event name. */
function eventNameVariants(bareName: string): readonly string[] {
  return [bareName, `${CLAUDE_CODE_EVENT_PREFIX}${bareName}`];
}

/**
 * Prefix-tolerant SQL predicate. Calling it with the `event_name` column and
 * `user_prompt` yields `event_name IN ('user_prompt', 'claude_code.user_prompt')`.
 * `bareName` is ALWAYS a hardcoded literal at the callsite (never user input),
 * so embedding the variants directly is injection-safe and leaves `$N` bind
 * indices undisturbed — same rationale as REAL_WORK_TOKEN_TYPE_SQL above.
 */
export function eventNameMatchSql(column: string, bareName: string): string {
  return `${column} IN (${eventNameVariants(bareName).map(v => `'${v}'`).join(', ')})`;
}

/** JS-side counterpart of `eventNameMatchSql` for in-memory event rows. */
export function isClaudeCodeEvent(storedName: string, bareName: string): boolean {
  return eventNameVariants(bareName).includes(storedName);
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
  allowedSecrets: readonly string[] | null = null,
): Promise<WindowTotals> {
  const db = await getTelemetryDb();
  const metricsClause = buildProjectAndWindowClauses(projectSecret, sinceTs, 'ts', 1, allowedSecrets);

  const costResult = await db.query<{ total: string | null }>(
    `SELECT SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
     FROM otel_metrics
     WHERE metric_name = $1 AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}${metricsClause.clauses}`,
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
     WHERE metric_name = $1 AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}${metricsClause.clauses}`,
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
  // HS-8537 — per-ticket-rollup diagnosis. `getPerTicketRollup` is empty unless
  // (a) some `user_prompt` event body carries the `<!-- hotsheet:ticket=HS-NNNN -->`
  // marker, and (b) `api_request` events carry a `cost` / token attribute.
  /** Count of events (grouped by event_name) whose body contains ANY
   *  `hotsheet:ticket=` marker — tells us whether the channel-trigger marker is
   *  landing in `user_prompt` bodies at all (the rollup keys on user_prompt). */
  markerEventsByName: { eventName: string; count: number }[];
  /** Distinct `HS-NNNN` ticket numbers found in any event body (≤ 50). */
  distinctTicketMarkers: string[];
  /** Distinct attribute keys present on `api_request` events — so we can see
   *  whether `cost` / `cost_usd` / `tokens` / `input_tokens` exist (the rollup's
   *  cost/token source). Empty list ⇒ per-ticket cost can only ever be $0. */
  apiRequestAttrKeys: string[];
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
  // HS-8708 — this diagnostic deliberately does NOT apply
  // `EXCLUDE_CUMULATIVE_MONOTONIC_SQL`: `_debug` exists to show what is ACTUALLY
  // in the table (including any cumulative-temporality rows from a foreign
  // source), which is exactly what you want to see when diagnosing why a total
  // looks inflated. The dashboard rollups exclude those rows; this view doesn't.
  const tokenTypes = await db.query<{ typ: string | null; points: bigint | number; toks: string | null }>(
    `SELECT COALESCE(attributes_json->>'type', '(none)') AS typ, COUNT(*) AS points,
            SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS toks
     FROM otel_metrics
     WHERE metric_name = $1${mt.clauses}
     GROUP BY attributes_json->>'type' ORDER BY points DESC`,
    ['claude_code.token.usage', ...mt.params],
  );
  // HS-8537 — marker presence by event_name. The per-ticket rollup keys on
  // `user_prompt` bodies containing `hotsheet:ticket=…`; if this comes back
  // empty (or only on a non-user_prompt event), the marker isn't landing where
  // the rollup looks.
  const markerByName = await db.query<{ event_name: string; c: bigint | number }>(
    `SELECT event_name, COUNT(*) AS c
     FROM otel_events
     WHERE body_json::text LIKE '%hotsheet:ticket=%'${ev.clauses}
     GROUP BY event_name ORDER BY c DESC`,
    ev.params,
  );
  // Distinct ticket numbers found in any event body (capped).
  const markers = await db.query<{ ticket: string | null }>(
    `SELECT DISTINCT substring(body_json::text from 'hotsheet:ticket=([A-Za-z]+-[0-9]+)') AS ticket
     FROM otel_events
     WHERE body_json::text LIKE '%hotsheet:ticket=%'${ev.clauses}
     LIMIT 50`,
    ev.params,
  );
  // HS-8537 — attribute-key universe on api_request events: reveals whether
  // `cost` / `cost_usd` / `tokens` are present (the rollup's cost/token source).
  const apiKeys = await db.query<{ k: string }>(
    `SELECT DISTINCT k FROM otel_events, jsonb_object_keys(attributes_json) AS k
     WHERE ${eventNameMatchSql('event_name', 'api_request')}${ev.clauses}
     ORDER BY k`,
    ev.params,
  );
  return {
    eventNames: events.rows.map(r => ({ eventName: r.event_name, count: Number(r.c), withPromptId: Number(r.with_pid) })),
    tokenTypes: tokenTypes.rows.map(r => ({ type: r.typ ?? '(none)', points: Number(r.points), tokens: Number(r.toks ?? 0) })),
    totalEvents: Number(totals.rows[0]?.total ?? 0),
    distinctPromptIds: Number(totals.rows[0]?.pids ?? 0),
    distinctSessions: Number(totals.rows[0]?.sessions ?? 0),
    markerEventsByName: markerByName.rows.map(r => ({ eventName: r.event_name, count: Number(r.c) })),
    distinctTicketMarkers: markers.rows.map(r => r.ticket).filter((t): t is string => t !== null),
    apiRequestAttrKeys: apiKeys.rows.map(r => r.k),
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
     WHERE metric_name IN ('claude_code.cost.usage', 'claude_code.token.usage') AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}${clauses.clauses}
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
     WHERE ${eventNameMatchSql('event_name', 'tool_result')}${clauses.clauses}
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
     WHERE metric_name IN ('claude_code.cost.usage', 'claude_code.token.usage') AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}${clauses.clauses}
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
  const clauses = buildProjectAndWindowClauses(projectSecret, null, 'ts', 0);
  // Clamp limit to a sane bound — caller validates but defense-in-depth.
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));

  const result = await db.query<{ prompt_id: string; ts: string; project_secret: string; model: string | null }>(
    `SELECT
        prompt_id,
        ts,
        project_secret,
        attributes_json->>'model' AS model
     FROM otel_events
     WHERE ${eventNameMatchSql('event_name', 'user_prompt')} AND prompt_id IS NOT NULL${clauses.clauses}
     ORDER BY ts DESC
     LIMIT ${String(safeLimit)}`,
    clauses.params,
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
     WHERE metric_name = $1 AND project_secret = $2 AND ts >= $3 AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}`,
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

/** HS-8673 — generate the histogram-bucket `CASE` SQL from
 *  `HISTOGRAM_BUCKET_UPPER_MS` so the events-sourced and spans-sourced query
 *  bodies can't drift if the thresholds change. `valueExpr` is a SQL fragment
 *  evaluating to the duration in milliseconds (different per source). */
function buildHistogramBucketCase(valueExpr: string): string {
  const lines: string[] = ['CASE'];
  for (let i = 0; i < HISTOGRAM_BUCKET_UPPER_MS.length; i++) {
    lines.push(`          WHEN ${valueExpr} < ${HISTOGRAM_BUCKET_UPPER_MS[i]} THEN ${i}`);
  }
  lines.push(`          ELSE ${HISTOGRAM_BUCKET_UPPER_MS.length}`);
  lines.push('        END');
  return lines.join('\n');
}

/** HS-8673 — local-timezone window boundaries (today / 7-day / 30-day) shared by
 *  `getDashboardPayload` and `getProjectRollupPayload`. The unrounded arithmetic
 *  (24*60*60*1000) is preserved verbatim — `Date.setDate` would silently shift
 *  by DST jumps near the spring/fall transitions. */

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
     WHERE ${eventNameMatchSql('event_name', 'tool_result')}
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
        ${buildHistogramBucketCase("(attributes_json->>'duration_ms')::numeric")} AS bucket,
        COUNT(*) AS c
     FROM otel_events
     WHERE ${eventNameMatchSql('event_name', 'tool_result')}
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
        ${buildHistogramBucketCase('EXTRACT(EPOCH FROM (end_ts - start_ts)) * 1000')} AS bucket,
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
     WHERE metric_name = $1 AND ts >= $2 AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}
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
       WHERE metric_name = $1${tsClause}${secretsClause} AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}
       GROUP BY project_secret`,
      ['claude_code.cost.usage', ...tsParams, ...secrets.params],
    ),
    db.query<{ project_secret: string; total: string | null }>(
      // HS-8627 — input + output only (exclude cacheRead / cacheCreation).
      `SELECT project_secret, SUM(COALESCE((value_json->>'asDouble')::numeric, (value_json->>'asInt')::numeric, 0)) AS total
       FROM otel_metrics
       WHERE metric_name = $1${tsClause}${secretsClause} AND ${REAL_WORK_TOKEN_TYPE_SQL} AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}
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
      // HS-8639 — `$1` stays a single bound param (now the prefix-tolerant
      // variants array) so the shared `tsClause` / `secretsClause` `$N`
      // numbering matches the sibling metric queries.
      `SELECT project_secret, COUNT(DISTINCT prompt_id) AS c
       FROM otel_events
       WHERE event_name = ANY($1::text[]) AND prompt_id IS NOT NULL${tsClause}${secretsClause}
       GROUP BY project_secret`,
      [eventNameVariants('user_prompt'), ...tsParams, ...secrets.params],
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
     WHERE metric_name = $1${tsClause}${secretsClause} AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}
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
     WHERE event_name = ANY($1::text[]) AND prompt_id IS NOT NULL${promptsClause}${secretsClause}
     GROUP BY dow, hour`,
    [eventNameVariants('user_prompt'), timezone, ...tsParams, ...secrets.params],
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
     WHERE metric_name = $2${projectClause}${windowClause}${secretsClause} AND ${EXCLUDE_CUMULATIVE_MONOTONIC_SQL}
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

