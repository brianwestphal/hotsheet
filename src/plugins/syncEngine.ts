import {
  addToOutbox, clearOutbox, deleteSyncRecord, getNoteSyncByRemoteId, getNoteSyncRecords,
  getOutboxEntries, getSyncRecord, getSyncRecordByRemoteId,
  getSyncRecordsForPlugin, incrementOutboxAttempts, removeOutboxEntry,
  updateSyncStatus, upsertNoteSyncRecord, upsertSyncRecord,
} from '../db/sync.js';
import { parseNotes } from '../db/notes.js';
import { createTicket, getTicket, updateTicket } from '../db/tickets.js';
import type { Ticket } from '../types.js';

import { getAllBackends, getBackendForPlugin, reactivatePlugin } from './loader.js';
import type { RemoteChange, RemoteTicketFields, SyncStatus, TicketingBackend } from './types.js';

// --- Sync scheduling ---

const syncTimers = new Map<string, ReturnType<typeof setInterval>>();

export function startScheduledSync(pluginId: string, intervalMs: number, dataDir?: string): void {
  stopScheduledSync(pluginId);
  const timer = setInterval(async () => {
    // Run in the correct project context
    if (dataDir) {
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
    result.error = `Pull failed: ${e instanceof Error ? e.message : e}`;
    console.error(`[sync] Pull failed for ${pluginId}: ${result.error}`);
  }

  try {
    const pushResult = await pushToRemote(backend);
    result.pushed = pushResult.pushed;
  } catch (e) {
    result.ok = false;
    result.error = (result.error ? result.error + '; ' : '') + `Push failed: ${e instanceof Error ? e.message : e}`;
    console.error(`[sync] Push failed for ${pluginId}: ${result.error}`);
  }

  // Sync comments/notes for all synced tickets
  if (backend.capabilities.comments && backend.getComments) {
    try {
      await syncComments(backend);
    } catch (e) {
      console.error(`[sync] Comment sync failed for ${pluginId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Sync attachments for all synced tickets
  if (backend.uploadAttachment) {
    try {
      console.log(`[sync] Starting attachment sync for ${pluginId}`);
      await syncAttachments(backend);
    } catch (e) {
      console.error(`[sync] Attachment sync failed for ${pluginId}: ${e instanceof Error ? e.message : e}`);
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
      console.error(`[sync] Failed to apply change for remote ${change.remoteId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { applied, conflicts };
}

async function applyRemoteChange(
  backend: TicketingBackend,
  change: RemoteChange,
): Promise<'applied' | 'conflict' | 'skipped'> {
  const existingSync = await getSyncRecordByRemoteId(backend.id, change.remoteId);

  if (!existingSync) {
    // New remote ticket — create locally
    if (change.deleted) return 'skipped';

    // Dedup: check if a local ticket with the same title already exists
    // (prevents duplicates when repo config changes or sync records were lost)
    if (change.fields.title) {
      const { getDb: getDbForDedup } = await import('../db/connection.js');
      const db = await getDbForDedup();
      const existing = await db.query<{ id: number }>(
        "SELECT id FROM tickets WHERE title = $1 AND status != 'deleted' LIMIT 1",
        [change.fields.title],
      );
      if (existing.rows.length > 0) {
        // Link existing ticket instead of creating a duplicate
        await upsertSyncRecord(existing.rows[0].id, backend.id, change.remoteId, 'synced', change.remoteUpdatedAt);
        return 'applied';
      }
    }

    const localTicket = await createTicketFromRemote(change.fields);
    await upsertSyncRecord(localTicket.id, backend.id, change.remoteId, 'synced', change.remoteUpdatedAt);
    return 'applied';
  }

  // Existing synced ticket
  const localTicket = await getTicket(existingSync.ticket_id);
  if (!localTicket) {
    // Local ticket was deleted — clean up sync record
    await updateSyncStatus(existingSync.ticket_id, backend.id, 'synced');
    return 'skipped';
  }

  if (change.deleted) {
    await updateTicket(localTicket.id, { status: 'deleted' });
    await updateSyncStatus(localTicket.id, backend.id, 'synced');
    return 'applied';
  }

  // Check for conflict: local modified since last sync?
  const localModified = new Date(localTicket.updated_at).getTime() > new Date(existingSync.local_updated_at).getTime();
  const remoteModified = change.remoteUpdatedAt.getTime() > new Date(existingSync.remote_updated_at ?? existingSync.last_synced_at).getTime();

  if (localModified && remoteModified) {
    // Both sides modified — conflict
    const conflictData = JSON.stringify({
      local: extractTicketFields(localTicket),
      remote: change.fields,
      base_synced_at: existingSync.last_synced_at,
    });
    await updateSyncStatus(localTicket.id, backend.id, 'conflict', conflictData);
    return 'conflict';
  }

  if (remoteModified) {
    // Only remote changed — apply
    await applyFieldsToTicket(localTicket.id, change.fields);
    await upsertSyncRecord(localTicket.id, backend.id, change.remoteId, 'synced', change.remoteUpdatedAt);
    return 'applied';
  }

  // Only local changed or neither changed — skip (push will handle local changes)
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
    tags: JSON.parse(ticket.tags || '[]'),
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
          const remoteId = await backend.createRemote(ticket);
          await upsertSyncRecord(ticket.id, backend.id, remoteId, 'synced');
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

async function syncTicketComments(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
  if (!backend.getComments) return;

  const ticket = await getTicket(ticketId);
  if (!ticket) return;
  const localNotes = parseNotes(ticket.notes);

  // Get remote comments (404 means the issue doesn't exist in the current repo — skip)
  let remoteComments;
  try {
    remoteComments = await backend.getComments(remoteId);
  } catch {
    return; // Remote issue not found, skip comment sync
  }

  const mappings = await getNoteSyncRecords(ticketId, backend.id);
  const mappedNoteIds = new Set(mappings.map(m => m.note_id));
  const mappedRemoteIds = new Set(mappings.map(m => m.remote_comment_id));

  let changed = false;

  // Pull: remote comments not yet mapped → create local notes
  // Deduplicate: skip if a local note already has identical text
  const localTexts = new Set(localNotes.map(n => n.text.trim()));
  for (const comment of remoteComments) {
    if (mappedRemoteIds.has(comment.id)) continue;
    if (localTexts.has(comment.text.trim())) {
      // Text already exists locally — just create the mapping without duplicating
      const existing = localNotes.find(n => n.text.trim() === comment.text.trim() && !mappedNoteIds.has(n.id));
      if (existing) {
        await upsertNoteSyncRecord(ticketId, existing.id, backend.id, comment.id);
        mappedNoteIds.add(existing.id);
      }
      continue;
    }
    const noteId = `n_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    localNotes.push({ id: noteId, text: comment.text, created_at: comment.createdAt.toISOString() });
    await upsertNoteSyncRecord(ticketId, noteId, backend.id, comment.id);
    localTexts.add(comment.text.trim());
    changed = true;
  }

  // Push: local notes not yet mapped → create remote comments
  // Deduplicate: skip if remote already has identical text
  const remoteTexts = new Set(remoteComments.map(c => c.text.trim()));
  for (const note of localNotes) {
    if (mappedNoteIds.has(note.id)) continue;
    if (!backend.createComment) continue;
    if (remoteTexts.has(note.text.trim())) {
      // Text already exists remotely — just create the mapping
      const existing = remoteComments.find(c => c.text.trim() === note.text.trim() && !mappedRemoteIds.has(c.id));
      if (existing) {
        await upsertNoteSyncRecord(ticketId, note.id, backend.id, existing.id);
        mappedRemoteIds.add(existing.id);
      }
      continue;
    }
    try {
      const remoteCommentId = await backend.createComment(remoteId, note.text);
      await upsertNoteSyncRecord(ticketId, note.id, backend.id, remoteCommentId);
      remoteTexts.add(note.text.trim());
    } catch (e) {
      console.warn(`[sync] Failed to push note ${note.id} for ticket ${ticketId}: ${e instanceof Error ? e.message : e}`);
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
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain',
        zip: 'application/zip', json: 'application/json',
      };
      const mimeType = mimeMap[ext] ?? 'application/octet-stream';

      const url = await backend.uploadAttachment(att.original_filename, content, mimeType);
      if (!url) continue;

      // Post a comment with the attachment link
      const isImage = mimeType.startsWith('image/');
      const markdown = isImage
        ? `![${att.original_filename}](${url})`
        : `[${att.original_filename}](${url})`;
      const commentId = await backend.createComment(remoteId, markdown);
      await upsertNoteSyncRecord(ticketId, attSyncId, backend.id, commentId);
    } catch (e) {
      console.warn(`[sync] Failed to upload attachment ${att.original_filename}: ${e instanceof Error ? e.message : e}`);
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

  const conflictData = syncRecord.conflict_data ? JSON.parse(syncRecord.conflict_data) as {
    local: Partial<RemoteTicketFields>;
    remote: Partial<RemoteTicketFields>;
  } : null;

  if (!conflictData) {
    await updateSyncStatus(ticketId, pluginId, 'synced');
    return;
  }

  if (resolution === 'keep_local') {
    // Push local values to remote
    if (backend) {
      await addToOutbox(ticketId, pluginId, 'update', conflictData.local);
      try { await pushToRemote(backend); } catch { /* will retry */ }
    }
  } else {
    // Apply remote values locally
    await applyFieldsToTicket(ticketId, conflictData.remote);
  }

  await updateSyncStatus(ticketId, pluginId, 'synced');
}
