import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTicket } from './queries.js';
import {
  addToOutbox, clearOutbox, deleteSyncRecord, getConflicts,
  getOutboxEntries, getSyncRecord, getSyncRecordByRemoteId,
  getSyncRecordsForPlugin, incrementOutboxAttempts,
  removeOutboxEntry, updateSyncStatus, upsertSyncRecord,
} from './sync.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

describe('ticket_sync table', () => {
  it('upserts a sync record for a ticket', async () => {
    const ticket = await createTicket('Sync test ticket');
    const record = await upsertSyncRecord(ticket.id, 'test-plugin', 'remote-1', 'synced', new Date('2026-01-01'));
    expect(record.ticket_id).toBe(ticket.id);
    expect(record.plugin_id).toBe('test-plugin');
    expect(record.remote_id).toBe('remote-1');
    expect(record.sync_status).toBe('synced');
    expect(record.remote_updated_at).toBeTruthy();
  });

  it('updates existing record on upsert (same ticket+plugin)', async () => {
    const ticket = await createTicket('Upsert test');
    await upsertSyncRecord(ticket.id, 'test-plugin', 'remote-A', 'synced');
    const updated = await upsertSyncRecord(ticket.id, 'test-plugin', 'remote-B', 'pending_push');
    expect(updated.remote_id).toBe('remote-B');
    expect(updated.sync_status).toBe('pending_push');
  });

  it('gets a sync record by ticket ID and plugin ID', async () => {
    const ticket = await createTicket('Get by ID');
    await upsertSyncRecord(ticket.id, 'plugin-a', 'remote-x', 'synced');
    const found = await getSyncRecord(ticket.id, 'plugin-a');
    expect(found).not.toBeNull();
    expect(found!.remote_id).toBe('remote-x');

    const notFound = await getSyncRecord(ticket.id, 'nonexistent');
    expect(notFound).toBeNull();
  });

  it('gets a sync record by remote ID', async () => {
    const ticket = await createTicket('Get by remote');
    await upsertSyncRecord(ticket.id, 'plugin-b', 'remote-unique-123', 'synced');
    const found = await getSyncRecordByRemoteId('plugin-b', 'remote-unique-123');
    expect(found).not.toBeNull();
    expect(found!.ticket_id).toBe(ticket.id);

    const notFound = await getSyncRecordByRemoteId('plugin-b', 'nonexistent');
    expect(notFound).toBeNull();
  });

  it('gets all sync records for a plugin', async () => {
    const t1 = await createTicket('Plugin records 1');
    const t2 = await createTicket('Plugin records 2');
    await upsertSyncRecord(t1.id, 'plugin-multi', 'r1', 'synced');
    await upsertSyncRecord(t2.id, 'plugin-multi', 'r2', 'pending_push');
    const records = await getSyncRecordsForPlugin('plugin-multi');
    expect(records.length).toBeGreaterThanOrEqual(2);
    expect(records.some(r => r.remote_id === 'r1')).toBe(true);
    expect(records.some(r => r.remote_id === 'r2')).toBe(true);
  });

  it('updates sync status and conflict data', async () => {
    const ticket = await createTicket('Status update');
    await upsertSyncRecord(ticket.id, 'plugin-status', 'r-status', 'synced');
    const conflictJson = JSON.stringify({ local: { title: 'A' }, remote: { title: 'B' } });
    await updateSyncStatus(ticket.id, 'plugin-status', 'conflict', conflictJson);
    const record = await getSyncRecord(ticket.id, 'plugin-status');
    expect(record!.sync_status).toBe('conflict');
    expect(record!.conflict_data).toBe(conflictJson);
  });

  it('gets conflicts', async () => {
    const ticket = await createTicket('Conflict query');
    await upsertSyncRecord(ticket.id, 'plugin-conflict', 'r-conf', 'synced');
    await updateSyncStatus(ticket.id, 'plugin-conflict', 'conflict', '{}');

    const allConflicts = await getConflicts();
    expect(allConflicts.some(c => c.ticket_id === ticket.id)).toBe(true);

    const pluginConflicts = await getConflicts('plugin-conflict');
    expect(pluginConflicts.some(c => c.ticket_id === ticket.id)).toBe(true);

    const otherConflicts = await getConflicts('nonexistent-plugin');
    expect(otherConflicts.some(c => c.ticket_id === ticket.id)).toBe(false);
  });

  it('deletes a sync record', async () => {
    const ticket = await createTicket('Delete sync');
    await upsertSyncRecord(ticket.id, 'plugin-del', 'r-del', 'synced');
    expect(await getSyncRecord(ticket.id, 'plugin-del')).not.toBeNull();
    await deleteSyncRecord(ticket.id, 'plugin-del');
    expect(await getSyncRecord(ticket.id, 'plugin-del')).toBeNull();
  });
});

describe('sync_outbox table', () => {
  it('adds entries to the outbox', async () => {
    const ticket = await createTicket('Outbox test');
    const entry = await addToOutbox(ticket.id, 'plugin-out', 'update', { title: 'New title' });
    expect(entry.ticket_id).toBe(ticket.id);
    expect(entry.plugin_id).toBe('plugin-out');
    expect(entry.action).toBe('update');
    expect(JSON.parse(entry.field_changes)).toEqual({ title: 'New title' });
    expect(entry.attempts).toBe(0);
  });

  it('gets outbox entries for a plugin ordered by created_at', async () => {
    const t1 = await createTicket('Outbox order 1');
    const t2 = await createTicket('Outbox order 2');
    await addToOutbox(t1.id, 'plugin-order', 'create', {});
    await addToOutbox(t2.id, 'plugin-order', 'update', { status: 'completed' });
    const entries = await getOutboxEntries('plugin-order');
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Should be in chronological order
    const times = entries.map(e => new Date(e.created_at).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });

  it('removes an outbox entry', async () => {
    const ticket = await createTicket('Remove outbox');
    const entry = await addToOutbox(ticket.id, 'plugin-rm', 'delete', {});
    await removeOutboxEntry(entry.id);
    const entries = await getOutboxEntries('plugin-rm');
    expect(entries.some(e => e.id === entry.id)).toBe(false);
  });

  it('increments attempts and records error', async () => {
    const ticket = await createTicket('Retry outbox');
    const entry = await addToOutbox(ticket.id, 'plugin-retry', 'update', {});
    await incrementOutboxAttempts(entry.id, 'Network timeout');
    const entries = await getOutboxEntries('plugin-retry');
    const updated = entries.find(e => e.id === entry.id)!;
    expect(updated.attempts).toBe(1);
    expect(updated.last_error).toBe('Network timeout');
  });

  it('clears all outbox entries for a plugin', async () => {
    const t1 = await createTicket('Clear outbox 1');
    const t2 = await createTicket('Clear outbox 2');
    await addToOutbox(t1.id, 'plugin-clear', 'create', {});
    await addToOutbox(t2.id, 'plugin-clear', 'update', {});
    await clearOutbox('plugin-clear');
    const entries = await getOutboxEntries('plugin-clear');
    expect(entries.length).toBe(0);
  });

  it('respects limit parameter', async () => {
    const ticket = await createTicket('Limit test');
    await addToOutbox(ticket.id, 'plugin-limit', 'create', {});
    await addToOutbox(ticket.id, 'plugin-limit', 'update', { a: 1 });
    await addToOutbox(ticket.id, 'plugin-limit', 'update', { b: 2 });
    const limited = await getOutboxEntries('plugin-limit', 2);
    expect(limited.length).toBe(2);
  });
});
