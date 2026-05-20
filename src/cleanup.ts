import { rmSync } from 'fs';

import { getDb } from './db/connection.js';
import {
  deleteAttachment,
  getAttachments,
  getSettings,
  getTicketsForCleanup,
  hardDeleteTicket,
  listOrphanDraftAttachments,
  updateTicket,
} from './db/queries.js';
import { readFileSettings } from './file-settings.js';

/** HS-8428 — orphan-cleanup horizon for draft attachments. Attachments
 *  uploaded with a `draft_id` that no longer matches any
 *  `feedback_drafts` row get GC'd after this window. The client tries to
 *  clean up on dialog close-without-save, but a crashed / killed tab
 *  leaks the rows here. 7 days is long enough that even a user who
 *  occasionally takes a long break between draft sessions doesn't lose
 *  in-flight work; an unsaved draft over a week old is almost certainly
 *  abandoned. */
const ORPHAN_DRAFT_ATTACHMENT_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;

export async function cleanupAttachments(): Promise<void> {
  try {
    const settings = await getSettings();
    const verifiedDays = parseInt(settings.verified_cleanup_days, 10) || 30;
    const trashDays = parseInt(settings.trash_cleanup_days, 10) || 3;

    const tickets = await getTicketsForCleanup(verifiedDays, trashDays);

    let archived = 0;
    let deleted = 0;
    for (const ticket of tickets) {
      if (ticket.status === 'verified') {
        // Auto-archive verified tickets (not delete)
        await updateTicket(ticket.id, { status: 'archive' as never });
        archived++;
      } else {
        // Hard-delete trashed tickets and their attachment files
        const attachments = await getAttachments(ticket.id);
        for (const att of attachments) {
          try {
            rmSync(att.stored_path, { force: true });
          } catch { /* file may already be gone */ }
        }
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
      try { rmSync(att.stored_path, { force: true }); } catch { /* file may already be gone */ }
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
 * Pure-ish: takes the project `dataDir` so the per-project setting
 * can be read. Caller is expected to invoke this inside a
 * `runWithDataDir(dataDir, ...)` block so `getDb()` resolves the
 * project's PGLite handle correctly.
 */
export async function cleanupTelemetryRows(dataDir: string): Promise<{ deleted: number }> {
  try {
    const settings = readFileSettings(dataDir);
    const days = typeof settings.telemetry_retention_days === 'number'
      ? settings.telemetry_retention_days
      : 30;
    // `0` (or anything <= 0) means "keep forever" per §67.6.
    if (days <= 0) return { deleted: 0 };

    const db = await getDb();
    let deleted = 0;
    for (const table of ['otel_metrics', 'otel_events'] as const) {
      // `start_ts` for spans, `ts` for metrics + events.
      const result = await db.query(
        `DELETE FROM ${table} WHERE ts < NOW() - ($1 || ' days')::interval`,
        [String(days)],
      );
      deleted += result.affectedRows ?? 0;
    }
    // Spans use `start_ts` not `ts` — separate query.
    const spansResult = await db.query(
      `DELETE FROM otel_spans WHERE start_ts < NOW() - ($1 || ' days')::interval`,
      [String(days)],
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
