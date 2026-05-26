/**
 * HS-8636 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * backup endpoints (`src/routes/backups.ts`). Request bodies reuse the existing
 * `CreateBackupSchema` / `RestoreBackupSchema` (zod-only → client-safe).
 *
 * Endpoints:
 *   - `GET  /backups`                          → backups list
 *   - `POST /backups/create`                   → BackupInfo (body: tier)   — 409 if busy
 *   - `POST /backups/now`                      → BackupInfo                 — 409 if busy
 *   - `GET  /backups/preview/:tier/:filename`  → BackupPreview              — 400 on bad file
 *   - `POST /backups/preview/cleanup`          → ok
 *   - `POST /backups/restore`                  → ok (body: tier, filename)  — 500 on failure
 */
import { z } from 'zod';

import { BackupTierSchema, type CreateBackupSchema, type RestoreBackupSchema } from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

/** A single backup tarball's metadata. Matches `BackupInfo` in `src/backup.ts`. */
export const BackupInfoSchema = z.object({
  tier: BackupTierSchema,
  filename: z.string(),
  createdAt: z.string(),
  ticketCount: z.number(),
  sizeBytes: z.number(),
});
export type BackupInfo = z.infer<typeof BackupInfoSchema>;

const BackupListRespSchema = z.object({ backups: z.array(BackupInfoSchema) });

/** `GET /backups/preview/:tier/:filename` — a read-only snapshot of the
 *  backup's tickets for the preview banner. `tickets` are raw rows straight
 *  out of the backed-up cluster; they're kept loosely typed because an older
 *  backup may predate the current ticket-column set (validating against the
 *  strict `TicketSchema` would reject loadable old backups). */
export const BackupPreviewSchema = z.object({
  tickets: z.array(z.record(z.string(), z.unknown())),
  stats: z.object({ total: z.number(), open: z.number(), upNext: z.number() }),
});
export type BackupPreview = z.infer<typeof BackupPreviewSchema>;

export type CreateBackupReq = z.infer<typeof CreateBackupSchema>;
export type RestoreBackupReq = z.infer<typeof RestoreBackupSchema>;

/** GET `/backups` → every backup tarball, newest tiers first. */
export async function listBackups(): Promise<BackupInfo[]> {
  const r = await apiCall(BackupListRespSchema, '/backups');
  return r.backups;
}

/** POST `/backups/create` → create a backup in the given tier. Throws (409)
 *  when a backup is already in progress. */
export async function createBackup(tier: CreateBackupReq['tier']): Promise<BackupInfo> {
  return apiCall(BackupInfoSchema, '/backups/create', { method: 'POST', body: { tier } });
}

/** POST `/backups/now` → trigger a manual backup. Throws (409) when busy. */
export async function triggerManualBackup(): Promise<BackupInfo> {
  return apiCall(BackupInfoSchema, '/backups/now', { method: 'POST' });
}

/** GET `/backups/preview/:tier/:filename` → load a backup's tickets for preview. */
export async function previewBackup(tier: string, filename: string): Promise<BackupPreview> {
  return apiCall(BackupPreviewSchema, `/backups/preview/${encodeURIComponent(tier)}/${encodeURIComponent(filename)}`);
}

/** POST `/backups/preview/cleanup` → drop the temp preview cluster. */
export async function cleanupBackupPreview(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/backups/preview/cleanup', { method: 'POST' });
}

/** POST `/backups/restore` → restore the given backup over the live DB. */
export async function restoreBackup(tier: string, filename: string): Promise<OkResponse> {
  const body: RestoreBackupReq = { tier, filename };
  return apiCall(OkResponseSchema, '/backups/restore', { method: 'POST', body });
}
