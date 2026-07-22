/**
 * HS-8636 (HS-8522 typed-API layer) — typed callers + wire schemas for the
 * DB recovery / snapshot / repair endpoints (`src/routes/db.ts`, §42 / §73).
 *
 * Endpoints:
 *   - `GET  /db/recovery-status`               → recovery marker (or null)
 *   - `POST /db/dismiss-recovery`              → ok
 *   - `GET  /db/snapshot-status`               → SnapshotStatus
 *   - `POST /db/repair/find-working-backup`    → WorkingBackup (or null)  — 500 on error
 *   - `GET  /db/repair/pg-resetwal-availability` → ResetwalAvailability
 *   - `POST /db/repair/run-pg-resetwal`        → RepairResult             — 400/500 on error
 */
import { z } from 'zod';

import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

/** Launch-time DB-recovery marker (HS-7899). Matches `DbRecoveryMarker` in
 *  `src/db/connection.ts`. Written when the live `db/` was renamed aside and a
 *  fresh cluster created; `restoredFrom` is set when §73 auto-restored. */
export const RecoveryMarkerSchema = z.object({
  corruptPath: z.string(),
  recoveredAt: z.string(),
  errorMessage: z.string(),
  restoredFrom: z.string().optional(),
  restoredTicketCount: z.number().optional(),
});
export type RecoveryMarker = z.infer<typeof RecoveryMarkerSchema>;

const RecoveryStatusRespSchema = z.object({ marker: RecoveryMarkerSchema.nullable() });

/** §73 Snapshot Protection status line. All null until the first snapshot of
 *  the session lands. Matches `getSnapshotStatus`'s return in `db/snapshot.ts`.
 *  HS-9361 — `lastSnapshotStartedAt` (optional for older servers) is the
 *  content-cutoff bound: a snapshot contains everything committed before its
 *  START, while `lastSnapshotAt` is just when the write finished. */
export const SnapshotStatusSchema = z.object({
  lastSnapshotAt: z.number().nullable(),
  lastSnapshotStartedAt: z.number().nullable().optional(),
  lastSizeBytes: z.number().nullable(),
});
export type SnapshotStatus = z.infer<typeof SnapshotStatusSchema>;

/** A backup that loaded cleanly during repair. Matches `WorkingBackup`. */
export const WorkingBackupSchema = z.object({
  tier: z.string(),
  filename: z.string(),
  ticketCount: z.number(),
  createdAt: z.string(),
});
export type WorkingBackup = z.infer<typeof WorkingBackupSchema>;

const FindWorkingBackupRespSchema = z.object({ backup: WorkingBackupSchema.nullable() });

/** `pg_resetwal` probe result + platform-specific install help. Matches
 *  `ResetwalAvailability` in `db/repair.ts` (`platform` is `NodeJS.Platform`,
 *  serialized as a plain string on the wire). */
export const ResetwalAvailabilitySchema = z.object({
  available: z.boolean(),
  path: z.string().nullable(),
  platform: z.string(),
  installInstructions: z.object({
    description: z.string(),
    command: z.string(),
    url: z.string(),
  }),
});
export type ResetwalAvailability = z.infer<typeof ResetwalAvailabilitySchema>;

/** Result of a successful `pg_resetwal` repair + dump. Matches `RepairResult`. */
export const RepairResultSchema = z.object({
  tier: z.string(),
  filename: z.string(),
  ticketCount: z.number(),
  sizeBytes: z.number(),
});
export type RepairResult = z.infer<typeof RepairResultSchema>;

/** GET `/db/recovery-status` → the recovery marker, or null when healthy. */
export async function getRecoveryStatus(): Promise<RecoveryMarker | null> {
  const r = await apiCall(RecoveryStatusRespSchema, '/db/recovery-status');
  return r.marker;
}

/** POST `/db/dismiss-recovery` → clear the recovery marker. */
export async function dismissRecovery(): Promise<OkResponse> {
  return apiCall(OkResponseSchema, '/db/dismiss-recovery', { method: 'POST' });
}

/** GET `/db/snapshot-status` → last-snapshot metadata for the status line. */
export async function getSnapshotStatus(): Promise<SnapshotStatus> {
  return apiCall(SnapshotStatusSchema, '/db/snapshot-status');
}

/** POST `/db/repair/find-working-backup` → first backup that opens cleanly. */
export async function findWorkingBackup(): Promise<WorkingBackup | null> {
  const r = await apiCall(FindWorkingBackupRespSchema, '/db/repair/find-working-backup', { method: 'POST' });
  return r.backup;
}

/** GET `/db/repair/pg-resetwal-availability` → probe + install instructions. */
export async function getResetwalAvailability(): Promise<ResetwalAvailability> {
  return apiCall(ResetwalAvailabilitySchema, '/db/repair/pg-resetwal-availability');
}

/** POST `/db/repair/run-pg-resetwal` → run the repair + dump a fresh tarball. */
export async function runResetwal(): Promise<RepairResult> {
  return apiCall(RepairResultSchema, '/db/repair/run-pg-resetwal', { method: 'POST' });
}
