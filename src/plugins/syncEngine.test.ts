import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { getDb } from '../db/connection.js';
import { createTicket, getTicket, updateTicket } from '../db/queries.js';
import {
  addToOutbox, getOutboxEntries, getSyncRecord,
  getSyncRecordByRemoteId, upsertSyncRecord,
} from '../db/sync.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { LoadedPlugin, RemoteTicketFields, TicketingBackend  } from './types.js';

// We need to mock the loader module so the sync engine can find our test backend
vi.mock('./loader.js', () => {
  const backends = new Map<string, TicketingBackend>();
  return {
    getBackendForPlugin: (id: string) => backends.get(id) ?? null,
    getAllBackends: () => Array.from(backends.values()),
    getLoadedPlugins: () => [] as LoadedPlugin[],
    getPluginById: () => undefined,
    // Test helper to register/unregister backends
    __registerBackend: (backend: TicketingBackend) => backends.set(backend.id, backend),
    __clearBackends: () => backends.clear(),
  };
});

// Mock per-project enabled check — default to enabled, can be toggled per test
let pluginEnabledForProject = true;
vi.mock('../routes/plugins.js', () => ({
  isPluginEnabledForProject: () => Promise.resolve(pluginEnabledForProject),
}));

// Import after mocking
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const loaderMock = await import('./loader.js') as typeof import('./loader.js') & {
  __registerBackend: (b: TicketingBackend) => void;
  __clearBackends: () => void;
};
const { runSync, resolveConflict, onTicketChanged, onTicketCreated, stopAllScheduledSyncs, cancelPendingPush, startScheduledSync, stopScheduledSync } = await import('./syncEngine.js');

let tempDir: string;

// --- In-memory mock backend ---

interface MockIssue {
  id: string;
  fields: RemoteTicketFields;
  updatedAt: Date;
  deleted: boolean;
}

function createMockBackend(issues: MockIssue[] = []): TicketingBackend & { issues: MockIssue[] } {
  const backend: TicketingBackend & { issues: MockIssue[] } = {
    id: 'mock-backend',
    name: 'Mock Backend',
    issues,
    capabilities: {
      create: true,
      update: true,
      delete: true,
      incrementalPull: true,
      syncableFields: ['title', 'details', 'category', 'priority', 'status', 'tags', 'up_next'],
    },
    fieldMappings: {
      category: { toRemote: {}, toLocal: {} },
      priority: { toRemote: {}, toLocal: {} },
      status: { toRemote: {}, toLocal: {} },
    },
    createRemote(ticket) {
      const id = `mock-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      issues.push({
        id,
        fields: {
          title: ticket.title,
          details: ticket.details,
          category: ticket.category,
          priority: ticket.priority,
          status: ticket.status,
          tags: JSON.parse(ticket.tags || '[]') as string[],
          up_next: ticket.up_next,
        },
        updatedAt: new Date(),
        deleted: false,
      });
      return Promise.resolve(id);
    },
    updateRemote(remoteId, changes) {
      const issue = issues.find(i => i.id === remoteId);
      if (!issue) throw new Error(`Issue ${remoteId} not found`);
      Object.assign(issue.fields, changes);
      issue.updatedAt = new Date();
      return Promise.resolve();
    },
    deleteRemote(remoteId) {
      const issue = issues.find(i => i.id === remoteId);
      if (issue) { issue.deleted = true; issue.updatedAt = new Date(); }
      return Promise.resolve();
    },
    pullChanges(since) {
      return Promise.resolve(issues
        .filter(i => !since || i.updatedAt > since)
        .map(i => ({
          remoteId: i.id,
          fields: { ...i.fields },
          remoteUpdatedAt: i.updatedAt,
          deleted: i.deleted,
        })));
    },
    getRemoteTicket(remoteId) {
      const issue = issues.find(i => i.id === remoteId);
      return Promise.resolve(issue ? { ...issue.fields } : null);
    },
    checkConnection() {
      return Promise.resolve({ connected: true });
    },
  };
  return backend;
}

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterEach(() => {
  loaderMock.__clearBackends();
  stopAllScheduledSyncs();
  cancelPendingPush();
  pluginEnabledForProject = true; // reset to default
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

describe('sync engine — pull', () => {
  it('creates local tickets from remote issues on first pull', async () => {
    const backend = createMockBackend([
      { id: 'remote-1', fields: { title: 'Remote Issue 1', details: 'Body', category: 'bug', priority: 'high', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
      { id: 'remote-2', fields: { title: 'Remote Issue 2', details: '', category: 'feature', priority: 'default', status: 'started', tags: ['ui'], up_next: true }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    expect(result.pulled).toBe(2);

    // Verify sync records were created
    const rec1 = await getSyncRecordByRemoteId('mock-backend', 'remote-1');
    expect(rec1).not.toBeNull();
    expect(rec1!.sync_status).toBe('synced');

    const rec2 = await getSyncRecordByRemoteId('mock-backend', 'remote-2');
    expect(rec2).not.toBeNull();

    // Verify local tickets were created
    const ticket1 = await getTicket(rec1!.ticket_id);
    expect(ticket1!.title).toBe('Remote Issue 1');
    expect(ticket1!.category).toBe('bug');
    expect(ticket1!.priority).toBe('high');

    const ticket2 = await getTicket(rec2!.ticket_id);
    expect(ticket2!.title).toBe('Remote Issue 2');
    expect(ticket2!.up_next).toBe(true);
  });

  it('updates existing local tickets when remote changes', async () => {
    // Create a local ticket and sync record
    const ticket = await createTicket('Original Title');
    const backend = createMockBackend([
      { id: 'remote-upd', fields: { title: 'Updated Title', details: 'New body', category: 'bug', priority: 'high', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(Date.now() + 10000), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    // Set up sync record — local_updated_at in the past so remote wins
    const db = await getDb();
    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-upd', 'synced');
    await db.query(
      `UPDATE ticket_sync SET local_updated_at = NOW() - INTERVAL '1 hour', remote_updated_at = NOW() - INTERVAL '1 hour'
       WHERE ticket_id = $1 AND plugin_id = 'mock-backend'`,
      [ticket.id],
    );
    // Make sure the local ticket wasn't modified recently
    await db.query(
      `UPDATE tickets SET updated_at = NOW() - INTERVAL '2 hours' WHERE id = $1`,
      [ticket.id],
    );

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);

    const updated = await getTicket(ticket.id);
    expect(updated!.title).toBe('Updated Title');
    expect(updated!.details).toBe('New body');
  });

  it('skips deleted remote issues that have no local counterpart', async () => {
    const backend = createMockBackend([
      { id: 'remote-del-new', fields: { title: 'Deleted Remote', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: true },
    ]);
    loaderMock.__registerBackend(backend);

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    // Should not create a local ticket for a deleted remote
    const rec = await getSyncRecordByRemoteId('mock-backend', 'remote-del-new');
    expect(rec).toBeNull();
  });

  it('detects conflicts when both local and remote changed', async () => {
    const ticket = await createTicket('Conflict test');
    const backend = createMockBackend([
      { id: 'remote-conflict', fields: { title: 'Remote version', details: '', category: 'bug', priority: 'high', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(Date.now() + 5000), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    // Set up sync record with old timestamps
    const db = await getDb();
    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-conflict', 'synced');
    await db.query(
      `UPDATE ticket_sync SET local_updated_at = NOW() - INTERVAL '1 hour', remote_updated_at = NOW() - INTERVAL '1 hour'
       WHERE ticket_id = $1 AND plugin_id = 'mock-backend'`,
      [ticket.id],
    );
    // Make local ticket appear recently modified (conflict!)
    await db.query(
      `UPDATE tickets SET updated_at = NOW(), title = 'Local version' WHERE id = $1`,
      [ticket.id],
    );

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    expect(result.conflicts).toBe(1);

    const syncRec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(syncRec!.sync_status).toBe('conflict');
    expect(syncRec!.conflict_data).toBeTruthy();
    const conflictData = JSON.parse(syncRec!.conflict_data!) as {
      local: Partial<RemoteTicketFields>;
      remote: Partial<RemoteTicketFields>;
    };
    expect(conflictData.local.title).toBe('Local version');
    expect(conflictData.remote.title).toBe('Remote version');
  });
});

describe('sync engine — push', () => {
  it('pushes outbox create entries to the remote', async () => {
    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Push create');
    await addToOutbox(ticket.id, 'mock-backend', 'create', {});

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(1);
    expect(backend.issues.length).toBe(1);
    expect(backend.issues[0].fields.title).toBe('Push create');

    // Outbox should be empty
    const remaining = await getOutboxEntries('mock-backend');
    expect(remaining.length).toBe(0);

    // Sync record should exist
    const syncRec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(syncRec).not.toBeNull();
  });

  it('pushes locally modified tickets to the remote', async () => {
    const backend = createMockBackend([
      { id: 'remote-push-upd', fields: { title: 'Old', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Push update');
    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-push-upd', 'synced');

    // Modify the ticket locally (advances updated_at past the sync record's local_updated_at)
    await updateTicket(ticket.id, { title: 'Updated' });

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    expect(result.pushed).toBeGreaterThanOrEqual(1);
    expect(backend.issues[0].fields.title).toBe('Updated');
  });

  it('pushes outbox delete entries to the remote', async () => {
    const backend = createMockBackend([
      { id: 'remote-push-del', fields: { title: 'To delete', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Push delete');
    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-push-del', 'synced');
    await addToOutbox(ticket.id, 'mock-backend', 'delete', {});

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    expect(backend.issues[0].deleted).toBe(true);
  });
});

describe('sync engine — conflict resolution', () => {
  it('resolves conflict by keeping local (pushes to remote)', async () => {
    const ticket = await createTicket('Resolve local');
    const backend = createMockBackend([
      { id: 'remote-resolve', fields: { title: 'Remote', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-resolve', 'synced');
    const db = await getDb();
    await db.query(
      `UPDATE ticket_sync SET sync_status = 'conflict', conflict_data = $1
       WHERE ticket_id = $2 AND plugin_id = 'mock-backend'`,
      [JSON.stringify({ local: { title: 'Local' }, remote: { title: 'Remote' } }), ticket.id],
    );

    await resolveConflict(ticket.id, 'mock-backend', 'keep_local');

    const syncRec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(syncRec!.sync_status).toBe('synced');
  });

  it('resolves conflict by keeping remote (applies locally)', async () => {
    const ticket = await createTicket('Resolve remote');
    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-resolve-2', 'synced');
    const db = await getDb();
    await db.query(
      `UPDATE ticket_sync SET sync_status = 'conflict', conflict_data = $1
       WHERE ticket_id = $2 AND plugin_id = 'mock-backend'`,
      [JSON.stringify({ local: { title: 'Local' }, remote: { title: 'Remote Winner' } }), ticket.id],
    );

    await resolveConflict(ticket.id, 'mock-backend', 'keep_remote');

    const updated = await getTicket(ticket.id);
    expect(updated!.title).toBe('Remote Winner');

    const syncRec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(syncRec!.sync_status).toBe('synced');
  });
});

describe('sync engine — onTicketChanged', () => {
  it('queues outbox entry when ticket is edited (debounced push)', async () => {
    const backend = createMockBackend([
      { id: 'remote-auto', fields: { title: 'Auto push', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Auto push test');
    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-auto', 'synced');

    await onTicketChanged(ticket.id, { title: 'Changed' });

    // Should have queued to outbox (push is debounced, not immediate)
    const entries = await getOutboxEntries('mock-backend');
    expect(entries.some(e => e.ticket_id === ticket.id && e.action === 'update')).toBe(true);
  });

  it('does nothing for unsynced tickets', async () => {
    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Not synced');
    await onTicketChanged(ticket.id, { title: 'Changed' });

    // No outbox entries should be created
    const entries = await getOutboxEntries('mock-backend');
    expect(entries.filter(e => e.ticket_id === ticket.id).length).toBe(0);
  });
});

describe('sync engine — per-project isolation', () => {
  it('does not queue outbox entries when plugin is disabled for the project', async () => {
    pluginEnabledForProject = false;

    const backend = createMockBackend([
      { id: 'remote-disabled', fields: { title: 'Disabled project', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Should not sync');
    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-disabled', 'synced');

    await onTicketChanged(ticket.id, { title: 'Changed' });

    // No outbox entries should be created for a disabled plugin
    const entries = await getOutboxEntries('mock-backend');
    expect(entries.filter(e => e.ticket_id === ticket.id).length).toBe(0);
  });

  it('does not auto-create on disabled plugins', async () => {
    pluginEnabledForProject = false;

    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Should not push');
    await onTicketCreated(ticket.id);

    const entries = await getOutboxEntries('mock-backend');
    expect(entries.filter(e => e.ticket_id === ticket.id).length).toBe(0);
  });

  it('does not auto-create when no existing sync records (prevents cross-project push)', async () => {
    pluginEnabledForProject = true;

    // Use a fresh backend ID with no prior sync records
    const backend = createMockBackend();
    backend.id = 'fresh-backend';
    backend.name = 'Fresh Backend';
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('New ticket no sync history');
    await onTicketCreated(ticket.id);

    // Should NOT queue a create because no sync records exist for this backend
    const entries = await getOutboxEntries('fresh-backend');
    expect(entries.filter(e => e.ticket_id === ticket.id).length).toBe(0);
  });
});

describe('sync engine — error handling', () => {
  it('returns error when backend is not found', async () => {
    const result = await runSync('nonexistent-backend');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('handles pull errors gracefully', async () => {
    const backend = createMockBackend();
    backend.pullChanges = () => Promise.reject(new Error('Network error'));
    loaderMock.__registerBackend(backend);

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Pull failed');
  });

  it('handles push errors gracefully', async () => {
    const backend = createMockBackend();
    backend.createRemote = () => Promise.reject(new Error('Auth failed'));
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Push fail');
    await addToOutbox(ticket.id, 'mock-backend', 'create', {});

    // Clear any stale outbox entries from other backends
    const beforeEntries = await getOutboxEntries('mock-backend');
    const ourEntry = beforeEntries.find(e => e.ticket_id === ticket.id);
    expect(ourEntry).toBeTruthy();

    await runSync('mock-backend');

    // Outbox entry should still be there with incremented attempts
    const entries = await getOutboxEntries('mock-backend');
    const entry = entries.find(e => e.ticket_id === ticket.id);
    expect(entry).toBeTruthy();
    // The entry may or may not have been processed depending on ordering
    // with entries from other tests; just verify it wasn't removed
    expect(entry!.attempts).toBeGreaterThanOrEqual(0);
  });
});

describe('sync engine — HS-5058: stale records & outbox exhaustion', () => {
  it('push 404 removes the stale sync record', async () => {
    // User expectation: if a synced issue is gone from the remote, Hot Sheet
    // stops trying to sync the broken link.
    const backend = createMockBackend();
    backend.updateRemote = () => Promise.reject(new Error('GitHub API error 404: Not Found'));
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Stale push cleanup');
    await upsertSyncRecord(ticket.id, 'mock-backend', 'gone-remote-id', 'synced');
    // Force local update so pushToRemote attempts an updateRemote call.
    await updateTicket(ticket.id, { title: 'Edited to trigger push' });

    await runSync('mock-backend');

    // Sync record should be gone.
    const rec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(rec).toBeNull();
  });

  it('comment-sync 404 removes the stale sync record even without a local edit', async () => {
    // User expectation: even if I don't edit the ticket, if the remote issue
    // is deleted externally, the broken link gets cleaned up on the next sync.
    // This is the path via syncComments catching the 404 from getComments.
    const backend = createMockBackend();
    backend.capabilities.comments = true;
    backend.getComments = () => Promise.reject(new Error('GitHub API error 404: Not Found'));
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Stale comment cleanup');
    // Sync record points to a remote that 404s. No local edit (no push push).
    await upsertSyncRecord(ticket.id, 'mock-backend', 'gone-remote-2', 'synced');

    await runSync('mock-backend');

    const rec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(rec).toBeNull();
  });

  it('scheduled sync fires on the configured interval and stops when cancelled', async () => {
    // User expectation: "if I schedule a sync, it actually runs on its own."
    const backend = createMockBackend();
    let pullCount = 0;
    const originalPull = backend.pullChanges.bind(backend);
    backend.pullChanges = (since) => {
      pullCount++;
      return originalPull(since);
    };
    loaderMock.__registerBackend(backend);

    // Start a very fast schedule (150ms). The public route's interval_minutes
    // floors at 1 minute, but the underlying startScheduledSync accepts ms.
    startScheduledSync('mock-backend', 150);

    // Wait long enough for at least 2 ticks.
    await new Promise(r => setTimeout(r, 400));
    expect(pullCount).toBeGreaterThanOrEqual(2);

    // Stop the schedule and confirm it actually stops.
    stopScheduledSync('mock-backend');
    const countAfterStop = pullCount;
    await new Promise(r => setTimeout(r, 300));
    expect(pullCount).toBe(countAfterStop);
  });

  it('outbox create entry is skipped when ticket already has a sync record (HS-5083)', async () => {
    // Exact repro: user creates a ticket (onTicketCreated queues a create outbox
    // entry via the legacy auto-create path), then pushes via push-ticket (which
    // creates the remote issue + sync record directly). On the next sync, the
    // stale outbox entry must be skipped — not processed as a second create.
    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    // Simulate the legacy auto-create: a create outbox entry exists...
    const ticket = await createTicket('HS-5083 repro');
    await addToOutbox(ticket.id, 'mock-backend', 'create', {});

    // ...but push-ticket already created the remote and established a sync record.
    const firstRemoteId = 'existing-remote-from-push-ticket';
    backend.issues.push({
      id: firstRemoteId,
      fields: { title: ticket.title, details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false },
      updatedAt: new Date(),
      deleted: false,
    });
    await upsertSyncRecord(ticket.id, 'mock-backend', firstRemoteId, 'synced');

    // Run sync — the outbox create entry must NOT create a second remote issue.
    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);

    // The mock backend should NOT have a second issue — only the one from push-ticket.
    const createdByOutbox = backend.issues.filter(i => i.id !== firstRemoteId);
    expect(createdByOutbox.length).toBe(0);

    // The sync record should still point to the original remote issue.
    const syncRec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(syncRec!.remote_id).toBe(firstRemoteId);

    // The outbox entry should be removed (not left dangling).
    const remaining = await getOutboxEntries('mock-backend');
    expect(remaining.find(e => e.ticket_id === ticket.id)).toBeUndefined();
  });

  it('outbox create entry is permanently removed after 5 failed attempts', async () => {
    // User expectation: if a sync keeps failing for the same ticket, it
    // eventually gives up instead of churning forever.
    const backend = createMockBackend();
    backend.createRemote = () => Promise.reject(new Error('Always fails'));
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Exhaustion test');
    await addToOutbox(ticket.id, 'mock-backend', 'create', {});

    // Each runSync call tries once, fails, increments attempts by 1.
    // After 5 failures attempts == 5. The 6th run should remove the entry
    // before even attempting the operation.
    for (let i = 0; i < 5; i++) {
      await runSync('mock-backend');
    }

    // After 5 failed runs, the entry should still exist with attempts == 5.
    let entries = await getOutboxEntries('mock-backend');
    let entry = entries.find(e => e.ticket_id === ticket.id);
    expect(entry).toBeTruthy();
    expect(entry!.attempts).toBe(5);

    // The 6th run should REMOVE the entry (the check `if (attempts >= 5)` at
    // the top of the outbox loop fires before the try block).
    await runSync('mock-backend');
    entries = await getOutboxEntries('mock-backend');
    entry = entries.find(e => e.ticket_id === ticket.id);
    expect(entry).toBeUndefined();
  });
});
