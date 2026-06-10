/**
 * HS-8638 (HS-8522 closeout) — typed callers + wire schemas for the grab-bag
 * of endpoints in `src/routes/dashboard.ts`: the analytics dashboard, ticket
 * stats, the long-poll version cursor, the folder browser, worklist info,
 * skill regeneration, the glassbox sidecar probe/launch, and HTML print.
 * (The `/global-config` endpoints in the same route file are owned by
 * `src/api/settings.ts`.)
 *
 * `DashboardDataSchema` + `BrowseResultSchema` are the wire SSOT — the client
 * `dashboard.tsx` / `openFolder.tsx` previously declared these inline.
 */
import { z } from 'zod';

import { type PrintSchema } from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema, qs } from './_runner.js';
import { type GlassboxReviewReq } from './git.js';

// --- /dashboard ---
export const DashboardDataSchema = z.object({
  throughput: z.array(z.object({ date: z.string(), completed: z.number(), created: z.number() })),
  cycleTime: z.array(z.object({ ticket_number: z.string(), title: z.string(), completed_at: z.string(), hours: z.number() })),
  categoryBreakdown: z.array(z.object({ category: z.string(), count: z.number() })),
  categoryPeriod: z.array(z.object({ category: z.string(), count: z.number() })),
  snapshots: z.array(z.object({
    date: z.string(),
    data: z.object({ not_started: z.number(), started: z.number(), completed: z.number(), verified: z.number() }),
  })),
  kpi: z.object({
    completedThisWeek: z.number(),
    completedLastWeek: z.number(),
    wipCount: z.number(),
    createdThisWeek: z.number(),
    medianCycleTimeDays: z.number().nullable(),
  }),
});
export type DashboardData = z.infer<typeof DashboardDataSchema>;

// --- /stats ---
export const TicketStatsSchema = z.object({
  total: z.number(),
  open: z.number(),
  up_next: z.number(),
  by_category: z.record(z.string(), z.number()),
  by_status: z.record(z.string(), z.number()),
});
export type TicketStats = z.infer<typeof TicketStatsSchema>;

// --- /sidebar-counts (HS-8511) ---
export const SidebarCountsSchema = z.object({
  /** `viewId → count` for every sidebar entry (built-in, category:*, priority:*,
   *  backlog/archive/trash, custom:*). View ids match the `data-view` attrs. */
  counts: z.record(z.string(), z.number()),
});
export type SidebarCounts = z.infer<typeof SidebarCountsSchema>;

// --- /poll ---
const PollResultSchema = z.object({ version: z.number(), dataVersion: z.number() });

// --- /browse ---
export const BrowseResultSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), hasHotsheet: z.boolean() })),
  hasHotsheet: z.boolean(),
});
export type BrowseResult = z.infer<typeof BrowseResultSchema>;

const WorklistInfoSchema = z.object({ prompt: z.string(), skillCreated: z.boolean() });
const EnsureSkillsResultSchema = z.object({ updated: z.boolean() });
const GlassboxStatusSchema = z.object({ available: z.boolean() });
const PrintResultSchema = z.object({ ok: z.literal(true), path: z.string() });

export type PrintReq = z.infer<typeof PrintSchema>;

// --- Typed callers ---

/** GET `/dashboard?days=N` → the analytics dashboard payload. */
export async function getDashboard(days: number): Promise<DashboardData> {
  return apiCall(DashboardDataSchema, `/dashboard${qs({ days })}`);
}

/** GET `/stats` → ticket counts (total / open / up-next + by category/status). */
export async function getStats(): Promise<TicketStats> {
  return apiCall(TicketStatsSchema, '/stats');
}

/** GET `/sidebar-counts` → per-view ticket counts for the sidebar badges (HS-8511). */
export async function getSidebarCounts(): Promise<SidebarCounts> {
  return apiCall(SidebarCountsSchema, '/sidebar-counts');
}

/** GET `/poll?version=N` → the long-poll version cursor (waits server-side). */
export async function pollVersion(version: number): Promise<{ version: number; dataVersion: number }> {
  return apiCall(PollResultSchema, `/poll${qs({ version })}`);
}

/** GET `/browse?path=…` → directory listing for the open-folder picker. */
export async function browse(path?: string): Promise<BrowseResult> {
  return apiCall(BrowseResultSchema, `/browse${qs({ path })}`);
}

/** GET `/worklist-info` → the worklist prompt + whether skills were just created. */
export async function getWorklistInfo(): Promise<z.infer<typeof WorklistInfoSchema>> {
  return apiCall(WorklistInfoSchema, '/worklist-info');
}

/** POST `/ensure-skills` → (re)generate the AI-tool skill files for every project. */
export async function ensureSkills(): Promise<{ updated: boolean }> {
  return apiCall(EnsureSkillsResultSchema, '/ensure-skills', { method: 'POST' });
}

/** GET `/glassbox/status` → whether the `glassbox` CLI sidecar is installed. */
export async function getGlassboxStatus(): Promise<{ available: boolean }> {
  return apiCall(GlassboxStatusSchema, '/glassbox/status');
}

/** POST `/glassbox/launch` → launch the glassbox sidecar. */
export async function launchGlassbox(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/glassbox/launch', { method: 'POST' });
}

/** POST `/glassbox/review` → open Glassbox focused on a commit or pending range (HS-8472). */
export async function reviewInGlassbox(req: GlassboxReviewReq): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/glassbox/review', { method: 'POST', body: req });
}

/** POST `/print` → write an HTML doc to a temp file for printing; returns its path. */
export async function printHtml(html: string): Promise<z.infer<typeof PrintResultSchema>> {
  const body: PrintReq = { html };
  return apiCall(PrintResultSchema, '/print', { method: 'POST', body });
}
