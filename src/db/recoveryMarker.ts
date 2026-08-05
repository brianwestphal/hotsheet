import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

import { getErrorMessage } from '../utils/errorMessage.js';

/**
 * `.db-recovery-marker.json` — the one on-disk record that says "your data is
 * not here, and it is recoverable", read by `GET /api/db/recovery-status` and
 * rendered as the launch-time banner (docs/135).
 *
 * Extracted from `src/db/connection.ts` by HS-9576 so the empty-cluster guard
 * (`emptyClusterGuard.ts`) can write one without importing `connection.ts`,
 * which imports the guard — a cycle. Nothing else about the format changed;
 * `connection.ts` re-exports the reader/clearer so existing callers are
 * untouched.
 */

/** Why the marker was written. Absent on markers written before HS-9576, which
 *  are all `corrupt-open` — so the reader defaults to that rather than
 *  discarding a marker an older build left behind. */
export type RecoveryMarkerKind = 'corrupt-open' | 'empty-cluster';

/** HS-7899: written when `recoverFromOpenFailure` falls all the way through to
 *  the rename-as-corrupt + fresh-cluster path, and (HS-9576) when the
 *  empty-cluster guard blocks a durability write. The client polls for this on
 *  launch so it can prompt the user to restore instead of silently presenting
 *  an empty Hot Sheet. Persisted (rather than process-local) so the prompt
 *  survives subsequent restarts until the user dismisses or restores. */
export interface DbRecoveryMarker {
  /** Absolute path the live `db/` directory was renamed to. Empty string for
   *  `empty-cluster`, where no rename happened in this process — the preserved
   *  directory, if any, was left by an earlier one. */
  corruptPath: string;
  /** ISO 8601 timestamp of when recovery happened. */
  recoveredAt: string;
  /** Underlying error message that triggered the recovery, for the UI. */
  errorMessage: string;
  /** HS-8587 — when the recovery auto-restored from a Snapshot Protection
   *  source (§73), the source label (`snapshot` / `backup:<tier>:<ts>`).
   *  Absent means no good source existed and we fell back to an empty
   *  fresh cluster — the client shows the blocking restore banner in that
   *  case, but a friendly "recovered from snapshot" toast when present. */
  restoredFrom?: string;
  /** HS-8587 — ticket count in the restored cluster, for the toast. */
  restoredTicketCount?: number;
  /** HS-9576 — which situation this marker describes. */
  kind?: RecoveryMarkerKind;
  /** HS-9576 — for `empty-cluster`: how many tickets this project's durability
   *  artifacts last captured, i.e. how much is waiting to be restored. */
  priorTicketCount?: number;
}

const RECOVERY_MARKER_FILENAME = '.db-recovery-marker.json';

function recoveryMarkerPath(dataDir: string): string {
  return join(dataDir, RECOVERY_MARKER_FILENAME);
}

// HS-8567 — zod-validate the marker file at the parse boundary.
const RecoveryMarkerFileSchema = z.object({
  corruptPath: z.string(),
  recoveredAt: z.string(),
  errorMessage: z.string().optional(),
  restoredFrom: z.string().optional(),
  restoredTicketCount: z.number().optional(),
  kind: z.enum(['corrupt-open', 'empty-cluster']).optional(),
  priorTicketCount: z.number().optional(),
}).loose();

/** Read the marker file for this dataDir, or null if no recovery has
 *  happened (or the user has already dismissed). Tolerates corrupt /
 *  unreadable marker files by returning null and silently moving on —
 *  the marker is informational, not load-bearing. */
export function readRecoveryMarker(dataDir: string): DbRecoveryMarker | null {
  const path = recoveryMarkerPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const result = RecoveryMarkerFileSchema.safeParse(parsed);
    if (!result.success) return null;
    return {
      corruptPath: result.data.corruptPath,
      recoveredAt: result.data.recoveredAt,
      errorMessage: result.data.errorMessage ?? '',
      restoredFrom: result.data.restoredFrom,
      restoredTicketCount: result.data.restoredTicketCount,
      kind: result.data.kind ?? 'corrupt-open',
      priorTicketCount: result.data.priorTicketCount,
    };
  } catch {
    return null;
  }
}

export function writeRecoveryMarker(dataDir: string, marker: DbRecoveryMarker): void {
  try {
    writeFileSync(recoveryMarkerPath(dataDir), JSON.stringify(marker, null, 2));
  } catch (writeErr: unknown) {
    const writeMessage = getErrorMessage(writeErr);
    console.error(`Could not write DB recovery marker: ${writeMessage}`);
  }
}

/** Clear the marker. Called when the user dismisses the recovery banner
 *  or successfully restores from backup. Idempotent — missing file is
 *  fine. */
export function clearRecoveryMarker(dataDir: string): void {
  const path = recoveryMarkerPath(dataDir);
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

/**
 * HS-9576 — clear the marker ONLY when it describes the empty-cluster state.
 *
 * The guard calls this the moment the cluster has rows again, which ends the
 * situation the banner describes. A `corrupt-open` marker must survive that:
 * it records that a cluster was renamed aside, which stays true (and still
 * worth telling the user about) no matter how many tickets exist now.
 */
export function clearEmptyClusterMarker(dataDir: string): void {
  if (readRecoveryMarker(dataDir)?.kind !== 'empty-cluster') return;
  clearRecoveryMarker(dataDir);
}
