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

export async function getPerTicketRollup(ticketNumber: string, secret?: string): Promise<TicketRollup> {
  const db = await getTelemetryDb();

  // The marker substring we LIKE for. Same format the client injects in
  // `channelUI.tsx::tagMessageWithActiveTicket`.
  const marker = `hotsheet:ticket=${ticketNumber}`;
  const secretParam = secret !== undefined && secret !== '' ? secret : null;

  // HS-8730 — attribute api_request cost via the UNION of two sources, deduped
  // at the EVENT level (each otel_events row is counted at most once):
  //   (a) MARKER path — prompts whose `user_prompt` body carries the
  //       `<!-- hotsheet:ticket=HS-N -->` marker (HS-8151 Option 3). Covers the
  //       "open the ticket, then trigger" flow.
  //   (b) TIME-WINDOW path — api_request events whose `ts` falls inside a
  //       `ticket_work_intervals` window for this (project_secret, ticket) — i.e.
  //       the periods the ticket was `started`. Covers the agentic worklist flow
  //       where Claude marks each ticket started→completed itself. Skipped when
  //       no `secret` is supplied (back-compat: marker-only).
  //
  // HS-8600 reconciliation (unchanged): this sums `api_request` EVENTS, a
  // deliberately different source than the `cost.usage` METRIC the dashboards
  // sum. api_request events are per-call deltas (not counters), so there's no
  // cumulative-overcount risk, and the two figures are never added together in
  // one displayed number. Cost/token attribute names vary by Claude Code
  // version, so COALESCE over common variants.
  const result = await db.query<{
    prompt_count: string | null;
    total_cost: string | null;
    total_tokens: string | null;
    total_seconds: string | null;
  }>(
    `WITH marker_prompts AS (
       SELECT DISTINCT prompt_id FROM otel_events
       WHERE ${eventNameMatchSql('event_name', 'user_prompt')}
         AND prompt_id IS NOT NULL
         AND body_json::text LIKE $1
     ),
     matched AS (
       SELECT
         e.prompt_id,
         e.ts,
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
             $2::text IS NOT NULL AND e.project_secret = $2 AND EXISTS (
               SELECT 1 FROM ticket_work_intervals i
               WHERE i.project_secret = $2 AND i.ticket_number = $3
                 AND e.ts >= i.started_at AND e.ts <= COALESCE(i.ended_at, NOW())
             )
           )
         )
     )
     SELECT
       (SELECT COUNT(DISTINCT prompt_id) FROM matched) AS prompt_count,
       (SELECT COALESCE(SUM(cost), 0) FROM matched) AS total_cost,
       (SELECT COALESCE(SUM(tokens), 0) FROM matched) AS total_tokens,
       (SELECT COALESCE(SUM(dur), 0) FROM (
          SELECT EXTRACT(EPOCH FROM (MAX(ts) - MIN(ts))) AS dur
          FROM matched WHERE prompt_id IS NOT NULL GROUP BY prompt_id
        ) per_prompt) AS total_seconds`,
    [`%${marker}%`, secretParam, ticketNumber],
  );

  const row = result.rows[0];
  return {
    ticketNumber,
    promptCount: Number(row.prompt_count ?? 0),
    totalCost: Number(row.total_cost ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    totalDurationSeconds: Number(row.total_seconds ?? 0),
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
