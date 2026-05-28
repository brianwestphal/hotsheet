/**
 * HS-8679 — attachment-sync slice extracted from `src/plugins/syncEngine.ts`.
 *
 * Reads each local attachment for a synced ticket, uploads it to the backend
 * (`uploadAttachment`), and posts a markdown link as a comment so the remote
 * issue shows the attachment inline. The `att_<id>` `note_sync` row tracks
 * which attachments have been pushed so reruns are idempotent.
 *
 * Mirrors the HS-8189 registry split — one concern per file, the parent
 * `syncEngine.ts` orchestrates by calling `syncAttachments`.
 */
import { readFileSync } from 'fs';

import { getDb } from '../../db/connection.js';
import {
  deleteSyncRecord, getNoteSyncRecords, getSyncRecordsForPlugin,
  upsertNoteSyncRecord,
} from '../../db/sync.js';
import { getMimeType } from '../../mime-types.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import type { TicketingBackend } from '../types.js';

export async function syncAttachments(backend: TicketingBackend): Promise<void> {
  if (!backend.uploadAttachment) return;
  const records = await getSyncRecordsForPlugin(backend.id);

  for (const syncRecord of records) {
    if (syncRecord.sync_status !== 'synced') continue;
    try {
      await syncTicketAttachments(backend, syncRecord.ticket_id, syncRecord.remote_id);
    } catch (e) {
      const msg = getErrorMessage(e);
      if (msg.includes('404') || msg.includes('410')) {
        console.warn(`[sync] Remote issue gone for ticket ${syncRecord.ticket_id}, removing sync record`);
        await deleteSyncRecord(syncRecord.ticket_id, backend.id);
      } else {
        console.warn(`[sync] Attachment sync failed for ticket ${syncRecord.ticket_id}: ${msg}`);
      }
    }
  }
}

export async function syncTicketAttachments(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
  if (!backend.uploadAttachment || !backend.createComment) return;

  const db = await getDb();
  const attResult = await db.query<{ id: number; original_filename: string; stored_path: string }>(
    'SELECT id, original_filename, stored_path FROM attachments WHERE ticket_id = $1', [ticketId],
  );
  if (attResult.rows.length === 0) return;
  console.log(`[sync] Found ${attResult.rows.length} attachment(s) for ticket ${ticketId}`);

  // Which attachments are already synced — `att_<id>` rows in `note_sync`.
  const mappings = await getNoteSyncRecords(ticketId, backend.id);
  const syncedAttIds = new Set(
    mappings.filter(m => m.note_id.startsWith('att_')).map(m => m.note_id),
  );

  for (const att of attResult.rows) {
    const attSyncId = `att_${att.id}`;
    if (syncedAttIds.has(attSyncId)) continue;

    try {
      const content = readFileSync(att.stored_path);
      const ext = att.original_filename.split('.').pop()?.toLowerCase() ?? '';
      const mimeType = getMimeType(ext);

      const url = await backend.uploadAttachment(att.original_filename, content, mimeType);
      if (url == null || url === '') continue;

      // Post a comment with the attachment link (image vs file markdown).
      const isImage = mimeType.startsWith('image/');
      const markdown = isImage
        ? `![${att.original_filename}](${url})`
        : `[${att.original_filename}](${url})`;
      const commentId = await backend.createComment(remoteId, markdown);
      await upsertNoteSyncRecord(ticketId, attSyncId, backend.id, commentId);
    } catch (e) {
      console.warn(`[sync] Failed to upload attachment ${att.original_filename}: ${getErrorMessage(e)}`);
    }
  }
}
