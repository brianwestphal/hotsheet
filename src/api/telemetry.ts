/**
 * HS-8632 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * telemetry domain (read-only `GET`s + the one retention `DELETE`) in
 * `src/routes/telemetry.ts`. The OTLP receiver routes (`POST /v1/*`) are NOT
 * part of this contract — they ingest protobuf, not JSON.
 *
 * Endpoints:
 *   - `GET    /telemetry/today-cost`              → cost number
 *   - `GET    /telemetry/today-cost-by-project`   → secret → cost map
 *   - `GET    /telemetry/prompt/:id`              → PromptTimeline + tracesEnabled
 *   - `GET    /telemetry/ticket/:number`          → TicketRollup
 *   - `GET    /telemetry/enabled-anywhere`        → boolean
 *   - `GET    /telemetry/dashboard?window=&tz=`   → DashboardPayload (cross-project)
 *   - `GET    /telemetry/project-rollup?window=&tz=` → ProjectRollupPayload
 *   - `DELETE /telemetry/project-data`            → deleted count
 *   - `GET    /telemetry/_debug`                  → TelemetryDebugInfo
 *
 * These schemas are the client-facing wire SSOT. The matching server-side
 * query-result interfaces live in `src/db/otelQueries.ts` (its internal
 * row-shaping types); the two are structurally identical by construction and
 * exercised against each other by `routes/telemetry` tests. (The deepest
 * dashboard payloads compose ~12 nested types, so — unlike the lighter domains
 * that reclaimed their type into `src/api/` — telemetry keeps the server
 * interfaces in place to bound the blast radius on that heavily-used module;
 * the wire contract is nonetheless centralized here.)
 *
 * The cross-project `/dashboard` read uses `skipProjectScope` (it aggregates
 * every project, not the active one); `getTelemetryDashboard` forwards it.
 */
import { z } from 'zod';

import { apiCall, qs } from './_runner.js';

export const DashboardWindowSchema = z.enum(['today', 'week', 'month', '90d', 'all']);
export type DashboardWindow = z.infer<typeof DashboardWindowSchema>;

// --- Leaf rollup shapes ---

export const WindowTotalsSchema = z.object({
  cost: z.number(),
  tokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  // HS-8639 added the cache split to the server's WindowTotals, but the client's
  // dashboard view-models + their fixtures predate it and only the cost chips
  // consume cache. Modeled optional so the schema accepts both the real server
  // output (which carries them) and those older shapes.
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  promptCount: z.number(),
});
export type WindowTotals = z.infer<typeof WindowTotalsSchema>;

export const ModelRollupSchema = z.object({
  model: z.string(),
  cost: z.number(),
  tokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  promptCount: z.number(),
});
export type ModelRollup = z.infer<typeof ModelRollupSchema>;

export const ToolLatencyHistogramSchema = z.object({
  tool: z.string(),
  count: z.number(),
  totalMs: z.number(),
  p50: z.number().nullable(),
  p90: z.number().nullable(),
  p99: z.number().nullable(),
  buckets: z.array(z.number()),
});
export type ToolLatencyHistogram = z.infer<typeof ToolLatencyHistogramSchema>;

export const RecentPromptSchema = z.object({
  promptId: z.string(),
  ts: z.string(),
  projectSecret: z.string(),
  model: z.string().nullable(),
  // HS-8779 — per-prompt enrichment. All optional + nullable so older
  // servers / fixtures (which sent only the four fields above) still validate;
  // the list UI treats a missing field the same as null ("no data").
  promptText: z.string().nullable().default(null),
  totalTokens: z.number().nullable().default(null),
  inputTokens: z.number().nullable().default(null),
  outputTokens: z.number().nullable().default(null),
  costUsd: z.number().nullable().default(null),
  durationMs: z.number().nullable().default(null),
  toolCount: z.number().nullable().default(null),
});
export type RecentPrompt = z.infer<typeof RecentPromptSchema>;

export const ProjectCostRowSchema = z.object({
  projectSecret: z.string(),
  cost: z.number(),
  tokens: z.number(),
  promptCount: z.number(),
  lastActivityTs: z.string().nullable(),
});
export type ProjectCostRow = z.infer<typeof ProjectCostRowSchema>;

export const HourlyActivityCellSchema = z.object({
  dow: z.number(),
  hour: z.number(),
  cost: z.number(),
  promptCount: z.number(),
});
export type HourlyActivityCell = z.infer<typeof HourlyActivityCellSchema>;

export const CostOverTimePointSchema = z.object({
  date: z.string(),
  projectSecret: z.string(),
  model: z.string(),
  cost: z.number(),
});
export type CostOverTimePoint = z.infer<typeof CostOverTimePointSchema>;

// HS-8766 — Announcer token usage + cost. Always real $$ (the user's own
// Anthropic key) — independent of the `telemetryCostMode` api/subscription
// toggle that governs Claude Code's cost display.
export const AnnouncerUsageTotalsSchema = z.object({
  cost: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  generations: z.number(),
});
export type AnnouncerUsageTotals = z.infer<typeof AnnouncerUsageTotalsSchema>;

export const AnnouncerUsageByProjectRowSchema = AnnouncerUsageTotalsSchema.extend({
  projectSecret: z.string(),
});
export type AnnouncerUsageByProjectRow = z.infer<typeof AnnouncerUsageByProjectRowSchema>;

export const TicketRollupSchema = z.object({
  ticketNumber: z.string(),
  promptCount: z.number(),
  totalCost: z.number(),
  totalTokens: z.number(),
  totalDurationSeconds: z.number(),
});
export type TicketRollup = z.infer<typeof TicketRollupSchema>;

// --- Prompt timeline ---

const JsonObjectSchema = z.record(z.string(), z.unknown());

export const SpanRowSchema = z.object({
  id: z.number(),
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  spanName: z.string(),
  startTs: z.string(),
  endTs: z.string(),
  attributesJson: JsonObjectSchema,
  statusCode: z.string().nullable(),
});

export const PromptTimelineEntrySchema = z.object({
  id: z.number(),
  ts: z.string(),
  eventName: z.string(),
  attributesJson: JsonObjectSchema,
  bodyJson: JsonObjectSchema.nullable(),
});

/** `GET /telemetry/prompt/:id` — the timeline plus the route's `tracesEnabled`
 *  flag (HS-8484) appended to the rollup. */
export const PromptTimelineResponseSchema = z.object({
  promptId: z.string(),
  projectSecret: z.string().nullable(),
  firstTs: z.string().nullable(),
  lastTs: z.string().nullable(),
  model: z.string().nullable(),
  entries: z.array(PromptTimelineEntrySchema),
  spans: z.array(SpanRowSchema),
  tracesEnabled: z.boolean(),
});
export type PromptTimelineResponse = z.infer<typeof PromptTimelineResponseSchema>;

// --- Composite dashboard payloads ---

const WindowTotalsBundleSchema = z.object({
  today: WindowTotalsSchema,
  week: WindowTotalsSchema,
  month: WindowTotalsSchema,
  allTime: WindowTotalsSchema,
});

// HS-8766 — cross-project Announcer spend: window total + per-project rows.
export const AnnouncerDashboardSchema = z.object({
  total: AnnouncerUsageTotalsSchema,
  byProject: z.array(AnnouncerUsageByProjectRowSchema),
});
export type AnnouncerDashboard = z.infer<typeof AnnouncerDashboardSchema>;

export const DashboardPayloadSchema = z.object({
  window: DashboardWindowSchema,
  windowTotals: WindowTotalsBundleSchema,
  costByProject: z.array(ProjectCostRowSchema),
  costByModel: z.array(ModelRollupSchema),
  hourlyActivity: z.array(HourlyActivityCellSchema),
  costOverTime: z.array(CostOverTimePointSchema),
  // HS-8810 — days with ≥1 ingested metric point; optional+default so older
  // servers/fixtures still validate (a missing list = no shading, prior behavior).
  ingestedDates: z.array(z.string()).default([]),
  // Optional so pre-HS-8766 fixtures/clients still validate (matches the
  // cacheReadTokens precedent on WindowTotals).
  announcer: AnnouncerDashboardSchema.optional(),
});
export type DashboardPayload = z.infer<typeof DashboardPayloadSchema>;

export const ProjectRollupPayloadSchema = z.object({
  window: DashboardWindowSchema,
  windowTotals: WindowTotalsBundleSchema,
  costByModel: z.array(ModelRollupSchema),
  toolLatencyHistogram: z.array(ToolLatencyHistogramSchema),
  recentPrompts: z.array(RecentPromptSchema),
  costOverTime: z.array(CostOverTimePointSchema),
  // HS-8810 — days with ≥1 ingested metric point for this project (optional+default).
  ingestedDates: z.array(z.string()).default([]),
  // HS-8766 — Announcer usage for this project (optional for back-compat).
  announcer: AnnouncerUsageTotalsSchema.optional(),
});
export type ProjectRollupPayload = z.infer<typeof ProjectRollupPayloadSchema>;

// --- Diagnostic (HS-8639 / HS-8537) ---

export const TelemetryDebugInfoSchema = z.object({
  eventNames: z.array(z.object({ eventName: z.string(), count: z.number(), withPromptId: z.number() })),
  tokenTypes: z.array(z.object({ type: z.string(), points: z.number(), tokens: z.number() })),
  totalEvents: z.number(),
  distinctPromptIds: z.number(),
  distinctSessions: z.number(),
  markerEventsByName: z.array(z.object({ eventName: z.string(), count: z.number() })),
  distinctTicketMarkers: z.array(z.string()),
  apiRequestAttrKeys: z.array(z.string()),
});
export type TelemetryDebugInfo = z.infer<typeof TelemetryDebugInfoSchema>;

// --- Small wrapper responses ---

const TodayCostRespSchema = z.object({ cost: z.number() });
const TodayCostByProjectRespSchema = z.object({ costs: z.record(z.string(), z.number()) });
const EnabledAnywhereRespSchema = z.object({ enabled: z.boolean() });
const ClearResultSchema = z.object({ deleted: z.number() });
export type ClearTelemetryResult = z.infer<typeof ClearResultSchema>;

// --- Typed callers ---

/** GET `/telemetry/today-cost` → today's total cost for the active project. */
export async function getTodayCost(): Promise<number> {
  const r = await apiCall(TodayCostRespSchema, '/telemetry/today-cost');
  return r.cost;
}

/** GET `/telemetry/today-cost-by-project` → `secret → cost` for every project
 *  with non-zero cost today. */
export async function getTodayCostByProject(): Promise<Record<string, number>> {
  const r = await apiCall(TodayCostByProjectRespSchema, '/telemetry/today-cost-by-project');
  return r.costs;
}

/** GET `/telemetry/prompt/:id` → the per-prompt timeline drilldown. */
export async function getPromptTimeline(promptId: string): Promise<PromptTimelineResponse> {
  return apiCall(PromptTimelineResponseSchema, `/telemetry/prompt/${encodeURIComponent(promptId)}`);
}

/** GET `/telemetry/ticket/:number` → per-ticket Claude-usage rollup. */
export async function getPerTicketRollup(ticketNumber: string): Promise<TicketRollup> {
  return apiCall(TicketRollupSchema, `/telemetry/ticket/${encodeURIComponent(ticketNumber)}`);
}

/** GET `/telemetry/enabled-anywhere` → true iff any project has telemetry on. */
export async function isTelemetryEnabledAnywhere(): Promise<boolean> {
  const r = await apiCall(EnabledAnywhereRespSchema, '/telemetry/enabled-anywhere');
  return r.enabled;
}

/** GET `/telemetry/dashboard` → cross-project dashboard payload. Reads every
 *  project (`skipProjectScope`), not the active one. */
export async function getTelemetryDashboard(window: DashboardWindow, tz: string): Promise<DashboardPayload> {
  return apiCall(DashboardPayloadSchema, `/telemetry/dashboard${qs({ window, tz })}`, { skipProjectScope: true });
}

/** GET `/telemetry/project-rollup` → the active project's analytics rollup. */
export async function getProjectRollup(window: DashboardWindow, tz: string): Promise<ProjectRollupPayload> {
  return apiCall(ProjectRollupPayloadSchema, `/telemetry/project-rollup${qs({ window, tz })}`);
}

/** DELETE `/telemetry/project-data` → wipe the active project's telemetry. */
export async function clearProjectTelemetry(): Promise<ClearTelemetryResult> {
  return apiCall(ClearResultSchema, '/telemetry/project-data', { method: 'DELETE' });
}

/** GET `/telemetry/_debug` → ingest/marker diagnostic (HS-8639 / HS-8537). */
export async function getTelemetryDebug(): Promise<TelemetryDebugInfo> {
  return apiCall(TelemetryDebugInfoSchema, '/telemetry/_debug');
}
