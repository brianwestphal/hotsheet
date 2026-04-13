import type { SyncOutboxEntry, SyncStatus, TicketSyncRecord } from '../plugins/types.js';
import { getDb } from './connection.js';

// --- ticket_sync ---

export async function getSyncRecord(ticketId: number, pluginId: string): Promise<TicketSyncRecord | null> {
  const db = await getDb();
  const result = await db.query<TicketSyncRecord>(
    'SELECT * FROM ticket_sync WHERE ticket_id = $1 AND plugin_id = $2',
    [ticketId, pluginId],
  );
  return result.rows[0] ?? null;
}

export async function getSyncRecordByRemoteId(pluginId: string, remoteId: string): Promise<TicketSyncRecord | null> {
  const db = await getDb();
  const result = await db.query<TicketSyncRecord>(
    'SELECT * FROM ticket_sync WHERE plugin_id = $1 AND remote_id = $2',
    [pluginId, remoteId],
  );
  return result.rows[0] ?? null;
}

export async function getSyncRecordsForPlugin(pluginId: string): Promise<TicketSyncRecord[]> {
  const db = await getDb();
  const result = await db.query<TicketSyncRecord>(
    'SELECT * FROM ticket_sync WHERE plugin_id = $1 ORDER BY last_synced_at DESC',
    [pluginId],
  );
  return result.rows;
}

export async function getConflicts(pluginId?: string): Promise<TicketSyncRecord[]> {
  const db = await getDb();
  if (pluginId != null && pluginId !== '') {
    const result = await db.query<TicketSyncRecord>(
      'SELECT * FROM ticket_sync WHERE plugin_id = $1 AND sync_status = $2',
      [pluginId, 'conflict'],
    );
    return result.rows;
  }
  const result = await db.query<TicketSyncRecord>(
    "SELECT * FROM ticket_sync WHERE sync_status = 'conflict'",
  );
  return result.rows;
}

export async function upsertSyncRecord(
  ticketId: number,
  pluginId: string,
  remoteId: string,
  syncStatus: SyncStatus,
  remoteUpdatedAt?: Date | null,
): Promise<TicketSyncRecord> {
  const db = await getDb();
  // Set local_updated_at to the ticket's current updated_at (not NOW()) so
  // the next sync can accurately detect whether the local ticket was modified
  // since this sync point.
  const ticketResult = await db.query<{ updated_at: string }>('SELECT updated_at FROM tickets WHERE id = $1', [ticketId]);
  const localUpdatedAt = ticketResult.rows[0]?.updated_at ?? new Date().toISOString();
  const result = await db.query<TicketSyncRecord>(
    `INSERT INTO ticket_sync (ticket_id, plugin_id, remote_id, sync_status, remote_updated_at, local_updated_at, last_synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (ticket_id, plugin_id) DO UPDATE SET
       remote_id = $3,
       sync_status = $4,
       remote_updated_at = COALESCE($5, ticket_sync.remote_updated_at),
       local_updated_at = $6,
       last_synced_at = NOW()
     RETURNING *`,
    [ticketId, pluginId, remoteId, syncStatus, remoteUpdatedAt?.toISOString() ?? null, localUpdatedAt],
  );
  return result.rows[0];
}

export async function updateSyncStatus(ticketId: number, pluginId: string, status: SyncStatus, conflictData?: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE ticket_sync SET sync_status = $1, conflict_data = $2, last_synced_at = NOW()
     WHERE ticket_id = $3 AND plugin_id = $4`,
    [status, conflictData ?? null, ticketId, pluginId],
  );
}

export async function deleteSyncRecord(ticketId: number, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM ticket_sync WHERE ticket_id = $1 AND plugin_id = $2', [ticketId, pluginId]);
}

// --- sync_outbox ---

export async function addToOutbox(
  ticketId: number,
  pluginId: string,
  action: 'create' | 'update' | 'delete',
  fieldChanges: Record<string, unknown>,
): Promise<SyncOutboxEntry> {
  const db = await getDb();
  const result = await db.query<SyncOutboxEntry>(
    `INSERT INTO sync_outbox (ticket_id, plugin_id, action, field_changes)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [ticketId, pluginId, action, JSON.stringify(fieldChanges)],
  );
  return result.rows[0];
}

export async function getOutboxEntries(pluginId: string, limit = 100): Promise<SyncOutboxEntry[]> {
  const db = await getDb();
  const result = await db.query<SyncOutboxEntry>(
    'SELECT * FROM sync_outbox WHERE plugin_id = $1 ORDER BY created_at ASC LIMIT $2',
    [pluginId, limit],
  );
  return result.rows;
}

export async function removeOutboxEntry(id: number): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM sync_outbox WHERE id = $1', [id]);
}

export async function incrementOutboxAttempts(id: number, error: string): Promise<void> {
  const db = await getDb();
  await db.query(
    'UPDATE sync_outbox SET attempts = attempts + 1, last_error = $1 WHERE id = $2',
    [error, id],
  );
}

export async function clearOutbox(pluginId: string): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM sync_outbox WHERE plugin_id = $1', [pluginId]);
}

// --- note_sync ---

export interface NoteSyncRecord {
  id: number;
  ticket_id: number;
  note_id: string;
  plugin_id: string;
  remote_comment_id: string;
  last_synced_at: string;
  last_synced_text: string | null;
}

export async function getNoteSyncRecords(ticketId: number, pluginId: string): Promise<NoteSyncRecord[]> {
  const db = await getDb();
  const result = await db.query<NoteSyncRecord>(
    'SELECT * FROM note_sync WHERE ticket_id = $1 AND plugin_id = $2',
    [ticketId, pluginId],
  );
  return result.rows;
}

export async function getNoteSyncByRemoteId(ticketId: number, pluginId: string, remoteCommentId: string): Promise<NoteSyncRecord | null> {
  const db = await getDb();
  const result = await db.query<NoteSyncRecord>(
    'SELECT * FROM note_sync WHERE ticket_id = $1 AND plugin_id = $2 AND remote_comment_id = $3',
    [ticketId, pluginId, remoteCommentId],
  );
  return result.rows[0] ?? null;
}

export async function upsertNoteSyncRecord(
  ticketId: number, noteId: string, pluginId: string, remoteCommentId: string, lastSyncedText?: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO note_sync (ticket_id, note_id, plugin_id, remote_comment_id, last_synced_text)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (ticket_id, note_id, plugin_id) DO UPDATE SET
       remote_comment_id = $4,
       last_synced_text = COALESCE($5, note_sync.last_synced_text),
       last_synced_at = NOW()`,
    [ticketId, noteId, pluginId, remoteCommentId, lastSyncedText ?? null],
  );
}

export async function deleteNoteSyncRecord(ticketId: number, noteId: string, pluginId: string): Promise<void> {
  const db = await getDb();
  await db.query('DELETE FROM note_sync WHERE ticket_id = $1 AND note_id = $2 AND plugin_id = $3', [ticketId, noteId, pluginId]);
}
