import { existsSync } from 'fs';
import { join } from 'path';

import { attachmentBlobsDir, indexExistingManifestEntries, restoreAttachmentBlob } from './attachmentBackup.js';
// HS-8555 — `rmSync`-and-swallow extracted into `deleteAttachmentFile`.
import { deleteAttachmentFile, getAllAttachments } from './db/attachments.js';
import { centralTelemetryDataDir, getTelemetryDb, runWithTelemetryDb } from './db/connection.js';
import {
  deleteAttachment,
  getAttachments,
  getSettings,
  getTicketsForCleanup,
  hardDeleteTicket,
  listOrphanDraftAttachments,
  updateTicket,
} from './db/queries.js';
import { getBackupDir, readFileSettings } from './file-settings.js';
import { ORPHAN_DRAFT_ATTACHMENT_HORIZON_MS } from './limits.js';
import { readProjectList } from './project-list.js';

// HS-8558 — the orphan-attachment horizon moved to `src/limits.ts` for
// cross-file consolidation. See the rationale comment block on the
// exported constant.

export async function cleanupAttachments(dataDir: string): Promise<void> {
  try {
    const settings = await getSettings();
    const verifiedDays = parseInt(settings.verified_cleanup_days, 10) || 30;
    const trashDays = parseInt(settings.trash_cleanup_days, 10) || 3;

    const tickets = await getTicketsForCleanup(verifiedDays, trashDays);

    let archived = 0;
    let deleted = 0;
    for (const ticket of tickets) {
      if (ticket.status === 'verified') {
        // Auto-archive verified tickets (not delete).
        // HS-8548 — the cast used to read `as never` because
        // `TicketStatus` predated the addition of `'archive'`; both
        // `TicketStatus` and the `updateTicket` signature now include
        // `'archive'` directly so no cast is needed.
        await updateTicket(ticket.id, { status: 'archive' });
        archived++;
      } else {
        // Hard-delete trashed tickets and their attachment files
        const attachments = await getAttachments(ticket.id);
        for (const att of attachments) deleteAttachmentFile(att);
        await hardDeleteTicket(ticket.id);
        deleted++;
      }
    }

    // HS-8428 — GC orphan draft attachments (rows whose `draft_id` no
    // longer matches any feedback_drafts row AND whose `created_at` is
    // older than the horizon). The client tries to clean these up on
    // dialog close-without-save, but a crashed tab / killed server /
    // network hiccup at the wrong moment leaves them behind. This sweep
    // is the backstop.
    let orphans = 0;
    const orphanList = await listOrphanDraftAttachments(ORPHAN_DRAFT_ATTACHMENT_HORIZON_MS);
    for (const att of orphanList) {
      deleteAttachmentFile(att);
      await deleteAttachment(att.id);
      orphans++;
    }

    if (archived > 0 || deleted > 0 || orphans > 0) {
      const parts: string[] = [];
      if (archived > 0) parts.push(`archived ${archived} verified ticket(s)`);
      if (deleted > 0) parts.push(`deleted ${deleted} trashed ticket(s)`);
      if (orphans > 0) parts.push(`GC'd ${orphans} orphan draft attachment(s)`);
      console.log(`  Cleanup: ${parts.join(', ')}.`);
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
  }

  // HS-8783 — self-heal attachment rows whose file was deleted out-of-band.
  await cleanupOrphanedAttachments(dataDir);
}

/**
 * HS-8783 / HS-8802 — self-heal attachment rows whose `stored_path` file was
 * removed out-of-band (deleted/pruned while the DB row lingers). For each
 * missing-file row:
 *  - **Recoverable** (content still in the backup store via a manifest cross-ref
 *    blob) → **restore** it: copy the blob back to `stored_path` so the broken
 *    image / 404 in the detail panel self-heals (HS-8802). A row that's
 *    recoverable but whose copy fails is left untouched to retry next sweep.
 *  - **Unrecoverable** (no cross-ref blob) → prune the row, mirroring the
 *    manual-reanalyze guard (`attachmentBackup.ts`).
 * Skips entirely when the backup root isn't present (e.g. a temporarily-
 * unmounted custom `backupDir`): without a readable store we can neither restore
 * nor prove non-recoverability, so we never risk a wrongful delete. Returns the
 * pruned + restored counts. Runs in the active project's DB context (caller
 * wraps it in `runWithDataDir`).
 */
export async function cleanupOrphanedAttachments(dataDir: string): Promise<{ pruned: number; restored: number }> {
  try {
    const backupRoot = getBackupDir(dataDir);
    if (!existsSync(backupRoot)) return { pruned: 0, restored: 0 };

    const missing = (await getAllAttachments()).filter(a => !existsSync(a.stored_path));
    if (missing.length === 0) return { pruned: 0, restored: 0 };

    const index = indexExistingManifestEntries(backupRoot);
    const blobsDir = attachmentBlobsDir(backupRoot);
    let pruned = 0;
    let restored = 0;
    for (const att of missing) {
      const xref = index.get(att.id);
      if (xref !== undefined && existsSync(join(blobsDir, xref.sha))) {
        // HS-8802 — content is still in the backup store: restore it instead of
        // leaving a broken row. The file is known-missing (filtered above), so
        // there's no live file to trample; restoring to the original
        // `stored_path` keeps the DB row valid with no rewrite.
        if (await restoreAttachmentBlob(blobsDir, xref.sha, att.stored_path)) restored++;
        continue; // recoverable — keep the row whether or not the copy succeeded
      }
      await deleteAttachment(att.id);
      pruned++;
    }
    if (pruned > 0 || restored > 0) {
      const parts: string[] = [];
      if (restored > 0) parts.push(`restored ${String(restored)} attachment file(s) from backups`);
      if (pruned > 0) parts.push(`pruned ${String(pruned)} attachment row(s) whose file is missing and unrecoverable from backups`);
      console.log(`  Cleanup: ${parts.join(', ')}.`);
    }
    return { pruned, restored };
  } catch (err) {
    console.error('Orphaned-attachment cleanup failed:', err);
    return { pruned: 0, restored: 0 };
  }
}

/**
 * HS-8154 — telemetry retention sweep (§67.6). Deletes `otel_metrics` /
 * `otel_events` / `otel_spans` rows older than the per-project
 * `telemetry_retention_days` setting (default 30, `0` = keep forever).
 *
 * Hooked into the same once-per-startup call point as
 * `cleanupAttachments` so we don't add a new timer. A future ticket
 * can add a periodic timer if long-running sessions show enough row
 * growth between startups to matter; at single-user scale today the
 * startup sweep is sufficient.
 *
 * Returns `{ deleted }` for tests; the function also logs a one-line
 * summary to stdout when rows were actually deleted, mirroring the
 * `cleanupAttachments` log shape.
 *
 * **HS-8607 — scopes deletion to THIS project's `project_secret`.**
 *
 * **HS-8874** — telemetry is now stored per-project (each project's own DB).
 * The sweep runs in THIS project's telemetry DB context (`runWithTelemetryDb`)
 * and deletes only rows whose `project_secret` matches — the secret filter is
 * defense-in-depth, since a non-destructively-migrated DB may still hold
 * un-deleted foreign rows. The cross-project driver
 * (`cleanupAllProjectsTelemetry`) iterates every project DB + the central
 * store. The `dataDir` passed in is BOTH the settings source AND the target
 * telemetry DB.
 */
export async function cleanupTelemetryRows(dataDir: string): Promise<{ deleted: number }> {
  try {
    const settings = readFileSettings(dataDir);
    const days = typeof settings.telemetry_retention_days === 'number'
      ? settings.telemetry_retention_days
      : 30;
    // `0` (or anything <= 0) means "keep forever" per §67.6.
    if (days <= 0) return { deleted: 0 };

    // HS-8607 — can't scope a deletion without the project's secret; bail
    // rather than risk an unscoped DELETE across the project's DB.
    const secret = typeof settings.secret === 'string' && settings.secret !== '' ? settings.secret : null;
    if (secret === null) return { deleted: 0 };

    const deleted = await runWithTelemetryDb(dataDir, async () => {
      const db = await getTelemetryDb();
      let n = 0;
      for (const table of ['otel_metrics', 'otel_events'] as const) {
        // `start_ts` for spans, `ts` for metrics + events.
        const result = await db.query(
          `DELETE FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval AND project_secret = $2`,
          [String(days), secret],
        );
        n += result.affectedRows ?? 0;
      }
      // Spans use `start_ts` not `ts` — separate query.
      const spansResult = await db.query(
        `DELETE FROM otel_spans WHERE start_ts < NOW() - ($1 || ' days')::interval AND project_secret = $2`,
        [String(days), secret],
      );
      n += spansResult.affectedRows ?? 0;
      return n;
    });

    if (deleted > 0) {
      console.log(`  Telemetry retention sweep: deleted ${String(deleted)} row(s) older than ${String(days)} day(s).`);
    }
    return { deleted };
  } catch (err) {
    console.error('Telemetry retention sweep failed:', err);
    return { deleted: 0 };
  }
}

/**
 * HS-8607 — sweep telemetry retention for EVERY registered project, not
 * just the launched one. Because all telemetry shares the primary DB
 * (keyed by `project_secret`), a per-launched-project sweep left every
 * OTHER project's rows un-pruned forever — `initProject` only runs the
 * sweep for the `dataDir` it was launched with. This iterates the
 * persisted project list (`~/.hotsheet/projects.json`) plus the launched
 * `dataDir` (deduped, in case it isn't listed yet) and delegates each to
 * `cleanupTelemetryRows`, so every project's rows get pruned by their own
 * secret + retention window. Per-project failures are already swallowed
 * inside `cleanupTelemetryRows`, so one bad settings file can't abort the
 * rest of the sweep.
 */
export async function cleanupAllProjectsTelemetry(launchedDataDir: string): Promise<{ deleted: number }> {
  const dataDirs = new Set<string>([launchedDataDir, ...readProjectList()]);
  let deleted = 0;
  for (const dir of dataDirs) {
    const result = await cleanupTelemetryRows(dir);
    deleted += result.deleted;
  }
  // HS-8874 — also sweep the centralized store (`~/.hotsheet/telemetry`), which
  // holds the no-`hotsheet_project` rows (NULL `project_secret`). It has no
  // per-project retention setting, so it uses the default 30-day window.
  deleted += (await cleanupCentralTelemetry()).deleted;
  return { deleted };
}

/** HS-8874 — retention sweep for the centralized telemetry store. Central rows
 *  carry a NULL `project_secret`; there's no project settings file, so we use
 *  the §67.6 default 30-day window. */
const CENTRAL_TELEMETRY_RETENTION_DAYS = 30;

async function cleanupCentralTelemetry(): Promise<{ deleted: number }> {
  try {
    const deleted = await runWithTelemetryDb(centralTelemetryDataDir(), async () => {
      const db = await getTelemetryDb();
      let n = 0;
      for (const table of ['otel_metrics', 'otel_events'] as const) {
        const result = await db.query(
          `DELETE FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval AND project_secret IS NULL`,
          [String(CENTRAL_TELEMETRY_RETENTION_DAYS)],
        );
        n += result.affectedRows ?? 0;
      }
      const spansResult = await db.query(
        `DELETE FROM otel_spans WHERE start_ts < NOW() - ($1 || ' days')::interval AND project_secret IS NULL`,
        [String(CENTRAL_TELEMETRY_RETENTION_DAYS)],
      );
      n += spansResult.affectedRows ?? 0;
      return n;
    });
    if (deleted > 0) {
      console.log(`  Central telemetry retention sweep: deleted ${String(deleted)} row(s) older than ${String(CENTRAL_TELEMETRY_RETENTION_DAYS)} day(s).`);
    }
    return { deleted };
  } catch (err) {
    console.error('Central telemetry retention sweep failed:', err);
    return { deleted: 0 };
  }
}
