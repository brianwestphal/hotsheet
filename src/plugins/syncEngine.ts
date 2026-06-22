import { z } from 'zod';

import { getDataDir } from '../db/connection.js';
import {
  addToOutbox, deleteSyncRecord, getOutboxEntries, getSyncRecord,
  getSyncRecordByRemoteId, getSyncRecordsForPlugin, incrementOutboxAttempts,
  removeOutboxEntry, updateSyncStatus, upsertSyncRecord,
} from '../db/sync.js';
import { createTicket, getTicket, updateTicket } from '../db/tickets.js';
import { parseJsonOrNull, TagsArraySchema } from '../schemas.js';
import type { Ticket } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { getAllBackends, getBackendForPlugin, reactivatePlugin } from './loader.js';
// HS-8679 — comment + attachment sync extracted into sibling modules.
import { syncAttachments, syncTicketAttachments } from './syncEngine/attachments.js';
import { syncComments, syncTicketComments } from './syncEngine/comments.js';
import type { RemoteChange, RemoteTicketFields, TicketingBackend,TicketSyncRecord } from './types.js';

// --- Sync scheduling ---

/** Per-plugin sync timers. Each scheduled sync replaces any previous timer for
 *  the same pluginId (startScheduledSync calls stopScheduledSync first).
 *  Overlapping execution is now guarded by `runSync` (HS-8669) — a tick that
 *  fires while a previous run for the same (plugin, project) is still in flight
 *  coalesces onto it rather than starting a second concurrent pass.
 *  Modified by: startScheduledSync(), stopScheduledSync(), stopAllScheduledSyncs(). */
const syncTimers = new Map<string, ReturnType<typeof setInterval>>();

export function startScheduledSync(pluginId: string, intervalMs: number, dataDir?: string): void {
  stopScheduledSync(pluginId);
  const timer = setInterval(async () => {
    // Run in the correct project context
    if (dataDir != null && dataDir !== '') {
      const { runWithDataDir } = await import('../db/connection.js');
      const { instrumentAsync } = await import('../diagnostics/freezeLogger.js');
      await runWithDataDir(dataDir, () => instrumentAsync(dataDir, `plugin.scheduledSync:${pluginId}`, async () => {
        // HS-8360 — instrument the scheduled-sync setInterval body.
        // Pull-from-remote + push-to-remote each issue HTTP calls to the
        // configured ticketing backend (Linear / GitHub / Plane / etc.);
        // JSON parsing + conflict resolution + DB writes happen on the
        // main thread. The interval fires per-plugin per-project so on a
        // multi-project workstation the cumulative load is the dominant
        // candidate for the continuous unattributed block stream.
        await reactivatePlugin(pluginId);
        await runSync(pluginId);
      }));
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

/** HS-8669 — in-flight guard, keyed by (pluginId, dataDir). A scheduled tick or
 *  a manual sync that fires while a previous `runSync` for the SAME plugin in the
 *  SAME project is still running would otherwise run concurrently — both walking
 *  the outbox + the direct-compare push loop, which can create duplicate remote
 *  issues (cf. HS-8658). The dataDir is part of the key so two different projects
 *  CAN sync the same global plugin in parallel (they hit different DBs). A
 *  concurrent caller coalesces onto the in-flight run's result rather than
 *  starting a second pass — the next tick / debounced push picks up anything a
 *  slightly-stale coalesced result missed. */
const inFlightSyncs = new Map<string, Promise<SyncResult>>();

/**
 * HS-8931 — `options.fullPull`: when true, pull EVERY remote item (since=null)
 * instead of the incremental `since=max(last_synced_at)` window. Set for
 * user-initiated ("Sync" button) syncs so they reconcile remote items that have
 * no local sync record and are older than the watermark — which incremental
 * pulls can never reach. Scheduled/auto syncs omit it and stay incremental.
 */
export async function runSync(pluginId: string, options: { fullPull?: boolean } = {}): Promise<SyncResult> {
  // Resolve the current project context defensively — the no-dataDir scheduled
  // branch can call runSync outside a runWithDataDir scope, where getDataDir throws.
  let dataDirKey = '';
  try { dataDirKey = getDataDir(); } catch { dataDirKey = ''; }
  const key = `${pluginId}::${dataDirKey}`;

  const existing = inFlightSyncs.get(key);
  if (existing) return existing;

  const run = runSyncInner(pluginId, options);
  inFlightSyncs.set(key, run);
  try {
    return await run;
  } finally {
    inFlightSyncs.delete(key);
  }
}

async function runSyncInner(pluginId: string, options: { fullPull?: boolean } = {}): Promise<SyncResult> {
  cancelPendingPush(); // Manual sync supersedes debounced push
  const backend = getBackendForPlugin(pluginId);
  if (!backend) return { ok: false, error: 'Backend not found or disabled' };

  const result: SyncResult = { ok: true, pulled: 0, pushed: 0, conflicts: 0 };

  try {
    const pullResult = await pullFromRemote(backend, options.fullPull === true);
    result.pulled = pullResult.applied;
    result.conflicts = (result.conflicts ?? 0) + pullResult.conflicts;
  } catch (e) {
    result.ok = false;
    result.error = `Pull failed: ${getErrorMessage(e)}`;
    console.error(`[sync] Pull failed for ${pluginId}: ${result.error}`);
  }

  try {
    const pushResult = await pushToRemote(backend);
    result.pushed = pushResult.pushed;
  } catch (e) {
    result.ok = false;
    result.error = (result.error != null && result.error !== '' ? result.error + '; ' : '') + `Push failed: ${getErrorMessage(e)}`;
    console.error(`[sync] Push failed for ${pluginId}: ${result.error}`);
  }

  // Sync comments/notes for all synced tickets
  if (backend.capabilities.comments === true && backend.getComments) {
    try {
      await syncComments(backend);
    } catch (e) {
      console.error(`[sync] Comment sync failed for ${pluginId}: ${getErrorMessage(e)}`);
    }
  }

  // Sync attachments for all synced tickets
  if (backend.uploadAttachment) {
    try {
      console.log(`[sync] Starting attachment sync for ${pluginId}`);
      await syncAttachments(backend);
    } catch (e) {
      console.error(`[sync] Attachment sync failed for ${pluginId}: ${getErrorMessage(e)}`);
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

async function pullFromRemote(backend: TicketingBackend, fullPull = false): Promise<{ applied: number; conflicts: number }> {
  const records = await getSyncRecordsForPlugin(backend.id);
  // HS-8931 — the incremental cursor is the latest sync-run time across records.
  // GitHub (and similar) `since` filters by remote updated_at, so any remote item
  // updated BEFORE this cursor that has no local sync record can never be pulled:
  // e.g. an issue whose local ticket was deleted (its record went with it), or one
  // missed by an earlier transient apply failure. Once the cursor advances past it,
  // clicking "Sync" repeatedly never brings it back. A `fullPull` (user-initiated
  // sync) passes since=null to reconcile the entire remote, surfacing those items.
  const lastSyncDate = fullPull || records.length === 0
    ? null
    : new Date(Math.max(...records.map(r => new Date(r.last_synced_at).getTime())));

  const changes = await backend.pullChanges(lastSyncDate);
  let applied = 0;
  let conflicts = 0;

  for (const change of changes) {
    try {
      const result = await applyRemoteChange(backend, change);
      if (result === 'conflict') conflicts++;
      else applied++;
    } catch (e) {
      console.error(`[sync] Failed to apply change for remote ${change.remoteId}: ${getErrorMessage(e)}`);
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

  // Dedup: link this remote issue to a PRE-EXISTING local ticket of the same
  // title (so first-connect against a repo you already track locally doesn't
  // create duplicates). HS-8658 — exclude tickets that already carry a sync
  // record for THIS plugin: two distinct remote issues that happen to share a
  // title (e.g. a closed "foo" + an open "foo") must NOT collapse onto one
  // local ticket. Pre-fix, the second issue processed dedup-matched the ticket
  // the first issue had just created, and `upsertSyncRecord` (UNIQUE on
  // (ticket_id, plugin_id)) OVERWROTE the first issue's remote_id with the
  // second's — so the open issue ended up pointing at the closed issue's
  // `completed` ticket. The `NOT IN (… ticket_sync …)` guard keeps an
  // already-mapped ticket out of the candidate set so each remote issue gets
  // its own local ticket.
  if (change.fields.title != null && change.fields.title !== '') {
    const { getDb: getDbForDedup } = await import('../db/connection.js');
    const db = await getDbForDedup();
    const existing = await db.query<{ id: number }>(
      `SELECT id FROM tickets
         WHERE title = $1 AND status != 'deleted'
           AND id NOT IN (SELECT ticket_id FROM ticket_sync WHERE plugin_id = $2)
         LIMIT 1`,
      [change.fields.title, backend.id],
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
    await updateTicket(ticketId, updates);
  }
}

function extractTicketFields(ticket: Ticket): Partial<RemoteTicketFields> {
  // HS-8567 — zod-validate the tags column rather than blind-casting.
  // Malformed JSON / wrong shape → empty array (defensive since this
  // value gets pushed to GitHub Issues as the label set).
  const parsedTags = parseJsonOrNull(TagsArraySchema, ticket.tags || '[]');
  return {
    title: ticket.title,
    details: ticket.details,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    up_next: ticket.up_next,
    tags: parsedTags ?? [],
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
      const msg = getErrorMessage(e);
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
      await incrementOutboxAttempts(entry.id, getErrorMessage(e));
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

    // A plugin that implements shouldAutoSync gives the authoritative answer on
    // whether to auto-create new tickets — honor it whether it returns true OR
    // false. A false answer is an explicit opt-out (e.g. GitHub's auto_sync_new
    // setting is off) and must NOT fall through to the legacy fallback below.
    if (backend.shouldAutoSync) {
      const ticket = await getTicket(ticketId);
      if (ticket && backend.shouldAutoSync(ticket)) {
        // Check the ticket isn't already synced (e.g. just pulled from remote)
        const existing = await getSyncRecord(ticketId, backend.id);
        if (!existing) {
          await addToOutbox(ticketId, backend.id, 'create', {});
        }
      }
      continue;
    }

    // Legacy: backends without shouldAutoSync auto-create only if there are
    // already synced tickets (prevents cross-project push).
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

/** Push notes and attachments for a single newly-synced ticket. */
export async function syncSingleTicketContent(backend: TicketingBackend, ticketId: number, remoteId: string): Promise<void> {
  if (backend.capabilities.comments === true && backend.getComments) {
    try {
      await syncTicketComments(backend, ticketId, remoteId);
    } catch (e) {
      console.warn(`[sync] Comment sync failed for ticket ${ticketId}: ${getErrorMessage(e)}`);
    }
  }
  if (backend.uploadAttachment) {
    try {
      await syncTicketAttachments(backend, ticketId, remoteId);
    } catch (e) {
      console.warn(`[sync] Attachment sync failed for ticket ${ticketId}: ${getErrorMessage(e)}`);
    }
  }
}

// HS-8679 — comment sync (`syncComments`, `syncTicketComments`, the three
// reconciliation passes, `CommentSyncCtx`) lives in `./syncEngine/comments.ts`.
// Attachment sync (`syncAttachments`, `syncTicketAttachments`) lives in
// `./syncEngine/attachments.ts`. Both are imported at the top of this file.

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

  // HS-8567 — zod-validate the conflict_data column at the parse boundary.
  // Local + remote shapes mirror `Partial<RemoteTicketFields>`; each field
  // is optional because a conflict snapshot only captures the fields that
  // actually differ.
  const RemoteFieldsSchema = z.object({
    title: z.string().optional(),
    details: z.string().optional(),
    category: z.string().optional(),
    priority: z.string().optional(),
    status: z.string().optional(),
    tags: z.array(z.string()).optional(),
    up_next: z.boolean().optional(),
  }).loose();
  const ConflictDataSchema = z.object({
    local: RemoteFieldsSchema.optional(),
    remote: RemoteFieldsSchema.optional(),
  }).loose();
  const conflictData = (syncRecord.conflict_data != null && syncRecord.conflict_data !== '')
    ? parseJsonOrNull(ConflictDataSchema, syncRecord.conflict_data)
    : null;

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
    await applyFieldsToTicket(ticketId, conflictData.remote ?? {});
    await upsertSyncRecord(
      ticketId,
      pluginId,
      syncRecord.remote_id,
      'synced',
      syncRecord.remote_updated_at != null && syncRecord.remote_updated_at !== '' ? new Date(syncRecord.remote_updated_at) : null,
    );
  }
}
