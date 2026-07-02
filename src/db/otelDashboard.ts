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
import type { PGlite } from '@electric-sql/pglite';

import { getAllProjects } from '../projects.js';
import {
  type AnnouncerUsageByProjectRow, type AnnouncerUsageTotals,
  getAnnouncerUsageByProject, getAnnouncerUsageTotals,
} from './announcerUsage.js';
import { centralTelemetryDataDir, getDataDir, getRollupDb, runWithTelemetryDb, telemetryClusterDataDir } from './connection.js';
import { readAllOtelJsonl } from './otelJsonlStore.js';
import {
  type CostOverTimePoint,
  eventNameMatchSql,
  getCostByModel,
  getCostByProject,
  getCostOverTime,
  getHourlyActivityHeatmap,
  getIngestedDates,
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
  /** HS-8810 — local-calendar days in the window that had ≥1 ingested metric
   *  point. A cost-over-time day absent from this set + at $0 had no telemetry
   *  captured (receiver down / Claude outside Hot Sheet) vs. a genuine $0 day. */
  ingestedDates: string[];
  /** HS-8766 — cross-project Announcer spend (the user's own Anthropic API
   *  usage), window total + per-project breakdown. */
  announcer: { total: AnnouncerUsageTotals; byProject: AnnouncerUsageByProjectRow[] };
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

/**
 * HS-8874 / HS-9278 — a prompt lives in exactly one project's telemetry store (or
 * central). Fan out across every known project cluster dir + the central store,
 * scanning the day-partitioned JSONL (HS-9236) instead of the raw `otel_*` tables
 * (Phase 3 (b) — raw is JSONL-only), and return the first store that has any events
 * for the prompt. If none has events, return orphan spans from the first store that
 * has any; else the empty shape.
 */
export async function getPromptTimeline(promptId: string): Promise<PromptTimeline> {
  // getAllProjects() + central covers every store in production; getDataDir() adds
  // the ambient/default context (the old code's fallback, and the seam the tests
  // seed through). Dedup so an overlapping dir isn't scanned twice.
  const clusterDirs = [...new Set([
    ...getAllProjects().map(p => telemetryClusterDataDir(p.dataDir)),
    telemetryClusterDataDir(centralTelemetryDataDir()),
    telemetryClusterDataDir(getDataDir()),
  ])];
  let orphanSpans: PromptTimeline | null = null;
  for (const clusterDir of clusterDirs) {
    const timeline = await getPromptTimelineFromJsonl(clusterDir, promptId);
    if (timeline.entries.length > 0) return timeline;
    if (orphanSpans === null && timeline.spans.length > 0) orphanSpans = timeline;
  }
  return orphanSpans ?? { promptId, projectSecret: null, firstTs: null, lastTs: null, model: null, entries: [], spans: [] };
}

/** String field or `''`; used for the JSONL record's stringy columns. */
function jstr(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === 'string' ? v : '';
}

/** Object field or `{}`; JSONL stores `attributes_json` as a nested object. */
function jobj(r: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = r[key];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/**
 * HS-9278 — build a prompt's timeline by scanning ONE telemetry store's JSONL.
 * Reads every extant events + spans day file (retention-agnostic; the sweeper
 * bounds them), filters by `prompt_id`, and stably sorts by ts / start_ts. The
 * synthetic `id` is the sorted index — the DB serial the raw shape carried was a
 * vestigial ordering/key field the client never renders. Exported for unit tests.
 */
export async function getPromptTimelineFromJsonl(clusterDir: string, promptId: string): Promise<PromptTimeline> {
  const [eventRows, spanRows] = await Promise.all([
    readAllOtelJsonl(clusterDir, 'events'),
    readAllOtelJsonl(clusterDir, 'spans'),
  ]);

  // Stable sort preserves file (≈ insertion / serial) order for equal timestamps,
  // matching the old `ORDER BY ts ASC, id ASC`.
  const spans: SpanRow[] = spanRows
    .filter(r => r.prompt_id === promptId)
    .sort((a, b) => jstr(a, 'start_ts').localeCompare(jstr(b, 'start_ts')))
    .map((r, i) => ({
      id: i,
      traceId: jstr(r, 'trace_id'),
      spanId: jstr(r, 'span_id'),
      parentSpanId: typeof r.parent_span_id === 'string' ? r.parent_span_id : null,
      spanName: jstr(r, 'span_name'),
      startTs: jstr(r, 'start_ts'),
      endTs: jstr(r, 'end_ts'),
      attributesJson: jobj(r, 'attributes_json'),
      statusCode: typeof r.status_code === 'string' ? r.status_code : null,
    }));

  const eventMatches = eventRows
    .filter(r => r.prompt_id === promptId)
    .sort((a, b) => jstr(a, 'ts').localeCompare(jstr(b, 'ts')));

  if (eventMatches.length === 0) {
    return { promptId, projectSecret: null, firstTs: null, lastTs: null, model: null, entries: [], spans };
  }

  const entries: PromptTimelineEntry[] = eventMatches.map((r, i) => ({
    id: i,
    ts: jstr(r, 'ts'),
    eventName: jstr(r, 'event_name'),
    attributesJson: jobj(r, 'attributes_json'),
    bodyJson: (r.body_json !== null && typeof r.body_json === 'object' && !Array.isArray(r.body_json))
      ? r.body_json as Record<string, unknown>
      : null,
  }));

  // Pull model from the first user_prompt event's attributes when present.
  const userPromptEntry = entries.find(e => isClaudeCodeEvent(e.eventName, 'user_prompt'));
  const model = userPromptEntry !== undefined && typeof userPromptEntry.attributesJson['model'] === 'string'
    ? userPromptEntry.attributesJson['model']
    : null;

  return {
    promptId,
    projectSecret: typeof eventMatches[0].project_secret === 'string' ? eventMatches[0].project_secret : null,
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

/**
 * HS-9235 part 2 (HS-9257) — read the per-ticket rollup from the compact main-db
 * tables: cost / tokens / prompt_count from `otel_rollup_ticket`, and duration
 * from `otel_ticket_prompt_span` (`SUM(last_ts - first_ts)` per prompt). No raw
 * `otel_*` scan. The rollup is maintained at ingest (`attributeApiRequestToTicket`
 * / `attributeUserPromptToTicket` / `widenTicketPromptSpan`) + backfilled from
 * raw (`backfillTicketsForDir`, which uses `computeTicketRollupFromRaw` below).
 */
export async function getPerTicketRollup(ticketNumber: string, secret?: string): Promise<TicketRollup> {
  const db = await getRollupDb();
  const secretParam = secret !== undefined && secret !== '' ? secret : '';

  const scalarResult = await db.query<{ cost: string | null; tokens: string | null; prompt_count: number | null }>(
    `SELECT cost_usd AS cost, total_tokens AS tokens, prompt_count
       FROM otel_rollup_ticket
      WHERE project_secret = $1 AND ticket_number = $2`,
    [secretParam, ticketNumber],
  );
  const durationResult = await db.query<{ total_seconds: string | null }>(
    `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (last_ts - first_ts))), 0) AS total_seconds
       FROM otel_ticket_prompt_span
      WHERE project_secret = $1 AND ticket_number = $2`,
    [secretParam, ticketNumber],
  );

  // `.at(0)` (not `[0]`) so the type is `… | undefined` — the scalar query
  // returns NO row for an unattributed ticket, and the optional chain below is
  // then legitimate. The duration query is a COALESCE(SUM(...)) aggregate, so it
  // always returns exactly one row.
  const row = scalarResult.rows.at(0);
  return {
    ticketNumber,
    promptCount: row?.prompt_count ?? 0,
    totalCost: Number(row?.cost ?? 0),
    totalTokens: Number(row?.tokens ?? 0),
    totalDurationSeconds: Number(durationResult.rows[0].total_seconds ?? '0'),
  };
}

/**
 * HS-9257 — the ORIGINAL raw-scanning per-ticket computation, extracted so the
 * HS-9234 backfill (`backfillTicketsForDir`) can populate `otel_rollup_ticket`
 * from the canonical raw source WITHOUT calling the now-rollup-reading
 * `getPerTicketRollup` (which would be circular — reading the table it fills).
 * Reads the given CLUSTER db (raw `otel_events` + `ticket_work_intervals`).
 */
export async function computeTicketRollupFromRaw(db: PGlite, ticketNumber: string, secret?: string): Promise<TicketRollup> {
  // The marker substring we LIKE for. HS-9248 retired the client injection
  // (`channelUI.tsx::tagMessageWithActiveTicket`), so this path now only matches
  // HISTORICAL prompts that already carry the marker; new-work attribution comes
  // from the time-window path below. Kept so that older tagged prompts keep
  // attributing.
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
/**
 * HS-8874 — a loaded project, for the cross-project fan-out. Each project's
 * telemetry lives in its own DB now, so the dashboard reads each project's DB
 * (filtered by that project's own secret) and merges in JS.
 */
export interface DashboardProject {
  secret: string;
  dataDir: string;
}

export async function getDashboardPayload(
  window: DashboardWindow,
  timezone = 'UTC',
  projects: ReadonlyArray<DashboardProject> | null = null,
  now: Date = new Date(),
): Promise<DashboardPayload> {
  const { midnight, weekStart, monthStart } = windowBoundaries(now);
  const windowSinceTs = resolveDashboardWindowSinceTs(window, now);

  // HS-8874 — back-compat / tests: when no `projects` list is supplied, run each
  // rollup ONCE in the ambient telemetry context with no project filter (the
  // pre-fan-out behavior). The route always passes the loaded-projects list.
  if (projects === null) {
    const [today, week, month, allTime, costByProject, costByModel, hourlyActivity, costOverTime, ingestedDates, announcerByProject] = await Promise.all([
      getWindowTotals(null, midnight, null),
      getWindowTotals(null, weekStart, null),
      getWindowTotals(null, monthStart, null),
      getWindowTotals(null, null, null),
      getCostByProject(windowSinceTs, null),
      getCostByModel(null, windowSinceTs, null),
      getHourlyActivityHeatmap(windowSinceTs, timezone, null),
      getCostOverTime(windowSinceTs, null, timezone, now, null),
      getIngestedDates(windowSinceTs, null, timezone, null),
      getAnnouncerUsageByProject(null, windowSinceTs),
    ]);
    return {
      window,
      windowTotals: { today, week, month, allTime },
      costByProject,
      costByModel,
      hourlyActivity,
      costOverTime,
      ingestedDates,
      announcer: { total: sumAnnouncerUsage(announcerByProject), byProject: announcerByProject },
    };
  }

  // HS-8874 — FAN OUT. For each loaded project P, read P's OWN DB filtered by
  // P's OWN secret; also read the central store (no-project rows). Reading P's
  // DB with `projectSecret = P.secret` is what prevents the non-destructive
  // migration from double-counting: un-deleted source rows for OTHER projects
  // that may still sit in P's old launch-default DB are excluded by the secret
  // filter. The central read uses `null` as the secret (central rows carry a
  // NULL `project_secret`) so they aren't filtered out.
  const sources: Array<{ dataDir: string; secret: string | null }> = [
    ...projects.map(p => ({ dataDir: p.dataDir, secret: p.secret })),
    { dataDir: centralTelemetryDataDir(), secret: null },
  ];

  // Per-source results, each read in that source's DB context.
  const perSource = await Promise.all(sources.map(src =>
    runWithTelemetryDb(src.dataDir, async () => {
      const [today, week, month, allTime, costByProject, costByModel, hourlyActivity, costOverTime, ingestedDates, announcerByProject] = await Promise.all([
        getWindowTotals(src.secret, midnight),
        getWindowTotals(src.secret, weekStart),
        getWindowTotals(src.secret, monthStart),
        getWindowTotals(src.secret, null),
        getCostByProject(windowSinceTs, src.secret === null ? null : [src.secret]),
        getCostByModel(src.secret, windowSinceTs),
        getHourlyActivityHeatmap(windowSinceTs, timezone, src.secret === null ? null : [src.secret]),
        getCostOverTime(windowSinceTs, src.secret, timezone, now),
        getIngestedDates(windowSinceTs, src.secret, timezone),
        getAnnouncerUsageByProject(src.secret === null ? null : [src.secret], windowSinceTs),
      ]);
      return { today, week, month, allTime, costByProject, costByModel, hourlyActivity, costOverTime, ingestedDates, announcerByProject };
    }),
  ));

  // Merge in JS.
  const today = sumWindowTotals(perSource.map(s => s.today));
  const week = sumWindowTotals(perSource.map(s => s.week));
  const month = sumWindowTotals(perSource.map(s => s.month));
  const allTime = sumWindowTotals(perSource.map(s => s.allTime));
  const costByProject = perSource.flatMap(s => s.costByProject);
  const costByModel = mergeCostByModel(perSource.flatMap(s => s.costByModel));
  const hourlyActivity = mergeHourlyActivity(perSource.map(s => s.hourlyActivity));
  const costOverTime = perSource.flatMap(s => s.costOverTime);
  const ingestedDates = [...new Set(perSource.flatMap(s => s.ingestedDates))].sort();
  const announcerByProject = perSource.flatMap(s => s.announcerByProject);

  return {
    window,
    windowTotals: { today, week, month, allTime },
    costByProject,
    costByModel,
    hourlyActivity,
    costOverTime,
    ingestedDates,
    announcer: { total: sumAnnouncerUsage(announcerByProject), byProject: announcerByProject },
  };
}

/** HS-8874 — sum every numeric field of a set of WindowTotals across DBs. */
function sumWindowTotals(parts: WindowTotals[]): WindowTotals {
  return parts.reduce<WindowTotals>((acc, w) => ({
    cost: acc.cost + w.cost,
    tokens: acc.tokens + w.tokens,
    inputTokens: acc.inputTokens + w.inputTokens,
    outputTokens: acc.outputTokens + w.outputTokens,
    cacheReadTokens: acc.cacheReadTokens + w.cacheReadTokens,
    cacheCreationTokens: acc.cacheCreationTokens + w.cacheCreationTokens,
    promptCount: acc.promptCount + w.promptCount,
  }), { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, promptCount: 0 });
}

/** HS-8874 — group cost-by-model rows from multiple DBs by model, summing each
 *  numeric field; sorted by cost descending (matching the single-DB query). */
function mergeCostByModel(rows: ModelRollup[]): ModelRollup[] {
  const byModel = new Map<string, ModelRollup>();
  for (const r of rows) {
    const existing = byModel.get(r.model);
    if (existing === undefined) {
      byModel.set(r.model, { ...r });
    } else {
      existing.cost += r.cost;
      existing.tokens += r.tokens;
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.promptCount += r.promptCount;
    }
  }
  return Array.from(byModel.values()).sort((a, b) => b.cost - a.cost);
}

/** HS-8874 — merge the 168-cell (dow, hour) heatmaps from multiple DBs, summing
 *  cost + promptCount per cell. Each input is already densified to 168 cells in
 *  the same dow*24+hour order, so a positional reduce is safe. */
function mergeHourlyActivity(grids: HourlyActivityCell[][]): HourlyActivityCell[] {
  const merged: HourlyActivityCell[] = [];
  for (let dow = 0; dow < 7; dow++) {
    for (let hour = 0; hour < 24; hour++) {
      merged.push({ dow, hour, cost: 0, promptCount: 0 });
    }
  }
  for (const grid of grids) {
    for (const cell of grid) {
      const idx = cell.dow * 24 + cell.hour;
      if (idx >= 0 && idx < merged.length) {
        merged[idx].cost += cell.cost;
        merged[idx].promptCount += cell.promptCount;
      }
    }
  }
  return merged;
}

/** Sum a per-project Announcer breakdown into one totals object (HS-8766). */
function sumAnnouncerUsage(rows: AnnouncerUsageByProjectRow[]): AnnouncerUsageTotals {
  return rows.reduce<AnnouncerUsageTotals>((acc, r) => ({
    cost: acc.cost + r.cost,
    inputTokens: acc.inputTokens + r.inputTokens,
    outputTokens: acc.outputTokens + r.outputTokens,
    generations: acc.generations + r.generations,
  }), { cost: 0, inputTokens: 0, outputTokens: 0, generations: 0 });
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
  /** HS-8810 — local-calendar days in the window with ≥1 ingested metric point
   *  (this project). Lets the chart distinguish a no-telemetry day from a $0 day. */
  ingestedDates: string[];
  /** HS-8766 — Announcer token usage + cost for this project in the window. */
  announcer: AnnouncerUsageTotals;
}

export async function getProjectRollupPayload(
  projectSecret: string,
  window: DashboardWindow,
  timezone = 'UTC',
  now: Date = new Date(),
): Promise<ProjectRollupPayload> {
  const { midnight, weekStart, monthStart } = windowBoundaries(now);
  const windowSinceTs = resolveDashboardWindowSinceTs(window, now);

  const [today, week, month, allTime, costByModel, toolLatencyHistogram, recentPrompts, costOverTime, ingestedDates, announcer] = await Promise.all([
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
    getIngestedDates(windowSinceTs, projectSecret, timezone),
    getAnnouncerUsageTotals(projectSecret, windowSinceTs),
  ]);

  return {
    window,
    windowTotals: { today, week, month, allTime },
    costByModel,
    toolLatencyHistogram,
    recentPrompts,
    costOverTime,
    ingestedDates,
    announcer,
  };
}
