/**
 * §78 Announcer (HS-8745) — typed wire schemas + callers for the announcer
 * endpoints (`src/routes/announcer.ts`). Single source of truth shared by the
 * server handlers (request validation) and the Phase 1b client. See docs/78.
 */
import { z } from 'zod';

import { VisualsArraySchema } from '../schemas.js';
import { apiCall, OkResponseSchema } from './_runner.js';

// --- Wire shapes ---

export const AnnouncementSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  covers_from: z.string().nullable(),
  covers_to: z.string().nullable(),
  title: z.string(),
  script: z.string(),
  // HS-8749 — key phrases (verbatim substrings of `script`) the PIP emphasizes.
  // Defaults to [] for legacy/curated rows the server may omit.
  emphasis: z.array(z.string()).default([]),
  // HS-8772 — tier-2 visuals (today: code diffs) rendered alongside the script.
  visuals: VisualsArraySchema.default([]),
  position: z.number(),
  dismissed: z.boolean(),
}).loose();
export type Announcement = z.infer<typeof AnnouncementSchema>;

// HS-8762/8758 — cross-project overview for the context dropdown + the
// "any project enabled" button gate.
export const AnnouncerProjectInfoSchema = z.object({
  secret: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  hasKey: z.boolean(),
  entryCount: z.number(),
});
export type AnnouncerProjectInfo = z.infer<typeof AnnouncerProjectInfoSchema>;

export const AnnouncerOverviewSchema = z.object({
  activeSecret: z.string().nullable(),
  projects: z.array(AnnouncerProjectInfoSchema),
});
export type AnnouncerOverview = z.infer<typeof AnnouncerOverviewSchema>;

export const AnnouncerStatusSchema = z.object({
  enabled: z.boolean(),
  hasKey: z.boolean(),
  /** HS-8751 — the registry key id this project selected (null = use default). */
  selectedKeyId: z.string().nullable(),
  entryCount: z.number(),
  lastListenedAt: z.string().nullable(),
});
export type AnnouncerStatus = z.infer<typeof AnnouncerStatusSchema>;

export const GenerateAnnouncementsReqSchema = z.object({
  /** Override the "since" cursor; default = the project's last-listened / last-generated mark. */
  since: z.string().optional(),
});
export type GenerateAnnouncementsReq = z.infer<typeof GenerateAnnouncementsReqSchema>;

export const GenerateAnnouncementsResSchema = z.object({
  entries: z.array(AnnouncementSchema),
  generated: z.number(),
});

export const EntriesResSchema = z.object({ entries: z.array(AnnouncementSchema) });

// HS-8751 — pick which registry key (by id) the announcer uses for this
// project; null clears the selection (falls back to the first Anthropic key).
export const SelectAnnouncerKeyReqSchema = z.object({ keyId: z.string().nullable() });
export const SetAnnouncerEnabledReqSchema = z.object({ enabled: z.boolean() });
export const AdvanceCursorReqSchema = z.object({ at: z.string().optional() });
// HS-8750 — register/renew (true) or drop (false) a live-listen lease.
export const SetAnnouncerLiveReqSchema = z.object({ enabled: z.boolean() });
// HS-8769 — replace the per-project "uninteresting" topic list.
export const SetDismissedTopicsReqSchema = z.object({ topics: z.array(z.string()) });
export const DismissedTopicsResSchema = z.object({ topics: z.array(z.string()) });
// HS-8771 — a curated announcement pushed by the working agent (hotsheet_announce).
// HS-8772 — optionally carries a code diff the PIP renders alongside the script.
export const AnnounceDiffSchema = z.object({
  oldStr: z.string(),
  newStr: z.string(),
  filePath: z.string().nullable().optional(),
  replaceAll: z.boolean().optional(),
});
export const AnnounceReqSchema = z.object({
  title: z.string().min(1),
  highlight: z.string().min(1),
  diff: AnnounceDiffSchema.optional(),
});

// --- Typed callers (used by the Phase 1b client) ---

export async function getAnnouncerOverview(): Promise<AnnouncerOverview> {
  return apiCall(AnnouncerOverviewSchema, '/announcer/overview');
}

export async function getAnnouncerStatus(): Promise<AnnouncerStatus> {
  return apiCall(AnnouncerStatusSchema, '/announcer/status');
}

// HS-8762 — `secret` targets a specific project (routes through `apiWithSecret`)
// so the context dropdown can generate/read/dismiss/advance a project other than
// the active one. Omitted → the active project (the existing behavior).
export async function generateAnnouncements(req: GenerateAnnouncementsReq = {}, secret?: string): Promise<z.infer<typeof GenerateAnnouncementsResSchema>> {
  return apiCall(GenerateAnnouncementsResSchema, '/announcer/generate', { method: 'POST', body: req, secret });
}

export async function getAnnouncerEntries(secret?: string): Promise<Announcement[]> {
  return (await apiCall(EntriesResSchema, '/announcer/entries', { secret })).entries;
}

export async function advanceAnnouncerCursor(at?: string, secret?: string): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/cursor', { method: 'POST', body: { at }, secret });
}

export async function selectAnnouncerKey(keyId: string | null): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/key-selection', { method: 'POST', body: { keyId } });
}

export async function setAnnouncerEnabled(enabled: boolean): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/enabled', { method: 'POST', body: { enabled } });
}

// HS-8750 — register/renew or drop this project's live-listen lease. `secret`
// targets a specific project (so the client can keep a non-active project live).
export async function setAnnouncerLive(enabled: boolean, secret?: string): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/live', { method: 'POST', body: { enabled }, secret });
}

export async function dismissAnnouncement(id: number, secret?: string): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, `/announcer/dismiss/${String(id)}`, { method: 'POST', secret });
}

// HS-8769 — the per-project "uninteresting" topic list (Settings editor).
export async function getAnnouncerDismissedTopics(): Promise<string[]> {
  return (await apiCall(DismissedTopicsResSchema, '/announcer/dismissed-topics')).topics;
}

export async function setAnnouncerDismissedTopics(topics: string[]): Promise<string[]> {
  return (await apiCall(DismissedTopicsResSchema, '/announcer/dismissed-topics', { method: 'PUT', body: { topics } })).topics;
}

export async function clearAnnouncements(): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/clear', { method: 'POST' });
}
