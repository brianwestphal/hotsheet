import { existsSync } from 'fs';
import { join } from 'path';

import { attachmentBlobsDir, indexExistingManifestEntries } from './attachmentBackup.js';
// HS-8555 — `rmSync`-and-swallow extracted into `deleteAttachmentFile`.
import { deleteAttachmentFile, getAllAttachments } from './db/attachments.js';
import { getTelemetryDb } from './db/connection.js';
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
 * HS-8783 — self-heal attachment rows whose `stored_path` file was removed
 * out-of-band (deleted/pruned while the DB row lingers). Drops a row ONLY when
 * its content is ALSO unrecoverable from the backup store (no manifest cross-ref
 * blob) — mirroring the manual-reanalyze guard (`attachmentBackup.ts`), so a row
 * whose file is gone but is still captured in a backup is kept. Skips entirely
 * when the backup root isn't present (e.g. a temporarily-unmounted custom
 * `backupDir`): without a readable store we can't prove non-recoverability, so we
 * never risk a wrongful delete. Returns the pruned count. Runs in the active
 * project's DB context (caller wraps it in `runWithDataDir`).
 */
export async function cleanupOrphanedAttachments(dataDir: string): Promise<{ pruned: number }> {
  try {
    const backupRoot = getBackupDir(dataDir);
    if (!existsSync(backupRoot)) return { pruned: 0 };

    const missing = (await getAllAttachments()).filter(a => !existsSync(a.stored_path));
    if (missing.length === 0) return { pruned: 0 };

    const index = indexExistingManifestEntries(backupRoot);
    const blobsDir = attachmentBlobsDir(backupRoot);
    let pruned = 0;
    for (const att of missing) {
      const xref = index.get(att.id);
      const recoverable = xref !== undefined && existsSync(join(blobsDir, xref.sha));
      if (recoverable) continue; // content still in the backup store — keep the row
      await deleteAttachment(att.id);
      pruned++;
    }
    if (pruned > 0) {
      console.log(`  Cleanup: pruned ${String(pruned)} attachment row(s) whose file is missing and unrecoverable from backups.`);
    }
    return { pruned };
  } catch (err) {
    console.error('Orphaned-attachment cleanup failed:', err);
    return { pruned: 0 };
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
 * **HS-8607 — scopes deletion to THIS project's `project_secret`** and
 * reads from the shared telemetry DB via `getTelemetryDb()` (NOT the
 * per-request `getDb()`). The otel tables are a single shared store in
 * the primary project's DB keyed by `project_secret` (§67.6 /
 * `getTelemetryDb`), so an unscoped DELETE run under one project would
 * prune EVERY project's rows using that project's retention window, and
 * a sweep run under a secondary project's request context would hit its
 * own (empty) DB and delete nothing. Scoping by secret + targeting the
 * shared DB makes each project prune exactly its own rows by its own
 * window. No `runWithDataDir` wrapper is needed any more — the DB is
 * resolved explicitly.
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
    // rather than risk an unscoped DELETE across the shared store.
    const secret = typeof settings.secret === 'string' && settings.secret !== '' ? settings.secret : null;
    if (secret === null) return { deleted: 0 };

    const db = await getTelemetryDb();
    let deleted = 0;
    for (const table of ['otel_metrics', 'otel_events'] as const) {
      // `start_ts` for spans, `ts` for metrics + events.
      const result = await db.query(
        `DELETE FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval AND project_secret = $2`,
        [String(days), secret],
      );
      deleted += result.affectedRows ?? 0;
    }
    // Spans use `start_ts` not `ts` — separate query.
    const spansResult = await db.query(
      `DELETE FROM otel_spans WHERE start_ts < NOW() - ($1 || ' days')::interval AND project_secret = $2`,
      [String(days), secret],
    );
    deleted += spansResult.affectedRows ?? 0;

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
  return { deleted };
}
