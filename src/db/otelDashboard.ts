/**
 * HS-8678 — composite-payload assemblers for the cross-project dashboard
 * (§69 / §70) and the per-project analytics dashboard's Claude-usage region
 * (§71). Extracted from `src/db/otelQueries.ts` along with the per-prompt
 * (`getPromptTimeline`) and per-ticket (`getPerTicketRollup`) drilldowns that
 * share the same composite-query character.
 *
 * Companion to `./otelRollups.ts`, which owns the individual rollup queries
 * (`getWindowTotals`, `getCostByModel`, etc.) + shared helpers
 * (`buildSecretsInClause`, `eventNameMatchSql`, the token-type SQL predicates,
 * `buildHistogramBucketCase`). `./otelQueries.ts` is now a thin re-export
 * facade preserving the original import surface, mirroring the HS-8189
 * registry split pattern.
 */
import { getTelemetryDb } from './connection.js';
import {
  type CostOverTimePoint,
  eventNameMatchSql,
  getCostByModel,
  getCostByProject,
  getCostOverTime,
  getHourlyActivityHeatmap,
  getRecentPrompts,
  getToolLatencyHistogram,
  getWindowTotals,
  type HourlyActivityCell,
  isClaudeCodeEvent,
  type ModelRollup,
  type ProjectCostRow,
  type RecentPrompt,
  type ToolLatencyHistogram,
  type WindowTotals,
} from './otelRollups.js';

function windowBoundaries(now: Date): { midnight: Date; weekStart: Date; monthStart: Date } {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(midnight.getTime() - 6 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(midnight.getTime() - 29 * 24 * 60 * 60 * 1000);
  return { midnight, weekStart, monthStart };
}

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
  const userPromptEntry = entries.find(e => isClaudeCodeEvent(e.eventName, 'user_prompt'));
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
     WHERE ${eventNameMatchSql('event_name', 'user_prompt')}
       AND prompt_id IS NOT NULL
       AND body_json::text LIKE $1`,
    [`%${marker}%`],
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
     WHERE ${eventNameMatchSql('event_name', 'api_request')}
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
  const { midnight, weekStart, monthStart } = windowBoundaries(now);
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
  const { midnight, weekStart, monthStart } = windowBoundaries(now);
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
