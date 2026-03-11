import { rmSync } from 'fs';

import { getAttachments, getSettings, getTicketsForCleanup, hardDeleteTicket } from './db/queries.js';

export async function cleanupAttachments(): Promise<void> {
  try {
    const settings = await getSettings();
    const verifiedDays = parseInt(settings.verified_cleanup_days, 10) || 30;
    const trashDays = parseInt(settings.trash_cleanup_days, 10) || 3;

    const tickets = await getTicketsForCleanup(verifiedDays, trashDays);
    if (tickets.length === 0) return;

    let cleaned = 0;
    for (const ticket of tickets) {
      const attachments = await getAttachments(ticket.id);
      for (const att of attachments) {
        try {
          rmSync(att.stored_path, { force: true });
        } catch { /* file may already be gone */ }
      }
      await hardDeleteTicket(ticket.id);
      cleaned++;
    }

    if (cleaned > 0) {
      console.log(`  Cleaned up ${cleaned} old ticket(s) and their attachments.`);
    }
  } catch (err) {
    console.error('Attachment cleanup failed:', err);
  }
}
