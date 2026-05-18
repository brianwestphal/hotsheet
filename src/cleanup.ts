import { rmSync } from 'fs';

import {
  deleteAttachment,
  getAttachments,
  getSettings,
  getTicketsForCleanup,
  hardDeleteTicket,
  listOrphanDraftAttachments,
  updateTicket,
} from './db/queries.js';

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
