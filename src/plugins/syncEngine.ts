import { parseNotes } from '../db/notes.js';
import {
  addToOutbox, deleteNoteSyncRecord, deleteSyncRecord, getNoteSyncRecords,
  getOutboxEntries, getSyncRecord, getSyncRecordByRemoteId,
  getSyncRecordsForPlugin, incrementOutboxAttempts, removeOutboxEntry,
  updateSyncStatus, upsertNoteSyncRecord, upsertSyncRecord,
} from '../db/sync.js';
import { createTicket, getTicket, updateTicket } from '../db/tickets.js';
import type { Ticket } from '../types.js';
import { getAllBackends, getBackendForPlugin, reactivatePlugin } from './loader.js';
import type { RemoteChange, RemoteTicketFields, TicketingBackend,TicketSyncRecord } from './types.js';

// --- Sync scheduling ---

/** Per-plugin sync timers. Each scheduled sync replaces any previous timer for
 *  the same pluginId (startScheduledSync calls stopScheduledSync first).
 *  No guard against overlapping sync execution — if a timer fires while a
 *  previous sync is still running, both run concurrently.
 *  Modified by: startScheduledSync(), stopScheduledSync(), stopAllScheduledSyncs(). */
const syncTimers = new Map<string, ReturnType<typeof setInterval>>();

export function startScheduledSync(pluginId: string, intervalMs: number, dataDir?: string): void {
  stopScheduledSync(pluginId);
  const timer = setInterval(async () => {
    // Run in the correct project context
    if (dataDir != null && dataDir !== '') {
      const { runWithDataDir } = await import('../db/connection.js');
      await runWithDataDir(dataDir, async () => {
        await reactivatePlugin(pluginId);
        await runSync(pluginId);
      });
    } else {
      void runSync(pluginId);
    }
  }, intervalMs);
  syncTimers.set(pluginId, timer);
  console.log(`[sync] Scheduled sync for ${pluginId} every ${intervalMs / 1000}s`);
}

export function stopScheduledSync(pluginId: string): void {
  const timer = syncTimers.get(pluginId);
  if (timer) {
    clearInterval(timer);
    syncTimers.delete(pluginId);
  }
}

export function stopAllScheduledSyncs(): void {
  for (const [id] of syncTimers) stopScheduledSync(id);
}

// --- Full sync (pull + push) ---

export async function runSync(pluginId: string): Promise<SyncResult> {
  cancelPendingPush(); // Manual sync supersedes debounced push
  const backend = getBackendForPlugin(pluginId);
  if (!backend) return { ok: false, error: 'Backend not found or disabled' };

  const result: SyncResult = { ok: true, pulled: 0, pushed: 0, conflicts: 0 };

  try {
    const pullResult = await pullFromRemote(backend);
    result.pulled = pullResult.applied;
    result.conflicts = (result.conflicts ?? 0) + pullResult.conflicts;
  } catch (e) {
    result.ok = false;
    result.error = `Pull failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[sync] Pull failed for ${pluginId}: ${result.error}`);
  }

  try {
    const pushResult = await pushToRemote(backend);
    result.pushed = pushResult.pushed;
  } catch (e) {
    result.ok = false;
    result.error = (result.error != null && result.error !== '' ? result.error + '; ' : '') + `Push failed: ${e instanceof Error ? e.message : String(e)}`;
    console.error(`[sync] Push failed for ${pluginId}: ${result.error}`);
  }

  // Sync comments/notes for all synced tickets
  if (backend.capabilities.comments === true && backend.getComments) {
    try {
      await syncComments(backend);
    } catch (e) {
      console.error(`[sync] Comment sync failed for ${pluginId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Sync attachments for all synced tickets
  if (backend.uploadAttachment) {
    try {
      console.log(`[sync] Starting attachment sync for ${pluginId}`);
      await syncAttachments(backend);
    } catch (e) {
      console.error(`[sync] Attachment sync failed for ${pluginId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log(`[sync] Skipping attachment sync: backend.uploadAttachment not defined for ${pluginId}`);
  }

  return result;
}

export interface SyncResult {
  ok: boolean;
  pulled?: number;
  pushed?: number;
  conflicts?: number;
  error?: string;
}

// --- Pull: remote → local ---

async function pullFromRemote(backend: TicketingBackend): Promise<{ applied: number; conflicts: number }> {
  const records = await getSyncRecordsForPlugin(backend.id);
  const lastSyncDate = records.length > 0
    ? new Date(Math.max(...records.map(r => new Date(r.last_synced_at).getTime())))
    : null;

  const changes = await backend.pullChanges(lastSyncDate);
  let applied = 0;
  let conflicts = 0;

  for (const change of changes) {
    try {
      const result = await applyRemoteChange(backend, change);
      if (result === 'conflict') conflicts++;
      else applied++;
    } catch (e) {
      console.error(`[sync] Failed to apply change for remote ${change.remoteId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { applied, conflicts };
}

async function applyRemoteChange(
  backend: TicketingBackend,
  change: RemoteChange,
): Promise<'applied' | 'conflict' | 'skipped'> {
  const existingSync = await getSyncRecordByRemoteId(backend.id, change.remoteId);
  if (!existingSync) return handleNewRemote(backend, change);
  return handleExistingRemote(backend, change, existingSync);
}

/** Handle a remote change that has no existing sync record — create or dedup. */
async function handleNewRemote(
  backend: TicketingBackend,
  change: RemoteChange,
): Promise<'applied' | 'skipped'> {
  if (change.deleted === true) return 'skipped';

  // Dedup: check if a local ticket with the same title already exists
  if (change.fields.title != null && change.fields.title !== '') {
    const { getDb: getDbForDedup } = await import('../db/connection.js');
    const db = await getDbForDedup();
    const existing = await db.query<{ id: number }>(
      "SELECT id FROM tickets WHERE title = $1 AND status != 'deleted' LIMIT 1",
      [change.fields.title],
    );
    if (existing.rows.length > 0) {
      await upsertSyncRecord(existing.rows[0].id, backend.id, change.remoteId, 'synced', change.remoteUpdatedAt);
      return 'applied';
    }
  }

  const localTicket = await createTicketFromRemote(change.fields);
  await upsertSyncRecord(localTicket.id, backend.id, change.remoteId, 'synced', change.remoteUpdatedAt);
  return 'applied';
}

/** Handle a remote change for an already-synced ticket — detect conflicts or apply. */
async function handleExistingRemote(
  backend: TicketingBackend,
  change: RemoteChange,
  syncRecord: TicketSyncRecord,
): Promise<'applied' | 'conflict' | 'skipped'> {
  const localTicket = await getTicket(syncRecord.ticket_id);
  if (!localTicket) {
    await updateSyncStatus(syncRecord.ticket_id, backend.id, 'synced');
    return 'skipped';
  }

  if (change.deleted === true) {
    await updateTicket(localTicket.id, { status: 'deleted' });
    await updateSyncStatus(localTicket.id, backend.id, 'synced');
    return 'applied';
  }

  const localModified = new Date(localTicket.updated_at).getTime() > new Date(syncRecord.local_updated_at).getTime();
  const remoteModified = change.remoteUpdatedAt.getTime() > new Date(syncRecord.remote_updated_at ?? syncRecord.last_synced_at).getTime();

  if (localModified && remoteModified) {
    const conflictData = JSON.stringify({
      local: extractTicketFields(localTicket),
      remote: change.fields,
      base_synced_at: syncRecord.last_synced_at,
    });
    await updateSyncStatus(localTicket.id, backend.id, 'conflict', conflictData);
    return 'conflict';
  }

  if (remoteModified) {
    await applyFieldsToTicket(localTicket.id, change.fields);
    await upsertSyncRecord(localTicket.id, backend.id, change.remoteId, 'synced', change.remoteUpdatedAt);
    return 'applied';
  }

  return 'skipped';
}

async function createTicketFromRemote(fields: Partial<RemoteTicketFields>): Promise<Ticket> {
  return createTicket(fields.title ?? 'Untitled', {
    details: fields.details,
    category: fields.category as Ticket['category'],
    priority: (fields.priority ?? 'default') as Ticket['priority'],
    status: (fields.status ?? 'not_started') as Ticket['status'],
    up_next: fields.up_next ?? false,
    tags: fields.tags ? JSON.stringify(fields.tags) : undefined,
  });
}

async function applyFieldsToTicket(ticketId: number, fields: Partial<RemoteTicketFields>): Promise<void> {
  const updates: Record<string, unknown> = {};
  if (fields.title !== undefined) updates.title = fields.title;
  if (fields.details !== undefined) updates.details = fields.details;
  if (fields.category !== undefined) updates.category = fields.category;
  if (fields.priority !== undefined) updates.priority = fields.priority;
  if (fields.status !== undefined) updates.status = fields.status;
  if (fields.up_next !== undefined) updates.up_next = fields.up_next;
  if (fields.tags !== undefined) updates.tags = JSON.stringify(fields.tags);

  if (Object.keys(updates).length > 0) {
    await updateTicket(ticketId, updates as Parameters<typeof updateTicket>[1]);
  }
}

function extractTicketFields(ticket: Ticket): Partial<RemoteTicketFields> {
  return {
    title: ticket.title,
    details: ticket.details,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    up_next: ticket.up_next,
    tags: JSON.parse(ticket.tags || '[]') as string[],
  };
}

// --- Push: local → remote ---
// Uses direct comparison instead of outbox for field changes.
// For each synced ticket, compares local updated_at with the sync record's local_updated_at.
// If the local ticket was modified since last sync, pushes ALL current field values.

async function pushToRemote(backend: TicketingBackend): Promise<{ pushed: number }> {
  if (!backend.capabilities.update) return { pushed: 0 };

  const records = await getSyncRecordsForPlugin(backend.id);
  let pushed = 0;

  for (const syncRecord of records) {
    if (syncRecord.sync_status !== 'synced') continue;
    const ticket = await getTicket(syncRecord.ticket_id);
    if (!ticket) continue;

    // Was the local ticket modified since the last sync?
    const localModified = new Date(ticket.updated_at).getTime() > new Date(syncRecord.local_updated_at).getTime();
    if (!localModified) continue;

    // Push all current field values
    try {
      const fields = extractTicketFields(ticket);
      await backend.updateRemote(syncRecord.remote_id, fields);
      await upsertSyncRecord(ticket.id, backend.id, syncRecord.remote_id, 'synced');
      pushed++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('410') || msg.includes('Not Found') || msg.includes('deleted')) {
        console.warn(`[sync] Remote issue gone for ticket ${syncRecord.ticket_id}, removing sync record`);
        await deleteSyncRecord(syncRecord.ticket_id, backend.id);
      } else {
        console.warn(`[sync] Push failed for ticket ${syncRecord.ticket_id}: ${msg}`);
      }
    }
  }

  // Also process outbox create/delete entries
  const entries = await getOutboxEntries(backend.id);
  for (const entry of entries) {
    if (entry.attempts >= 5) {
      await removeOutboxEntry(entry.id);
      continue;
    }
    try {
      if (entry.action === 'create') {
        const ticket = await getTicket(entry.ticket_id);
        if (ticket && backend.capabilities.create) {
          // Skip if the ticket already has a sync record — push-ticket or a
          // prior sync may have created the remote while this outbox entry sat
          // in the queue. Without this check, we'd create a DUPLICATE remote
          // issue and overwrite the sync record to point at it, losing the
          // association to the original and causing comment-sync to delete local
          // notes that appear "missing" on the wrong remote issue.
          const existingSync = await getSyncRecord(ticket.id, backend.id);
          if (existingSync) {
            await removeOutboxEntry(entry.id);
            continue;
          }
          const remoteId = await backend.createRemote(ticket);
          await upsertSyncRecord(ticket.id, backend.id, remoteId, 'synced');
          await syncSingleTicketContent(backend, ticket.id, remoteId);
          pushed++;
        }
      } else if (entry.action === 'delete') {
        const record = await getSyncRecord(entry.ticket_id, backend.id);
        if (record && backend.capabilities.delete) {
          await backend.deleteRemote(record.remote_id);
          await updateSyncStatus(entry.ticket_id, backend.id, 'synced');
          pushed++;
        }
      }
      await removeOutboxEntry(entry.id);
    } catch (e) {
      await incrementOutboxAttempts(entry.id, e instanceof Error ? e.message : String(e));
      break;
    }
  }

  return { pushed };
}

// --- Debounced auto-push ---

// Outbox entries are queued by onTicketChanged/Created/Deleted and flushed by:
// 1. Manual sync (Sync Now button) — runs in the correct project context
// 2. Scheduled sync — runs in the correct project context
// Auto-push via timer is disabled because it runs without project context,
// which caused cross-project contamination.

/** No-op: kept for API compatibility with tests. */
export function cancelPendingPush(): void {
  // no-op
}

// --- Push on edit (auto-push when ticket is modified) ---

async function isEnabledForCurrentProject(pluginId: string): Promise<boolean> {
  const { isPluginEnabledForProject } = await import('../routes/plugins.js');
  return isPluginEnabledForProject(pluginId);
}

export async function onTicketChanged(ticketId: number, changes: Record<string, unknown>): Promise<void> {
  const backends = getAllBackends();
  for (const backend of backends) {
    if (!await isEnabledForCurrentProject(backend.id)) continue;
    const records = await getSyncRecordsForPlugin(backend.id);
    const syncRecord = records.find(r => r.ticket_id === ticketId);
    if (!syncRecord) continue;
    await addToOutbox(ticketId, backend.id, 'update', changes);
  }
  // Outbox entries will be pushed on next manual or scheduled sync
}

export async function onTicketCreated(ticketId: number): Promise<void> {
  const backends = getAllBackends();
  for (const backend of backends) {
    if (!backend.capabilities.create) continue;
    if (!await isEnabledForCurrentProject(backend.id)) continue;

    // Check if the plugin wants to auto-sync this ticket
    if (backend.shouldAutoSync) {
      const ticket = await getTicket(ticketId);
      if (ticket && backend.shouldAutoSync(ticket)) {
        // Check the ticket isn't already synced (e.g. just pulled from remote)
        const existing = await getSyncRecord(ticketId, backend.id);
        if (!existing) {
          await addToOutbox(ticketId, backend.id, 'create', {});
        }
        continue;
      }
    }

    // Legacy: only auto-create if there are already synced tickets
    const records = await getSyncRecordsForPlugin(backend.id);
    if (records.length === 0) continue;
    await addToOutbox(ticketId, backend.id, 'create', {});
  }
  // Outbox entries will be pushed on next manual or scheduled sync
}

export async function onTicketDeleted(ticketId: number): Promise<void> {
  const backends = getAllBackends();
  for (const backend of backends) {
    if (!await isEnabledForCurrentProject(backend.id)) continue;
    const records = await getSyncRecordsForPlugin(backend.id);
    const syncRecord = records.find(r => r.ticket_id === ticketId);
    if (!syncRecord) continue;
    await addToOutbox(ticketId, backend.id, 'delete', {});
  }
  // Outbox entries will be pushed on next manual or scheduled sync
}

// --- Comment / note sync ---

async function syncComments(backend: TicketingBackend): Promise<void> {
  const records = await getSyncRecordsForPlugin(backend.id);
  for (const syncRecord of records) {
    if (syncRecord.sync_status !== 'synced') continue;
    try {
      await syncTicketComments(backend, syncRecord.ticket_id, syncRecord.remote_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('410')) {
        console.warn(`[sync] Remote issue gone for ticket ${syncRecord.ticket_id}, removing sync record`);
        await deleteSyncRecord(syncRecord.ticket_id, backend.id);
      } else {
        console.warn(`[sync] Comment sync failed for ticket ${syncRecord.ticket_id}: ${msg}`);
      }
    }
  }
}

/** Push notes and attachments for a single newly-synced ticket. */
export async function syncSingleTicketContent(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
  if (backend.capabilities.comments === true && backend.getComments) {
    try {
      await syncTicketComments(backend, ticketId, remoteId);
    } catch (e) {
      console.warn(`[sync] Comment sync failed for ticket ${ticketId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (backend.uploadAttachment) {
    try {
      await syncTicketAttachments(backend, ticketId, remoteId);
    } catch (e) {
      console.warn(`[sync] Attachment sync failed for ticket ${ticketId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function syncTicketComments(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
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
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('404') || msg.includes('410') || msg.includes('Not Found')) {
      throw e;
    }
    return;
  }

  const mappings = await getNoteSyncRecords(ticketId, backend.id);
  const noteIdToMapping = new Map(mappings.map(m => [m.note_id, m]));

  // Skip attachment mappings (att_ prefix) — they're managed by syncTicketAttachments.
  const isAttMapping = (noteId: string) => noteId.startsWith('att_');

  let changed = false;
  const localNoteById = new Map(localNotes.map(n => [n.id, n]));
  const remoteCommentById = new Map(remoteComments.map(c => [c.id, c]));

  // Pass 1: handle existing mappings — detect edits and deletes on both sides.
  for (const mapping of mappings) {
    if (isAttMapping(mapping.note_id)) continue;

    const localNote = localNoteById.get(mapping.note_id);
    const remoteComment = remoteCommentById.get(mapping.remote_comment_id);
    const base = mapping.last_synced_text ?? null;

    // Both sides still exist → check for edits
    if (localNote && remoteComment) {
      const localText = localNote.text;
      const remoteText = remoteComment.text;
      const localChanged = base !== null && localText !== base;
      const remoteChanged = base !== null && remoteText !== base;

      if (localText === remoteText) {
        // No divergence — make sure the baseline is up to date.
        if (base !== localText) {
          await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
        }
      } else if (localChanged && !remoteChanged) {
        // Push local edit to remote
        if (backend.updateComment) {
          try {
            await backend.updateComment(remoteId, mapping.remote_comment_id, localText);
            await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
          } catch (e) {
            console.warn(`[sync] Failed to update remote comment ${mapping.remote_comment_id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else if (remoteChanged && !localChanged) {
        // Pull remote edit into local note
        localNote.text = remoteText;
        changed = true;
        await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, remoteText);
      } else if (localChanged && remoteChanged) {
        // Both edited — push-wins policy. Keep the local value and overwrite remote.
        if (backend.updateComment) {
          try {
            await backend.updateComment(remoteId, mapping.remote_comment_id, localText);
            await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
          } catch (e) {
            console.warn(`[sync] Failed to update remote comment ${mapping.remote_comment_id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        // Neither changed vs base (base may be null from older records) — just
        // refresh the baseline with the current text so future edits are detectable.
        await upsertNoteSyncRecord(ticketId, mapping.note_id, backend.id, mapping.remote_comment_id, localText);
      }
      continue;
    }

    if (!localNote && remoteComment) {
      // Local note deleted → delete the remote comment.
      if (backend.deleteComment) {
        try {
          await backend.deleteComment(remoteId, mapping.remote_comment_id);
        } catch (e) {
          console.warn(`[sync] Failed to delete remote comment ${mapping.remote_comment_id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      await deleteNoteSyncRecord(ticketId, mapping.note_id, backend.id);
      continue;
    }

    if (localNote && !remoteComment) {
      // Remote comment deleted → remove the local note to keep sides in sync.
      const idx = localNotes.findIndex(n => n.id === mapping.note_id);
      if (idx >= 0) {
        localNotes.splice(idx, 1);
        localNoteById.delete(mapping.note_id);
        changed = true;
      }
      await deleteNoteSyncRecord(ticketId, mapping.note_id, backend.id);
      continue;
    }

    // Both sides gone — clean up the stale mapping.
    await deleteNoteSyncRecord(ticketId, mapping.note_id, backend.id);
  }

  // Pass 2: pull NEW remote comments into local notes (unmapped on the remote side).
  const mappedRemoteIds = new Set(mappings.map(m => m.remote_comment_id));
  const localTexts = new Set(localNotes.map(n => n.text.trim()));
  for (const comment of remoteComments) {
    if (mappedRemoteIds.has(comment.id)) continue;
    if (localTexts.has(comment.text.trim())) {
      // Text-based dedup: a local note with the same text already exists. Just map it.
      const existing = localNotes.find(
        n => n.text.trim() === comment.text.trim() && !noteIdToMapping.has(n.id),
      );
      if (existing) {
        await upsertNoteSyncRecord(ticketId, existing.id, backend.id, comment.id, existing.text);
        noteIdToMapping.set(existing.id, {
          id: 0, ticket_id: ticketId, note_id: existing.id, plugin_id: backend.id,
          remote_comment_id: comment.id, last_synced_at: new Date().toISOString(),
          last_synced_text: existing.text,
        });
      }
      continue;
    }
    const noteId = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    localNotes.push({ id: noteId, text: comment.text, created_at: comment.createdAt.toISOString() });
    localNoteById.set(noteId, localNotes[localNotes.length - 1]);
    await upsertNoteSyncRecord(ticketId, noteId, backend.id, comment.id, comment.text);
    localTexts.add(comment.text.trim());
    changed = true;
  }

  // Pass 3: push NEW local notes to remote (unmapped on the local side).
  const remoteTexts = new Set(remoteComments.map(c => c.text.trim()));
  const mappedRemoteIdsAfterPull = new Set([
    ...mappedRemoteIds,
    ...Array.from(noteIdToMapping.values()).map(m => m.remote_comment_id),
  ]);
  for (const note of localNotes) {
    if (isAttMapping(note.id)) continue;
    if (noteIdToMapping.has(note.id)) continue;
    if (!backend.createComment) continue;
    if (remoteTexts.has(note.text.trim())) {
      // Text already exists remotely — map it.
      const existing = remoteComments.find(
        c => c.text.trim() === note.text.trim() && !mappedRemoteIdsAfterPull.has(c.id),
      );
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
      console.warn(`[sync] Failed to push note ${note.id} for ticket ${ticketId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (changed) {
    const { getDb: getDbForNotes } = await import('../db/connection.js');
    const db = await getDbForNotes();
    await db.query('UPDATE tickets SET notes = $1 WHERE id = $2', [JSON.stringify(localNotes), ticketId]);
  }
}

// --- Attachment sync ---

async function syncAttachments(backend: TicketingBackend): Promise<void> {
  if (!backend.uploadAttachment) return;
  const records = await getSyncRecordsForPlugin(backend.id);

  for (const syncRecord of records) {
    if (syncRecord.sync_status !== 'synced') continue;
    try {
      await syncTicketAttachments(backend, syncRecord.ticket_id, syncRecord.remote_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('404') || msg.includes('410')) {
        console.warn(`[sync] Remote issue gone for ticket ${syncRecord.ticket_id}, removing sync record`);
        await deleteSyncRecord(syncRecord.ticket_id, backend.id);
      } else {
        console.warn(`[sync] Attachment sync failed for ticket ${syncRecord.ticket_id}: ${msg}`);
      }
    }
  }
}

async function syncTicketAttachments(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
  if (!backend.uploadAttachment || !backend.createComment) return;

  // Get local attachments
  const { getDb: getDbForAtt } = await import('../db/connection.js');
  const db = await getDbForAtt();
  const attResult = await db.query<{ id: number; original_filename: string; stored_path: string }>(
    'SELECT id, original_filename, stored_path FROM attachments WHERE ticket_id = $1', [ticketId],
  );
  if (attResult.rows.length === 0) return;
  console.log(`[sync] Found ${attResult.rows.length} attachment(s) for ticket ${ticketId}`);

  // Check which attachments are already synced (via note_sync with a special prefix)
  const mappings = await getNoteSyncRecords(ticketId, backend.id);
  const syncedAttIds = new Set(
    mappings.filter(m => m.note_id.startsWith('att_')).map(m => m.note_id),
  );

  for (const att of attResult.rows) {
    const attSyncId = `att_${att.id}`;
    if (syncedAttIds.has(attSyncId)) continue;

    // Read file and upload
    try {
      const { readFileSync } = await import('fs');
      const content = readFileSync(att.stored_path);
      const ext = att.original_filename.split('.').pop()?.toLowerCase() ?? '';
      const { getMimeType } = await import('../mime-types.js');
      const mimeType = getMimeType(ext);

      const url = await backend.uploadAttachment(att.original_filename, content, mimeType);
      if (url == null || url === '') continue;

      // Post a comment with the attachment link
      const isImage = mimeType.startsWith('image/');
      const markdown = isImage
        ? `![${att.original_filename}](${url})`
        : `[${att.original_filename}](${url})`;
      const commentId = await backend.createComment(remoteId, markdown);
      await upsertNoteSyncRecord(ticketId, attSyncId, backend.id, commentId);
    } catch (e) {
      console.warn(`[sync] Failed to upload attachment ${att.original_filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// --- Conflict resolution ---

export async function resolveConflict(
  ticketId: number,
  pluginId: string,
  resolution: 'keep_local' | 'keep_remote',
): Promise<void> {
  const backend = getBackendForPlugin(pluginId);
  const records = await getSyncRecordsForPlugin(pluginId);
  const syncRecord = records.find(r => r.ticket_id === ticketId);
  if (!syncRecord || syncRecord.sync_status !== 'conflict') return;

  const conflictData = (syncRecord.conflict_data != null && syncRecord.conflict_data !== '') ? JSON.parse(syncRecord.conflict_data) as {
    local: Partial<RemoteTicketFields>;
    remote: Partial<RemoteTicketFields>;
  } : null;

  if (!conflictData) {
    await updateSyncStatus(ticketId, pluginId, 'synced');
    return;
  }

  if (resolution === 'keep_local') {
    // Mark as synced FIRST, then push. pushToRemote's direct-compare loop
    // skips any record with sync_status='conflict', so without clearing the
    // status first the immediate push would silently do nothing and the user
    // would have to click Sync again to actually propagate their choice.
    await updateSyncStatus(ticketId, pluginId, 'synced');
    if (backend) {
      try { await pushToRemote(backend); } catch { /* will retry on next sync */ }
    }
  } else {
    // Apply remote values to the local ticket, then re-baseline the sync
    // record to the ticket's NEW updated_at. Without re-baselining, the next
    // push's direct-compare loop would see ticket.updated_at > local_updated_at
    // and pointlessly PATCH GitHub with the same values we just pulled in
    // (churn on every sync after a keep_remote resolution).
    await applyFieldsToTicket(ticketId, conflictData.remote);
    await upsertSyncRecord(
      ticketId,
      pluginId,
      syncRecord.remote_id,
      'synced',
      syncRecord.remote_updated_at != null && syncRecord.remote_updated_at !== '' ? new Date(syncRecord.remote_updated_at) : null,
    );
  }
}
