/**
 * HS-8679 — comment-sync slice extracted from `src/plugins/syncEngine.ts`.
 *
 * The three-pass comment reconciliation (`CommentSyncCtx` →
 * `reconcileExistingMappings` → `pullNewRemoteComments` → `pushNewLocalNotes`)
 * is self-contained: it operates on a single ticket's notes JSON + the
 * corresponding remote-comments list + the `note_sync` mappings, and only
 * exposes the two orchestration entry points (`syncComments`,
 * `syncTicketComments`) to the parent `syncEngine.ts`.
 *
 * Mirrors the HS-8189 registry split (one concern per file, parent file is
 * orchestration only).
 */
import { generateNoteId, parseNotes } from '../../db/notes.js';
import {
  deleteNoteSyncRecord, deleteSyncRecord, getNoteSyncRecords,
  getSyncRecordsForPlugin, upsertNoteSyncRecord,
} from '../../db/sync.js';
import { getTicket } from '../../db/tickets.js';
import { getErrorMessage } from '../../utils/errorMessage.js';
import type { TicketingBackend } from '../types.js';

/** Context shared across the three comment sync passes. */
interface CommentSyncCtx {
  backend: TicketingBackend;
  ticketId: number;
  remoteId: string;
  localNotes: { id: string; text: string; created_at: string }[];
  localNoteById: Map<string, { id: string; text: string; created_at: string }>;
  remoteComments: { id: string; text: string; createdAt: Date }[];
  mappings: Awaited<ReturnType<typeof getNoteSyncRecords>>;
  noteIdToMapping: Map<string, Awaited<ReturnType<typeof getNoteSyncRecords>>[0]>;
  changed: boolean;
}

/** Pass 1: reconcile existing mappings — detect edits and deletes on both sides. */
async function reconcileExistingMappings(ctx: CommentSyncCtx): Promise<void> {
  const { backend, ticketId, remoteId, localNotes, localNoteById, mappings } = ctx;
  const remoteCommentById = new Map(ctx.remoteComments.map(c => [c.id, c]));

  for (const mapping of mappings) {
    // Skip sync markers that aren't notes/comments: `att_` (pushed attachments,
    // HS-8679) and `img_` (pulled body images, HS-8952).
    if (mapping.note_id.startsWith('att_') || mapping.note_id.startsWith('img_')) continue;

    const localNote = localNoteById.get(mapping.note_id);
    const remoteComment = remoteCommentById.get(mapping.remote_comment_id);
    const base = mapping.last_synced_text ?? null;

    if (localNote && remoteComment) {
      const localText = localNote.text;
      const remoteText = remoteComment.text;
      const localChanged = base !== null && localText !== base;
      const remoteChanged = base !== null && remoteText !== base;

      if (localText === remoteText) {
        if (base !== localText) {
          await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
        }
      } else if (localChanged && !remoteChanged) {
        if (backend.updateComment) {
          try {
            await backend.updateComment(remoteId, mapping.remote_comment_id, localText);
            await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
          } catch (e) {
            console.warn(`[sync] Failed to update remote comment ${mapping.remote_comment_id}: ${getErrorMessage(e)}`);
          }
        }
      } else if (remoteChanged && !localChanged) {
        localNote.text = remoteText;
        ctx.changed = true;
        await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, remoteText);
      } else if (localChanged && remoteChanged) {
        if (backend.updateComment) {
          try {
            await backend.updateComment(remoteId, mapping.remote_comment_id, localText);
            await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
          } catch (e) {
            console.warn(`[sync] Failed to update remote comment ${mapping.remote_comment_id}: ${getErrorMessage(e)}`);
          }
        }
      } else {
        await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
      }
      continue;
    }

    if (!localNote && remoteComment) {
      if (backend.deleteComment) {
        try { await backend.deleteComment(remoteId, mapping.remote_comment_id); }
        catch (e) { console.warn(`[sync] Failed to delete remote comment ${mapping.remote_comment_id}: ${getErrorMessage(e)}`); }
      }
      await deleteNoteSyncRecord(ticketId, mapping.note_id, backend.id);
      continue;
    }

    if (localNote && !remoteComment) {
      const idx = localNotes.findIndex(n => n.id === mapping.note_id);
      if (idx >= 0) { localNotes.splice(idx, 1); localNoteById.delete(mapping.note_id); ctx.changed = true; }
      await deleteNoteSyncRecord(ticketId, mapping.note_id, backend.id);
      continue;
    }

    await deleteNoteSyncRecord(ticketId, mapping.note_id, backend.id);
  }
}

/** Pass 2: pull NEW remote comments into local notes (unmapped on the remote side). */
async function pullNewRemoteComments(ctx: CommentSyncCtx): Promise<void> {
  const { backend, ticketId, localNotes, localNoteById, remoteComments, mappings, noteIdToMapping } = ctx;
  const mappedRemoteIds = new Set(mappings.map(m => m.remote_comment_id));
  const localTexts = new Set(localNotes.map(n => n.text.trim()));

  for (const comment of remoteComments) {
    if (mappedRemoteIds.has(comment.id)) continue;
    if (localTexts.has(comment.text.trim())) {
      const existing = localNotes.find(n => n.text.trim() === comment.text.trim() && !noteIdToMapping.has(n.id));
      if (existing) {
        await upsertNoteSyncRecord(ticketId, existing.id, backend.id, comment.id, existing.text);
        noteIdToMapping.set(existing.id, {
          id: 0, ticket_id: ticketId, note_id: existing.id, plugin_id: backend.id,
          remote_comment_id: comment.id, last_synced_at: new Date().toISOString(), last_synced_text: existing.text,
        });
      }
      continue;
    }
    const noteId = generateNoteId(); // HS-8669 — canonical `n_<date>_<counter>` id (was an ad-hoc Math.random form)
    localNotes.push({ id: noteId, text: comment.text, created_at: comment.createdAt.toISOString() });
    localNoteById.set(noteId, localNotes[localNotes.length - 1]);
    await upsertNoteSyncRecord(ticketId, noteId, backend.id, comment.id, comment.text);
    localTexts.add(comment.text.trim());
    ctx.changed = true;
  }
}

/** Pass 3: push NEW local notes to remote (unmapped on the local side). */
async function pushNewLocalNotes(ctx: CommentSyncCtx): Promise<void> {
  const { backend, ticketId, remoteId, localNotes, remoteComments, mappings, noteIdToMapping } = ctx;
  const remoteTexts = new Set(remoteComments.map(c => c.text.trim()));
  const mappedRemoteIdsAfterPull = new Set([
    ...mappings.map(m => m.remote_comment_id),
    ...Array.from(noteIdToMapping.values()).map(m => m.remote_comment_id),
  ]);

  for (const note of localNotes) {
    if (note.id.startsWith('att_')) continue;
    if (noteIdToMapping.has(note.id)) continue;
    if (!backend.createComment) continue;
    if (remoteTexts.has(note.text.trim())) {
      const existing = remoteComments.find(c => c.text.trim() === note.text.trim() && !mappedRemoteIdsAfterPull.has(c.id));
      if (existing) {
        await upsertNoteSyncRecord(ticketId, note.id, backend.id, existing.id, note.text);
        mappedRemoteIdsAfterPull.add(existing.id);
      }
      continue;
    }
    try {
      const remoteCommentId = await backend.createComment(remoteId, note.text);
      await upsertNoteSyncRecord(ticketId, note.id, backend.id, remoteCommentId, note.text);
      remoteTexts.add(note.text.trim());
      mappedRemoteIdsAfterPull.add(remoteCommentId);
    } catch (e) {
      console.warn(`[sync] Failed to push note ${note.id} for ticket ${ticketId}: ${getErrorMessage(e)}`);
    }
  }
}

export async function syncTicketComments(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
  if (!backend.getComments) return;

  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const localNotes = parseNotes(ticket.notes);

  // Get remote comments. If the remote issue is gone (404/410), re-throw so
  // the outer syncComments loop can clean up the stale sync record. Other
  // errors are swallowed silently (rate limit, transient network) so one bad
  // ticket doesn't break the whole sync pass.
  let remoteComments;
  try {
    remoteComments = await backend.getComments(remoteId);
  } catch (e) {
    const msg = getErrorMessage(e);
    if (msg.includes('404') || msg.includes('410') || msg.includes('Not Found')) throw e;
    return;
  }

  const mappings = await getNoteSyncRecords(ticketId, backend.id);
  const ctx: CommentSyncCtx = {
    backend, ticketId, remoteId, localNotes, remoteComments, mappings,
    localNoteById: new Map(localNotes.map(n => [n.id, n])),
    noteIdToMapping: new Map(mappings.map(m => [m.note_id, m])),
    changed: false,
  };

  await reconcileExistingMappings(ctx);
  await pullNewRemoteComments(ctx);
  await pushNewLocalNotes(ctx);

  if (ctx.changed) {
    const { getDb: getDbForNotes } = await import('../../db/connection.js');
    const db = await getDbForNotes();
    await db.query('UPDATE tickets SET notes = $1 WHERE id = $2', [JSON.stringify(localNotes), ticketId]);
  }
}

export async function syncComments(backend: TicketingBackend): Promise<void> {
  const records = await getSyncRecordsForPlugin(backend.id);
  for (const syncRecord of records) {
    if (syncRecord.sync_status !== 'synced') continue;
    try {
      await syncTicketComments(backend, syncRecord.ticket_id, syncRecord.remote_id);
    } catch (e) {
      const msg = getErrorMessage(e);
      if (msg.includes('404') || msg.includes('410')) {
        console.warn(`[sync] Remote issue gone for ticket ${syncRecord.ticket_id}, removing sync record`);
        await deleteSyncRecord(syncRecord.ticket_id, backend.id);
      } else {
        console.warn(`[sync] Comment sync failed for ticket ${syncRecord.ticket_id}: ${msg}`);
      }
    }
  }
}
