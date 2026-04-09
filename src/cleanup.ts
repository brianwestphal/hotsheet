import { rmSync } from 'fs';

import { getAttachments, getSettings, getTicketsForCleanup, hardDeleteTicket, updateTicket } from './db/queries.js';

export async function cleanupAttachments(): Promise<void> {
  try {
    const settings = await getSettings();
    const verifiedDays = parseInt(settings.verified_cleanup_days, 10) || 30;
    const trashDays = parseInt(settings.trash_cleanup_days, 10) || 3;

    const tickets = await getTicketsForCleanup(verifiedDays, trashDays);
    if (tickets.length === 0) return;

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

    if (archived > 0 || deleted > 0) {
      const parts: string[] = [];
      if (archived > 0) parts.push(`archived ${archived} verified ticket(s)`);
      if (deleted > 0) parts.push(`deleted ${deleted} trashed ticket(s)`);
      console.log(`  Cleanup: ${parts.join(', ')}.`);
    }
  } catch (err) {
    console.error('Cleanup failed:', err);
  }
}
