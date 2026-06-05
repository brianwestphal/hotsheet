/**
 * §78 Announcer (HS-8745) — typed wire schemas + callers for the announcer
 * endpoints (`src/routes/announcer.ts`). Single source of truth shared by the
 * server handlers (request validation) and the Phase 1b client. See docs/78.
 */
import { z } from 'zod';

import { apiCall, OkResponseSchema } from './_runner.js';

// --- Wire shapes ---

export const AnnouncementSchema = z.object({
  id: z.number(),
  created_at: z.string(),
  covers_from: z.string().nullable(),
  covers_to: z.string().nullable(),
  title: z.string(),
  script: z.string(),
  position: z.number(),
  dismissed: z.boolean(),
}).loose();
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const AnnouncerStatusSchema = z.object({
  enabled: z.boolean(),
  hasKey: z.boolean(),
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

export const SetAnnouncerKeyReqSchema = z.object({ key: z.string().min(1) });
export const SetAnnouncerEnabledReqSchema = z.object({ enabled: z.boolean() });
export const AdvanceCursorReqSchema = z.object({ at: z.string().optional() });

// --- Typed callers (used by the Phase 1b client) ---

export async function getAnnouncerStatus(): Promise<AnnouncerStatus> {
  return apiCall(AnnouncerStatusSchema, '/announcer/status');
}

export async function generateAnnouncements(req: GenerateAnnouncementsReq = {}): Promise<z.infer<typeof GenerateAnnouncementsResSchema>> {
  return apiCall(GenerateAnnouncementsResSchema, '/announcer/generate', { method: 'POST', body: req });
}

export async function getAnnouncerEntries(): Promise<Announcement[]> {
  return (await apiCall(EntriesResSchema, '/announcer/entries')).entries;
}

export async function advanceAnnouncerCursor(at?: string): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/cursor', { method: 'POST', body: { at } });
}

export async function setAnnouncerKey(key: string): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/key', { method: 'PUT', body: { key } });
}

export async function setAnnouncerEnabled(enabled: boolean): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/enabled', { method: 'POST', body: { enabled } });
}

export async function dismissAnnouncement(id: number): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, `/announcer/dismiss/${String(id)}`, { method: 'POST' });
}

export async function clearAnnouncements(): Promise<{ ok: true }> {
  return apiCall(OkResponseSchema, '/announcer/clear', { method: 'POST' });
}
