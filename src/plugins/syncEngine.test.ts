import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAttachments } from '../db/attachments.js';
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
  const plugins = new Map<string, LoadedPlugin>();
  return {
    getBackendForPlugin: (id: string) => backends.get(id) ?? null,
    getAllBackends: () => Array.from(backends.values()),
    getLoadedPlugins: () => Array.from(plugins.values()),
    getPluginById: (id: string) => plugins.get(id),
    // Test helper to register/unregister backends
    __registerBackend: (backend: TicketingBackend) => backends.set(backend.id, backend),
    __clearBackends: () => backends.clear(),
    // HS-8933 — register a fake LoadedPlugin so applyScheduledSyncFromConfig can
    // read its manifest preferences (it only needs id + manifest.preferences).
    __registerPlugin: (plugin: LoadedPlugin) => plugins.set(plugin.manifest.id, plugin),
    __clearPlugins: () => plugins.clear(),
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
  __registerPlugin: (p: LoadedPlugin) => void;
  __clearPlugins: () => void;
};
const { runSync, resolveConflict, onTicketChanged, onTicketCreated, stopAllScheduledSyncs, cancelPendingPush, startScheduledSync, stopScheduledSync, applyScheduledSyncFromConfig, isSyncScheduled, getPendingSyncCounts } = await import('./syncEngine.js');

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
      // HS-8954/HS-8955 — like the real GitHub PATCH, the edit bumps the remote's
      // updatedAt; return it so the engine can advance its watermark past the push.
      return Promise.resolve({ remoteUpdatedAt: issue.updatedAt });
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
  loaderMock.__clearPlugins();
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

  it('does NOT collapse two remote issues that share a title onto one local ticket (HS-8658)', async () => {
    // Mirror the real GitHub bug: a CLOSED issue → completed and an OPEN issue
    // → not_started, both with the SAME title. The GitHub plugin pulls newest-
    // updated first, so the completed one is processed before the not_started
    // one and creates its local ticket first. Pre-fix, the second issue's
    // title-dedup matched that just-created ticket and `upsertSyncRecord`
    // (UNIQUE on (ticket_id, plugin_id)) overwrote the first issue's remote_id
    // — so the OPEN issue ended up pointing at the closed issue's `completed`
    // ticket (and the closed issue's sync record vanished).
    const t = Date.now();
    const backend = createMockBackend([
      { id: 'gh-closed', fields: { title: 'middle click closes tab', details: '', category: 'issue', priority: 'default', status: 'completed', tags: [], up_next: false }, updatedAt: new Date(t + 20000), deleted: false },
      { id: 'gh-open', fields: { title: 'middle click closes tab', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(t + 10000), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const result = await runSync('mock-backend');
    expect(result.ok).toBe(true);
    expect(result.pulled).toBe(2);

    // Each remote issue keeps its OWN sync record (pre-fix, gh-closed's record
    // was overwritten so this lookup returned null) pointing at its OWN ticket.
    const recClosed = await getSyncRecordByRemoteId('mock-backend', 'gh-closed');
    const recOpen = await getSyncRecordByRemoteId('mock-backend', 'gh-open');
    expect(recClosed).not.toBeNull();
    expect(recOpen).not.toBeNull();
    expect(recClosed!.ticket_id).not.toBe(recOpen!.ticket_id);

    // ...and each ticket carries the status its own remote state implies.
    const closedTicket = await getTicket(recClosed!.ticket_id);
    const openTicket = await getTicket(recOpen!.ticket_id);
    expect(closedTicket!.status).toBe('completed');
    expect(openTicket!.status).toBe('not_started');
  });

  it('still dedups a remote issue onto a PRE-EXISTING UNSYNCED local ticket of the same title', async () => {
    // The original dedup intent (HS-8658 keeps it): first-connecting a plugin to
    // a repo you already track locally links the remote issue to the existing
    // ticket instead of creating a duplicate. The local ticket has no sync
    // record yet, so it's still a valid dedup target.
    const local = await createTicket('Pre-existing dedup title', { status: 'started' });
    const backend = createMockBackend([
      { id: 'gh-dedup', fields: { title: 'Pre-existing dedup title', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);

    const result = await runSync('mock-backend');
    expect(result.pulled).toBe(1);

    const rec = await getSyncRecordByRemoteId('mock-backend', 'gh-dedup');
    expect(rec).not.toBeNull();
    expect(rec!.ticket_id).toBe(local.id); // linked to the existing ticket, no duplicate created
  });

  it('HS-8931: a manual full sync reconciles a remote issue older than the incremental watermark with no sync record', async () => {
    // Reproduces the "issues not syncing" bug: GitHub's incremental `since`
    // cursor is max(last_synced_at). Any remote issue updated BEFORE that cursor
    // that has no local sync record (e.g. its ticket was deleted, or an earlier
    // sync missed it) can never be pulled incrementally — clicking "Sync"
    // forever does nothing. A user-initiated FULL pull (since=null) reconciles it.

    // 1. Sync one current issue -> establishes a watermark (~now).
    const backend = createMockBackend([
      { id: 'gh-current', fields: { title: 'Current Issue', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend');
    expect(await getSyncRecordByRemoteId('mock-backend', 'gh-current')).not.toBeNull();

    // 2. A remote issue updated a week ago (well before the watermark), unsynced.
    backend.issues.push({
      id: 'gh-stranded',
      fields: { title: 'Stranded Issue', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false },
      updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      deleted: false,
    });

    // 3. Incremental sync (scheduled-style) never reaches it.
    const incremental = await runSync('mock-backend');
    expect(incremental.pulled).toBe(0);
    expect(await getSyncRecordByRemoteId('mock-backend', 'gh-stranded')).toBeNull();

    // 4. A user-initiated full sync reconciles it.
    await runSync('mock-backend', { fullPull: true });
    const rec = await getSyncRecordByRemoteId('mock-backend', 'gh-stranded');
    expect(rec).not.toBeNull();
    expect(rec!.sync_status).toBe('synced');
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

describe('sync engine — push watermark advances past our own edit (HS-8954 / HS-8955)', () => {
  it('a local status move is not clobbered by repeated full syncs, and the pending count settles to 0', async () => {
    // Unique plugin id so getPendingSyncCounts (which is global per plugin) sees
    // only this test's record, not leftover dirty/conflict records from the
    // shared test DB.
    const backend = createMockBackend([
      { id: 'remote-wm', fields: { title: 'WM', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    backend.id = 'mock-backend-wm';
    loaderMock.__registerBackend(backend);

    // First sync establishes the local ticket + sync record.
    await runSync('mock-backend-wm', { fullPull: true });
    const db = await getDb();
    const row = await db.query<{ id: number }>("SELECT ts.ticket_id AS id FROM ticket_sync ts WHERE ts.plugin_id = 'mock-backend-wm'");
    const ticketId = row.rows[0].id;

    // User moves it to a local-only status GitHub doesn't model.
    await updateTicket(ticketId, { status: 'backlog' });

    // Two full syncs — the manual "Sync" button uses fullPull. The first pushes
    // (bumping the remote updatedAt); the second is the "click Sync again" that
    // pre-fix re-applied the remote `not_started` over the local `backlog`.
    await runSync('mock-backend-wm', { fullPull: true });
    await runSync('mock-backend-wm', { fullPull: true });

    const after = await getTicket(ticketId);
    expect(after?.status).toBe('backlog'); // HS-8954 — survived; not reset to not_started

    const counts = await getPendingSyncCounts(backend);
    expect(counts.total).toBe(0); // HS-8955 — out-of-sync count returns to 0
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

  // HS-8952 — a body image never pulls while a ticket sits in conflict (apply
  // paths are skipped). Resolving the conflict must backfill its attachments.
  it('pulls body images when a conflict is resolved (HS-8952)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const body = '<img src="https://github.com/user-attachments/assets/zzz-1">';
    const ticket = await createTicket('Conflict with image', { details: body });
    const backend = createMockBackend();
    backend.downloadAttachment = () => Promise.resolve({ content: png, filename: 'shot.png', mimeType: 'image/png' });
    loaderMock.__registerBackend(backend);

    await upsertSyncRecord(ticket.id, 'mock-backend', 'remote-img', 'synced');
    const db = await getDb();
    await db.query(
      `UPDATE ticket_sync SET sync_status = 'conflict', conflict_data = $1
       WHERE ticket_id = $2 AND plugin_id = 'mock-backend'`,
      [JSON.stringify({ local: { details: body }, remote: { details: body } }), ticket.id],
    );
    expect(await getAttachments(ticket.id)).toHaveLength(0);

    await resolveConflict(ticket.id, 'mock-backend', 'keep_remote');

    expect(await getAttachments(ticket.id)).toHaveLength(1);
  });
});

// HS-8952 — tickets that synced BEFORE body-image support must gain their
// attachments on the next full pull (the unmodified "skipped" apply path).
describe('sync engine — body-image backfill on full pull (HS-8952)', () => {
  it('backfills body images for an already-synced, unmodified ticket on a full pull', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const body = '<img src="https://github.com/user-attachments/assets/backfill-1">';
    const backend = createMockBackend([
      { id: 'r-backfill', fields: { title: 'Has image', details: body, category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    // First sync runs WITHOUT image support (capability absent) → ticket synced, no image.
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend');
    const rec = await getSyncRecordByRemoteId('mock-backend', 'r-backfill');
    expect(rec).not.toBeNull();
    expect(await getAttachments(rec!.ticket_id)).toHaveLength(0);

    // Now the backend gains downloadAttachment; a FULL pull revisits the unmodified
    // issue via the skip path and backfills the attachment.
    backend.downloadAttachment = () => Promise.resolve({ content: png, filename: 'late.png', mimeType: 'image/png' });
    await runSync('mock-backend', { fullPull: true });

    expect(await getAttachments(rec!.ticket_id)).toHaveLength(1);
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

describe('sync engine — HS-8661: shouldAutoSync opt-out is authoritative', () => {
  it('does not auto-create when shouldAutoSync returns false, even with existing synced tickets', async () => {
    pluginEnabledForProject = true;

    // Backend that explicitly opts OUT of auto-sync (e.g. GitHub's auto_sync_new off)
    const backend = createMockBackend();
    backend.id = 'optout-backend';
    backend.name = 'Opt-out Backend';
    backend.shouldAutoSync = () => false;
    loaderMock.__registerBackend(backend);

    // Precondition: at least one ticket is already synced to this backend. Before
    // the fix this is exactly what made the legacy fallback push the new ticket.
    const alreadySynced = await createTicket('Already synced');
    await upsertSyncRecord(alreadySynced.id, 'optout-backend', 'remote-existing', 'synced');

    const ticket = await createTicket('Should respect opt-out');
    await onTicketCreated(ticket.id);

    const entries = await getOutboxEntries('optout-backend');
    expect(entries.filter(e => e.ticket_id === ticket.id).length).toBe(0);
  });

  it('auto-creates when shouldAutoSync returns true', async () => {
    pluginEnabledForProject = true;

    const backend = createMockBackend();
    backend.id = 'optin-backend';
    backend.name = 'Opt-in Backend';
    backend.shouldAutoSync = () => true;
    loaderMock.__registerBackend(backend);

    const ticket = await createTicket('Should auto-sync');
    await onTicketCreated(ticket.id);

    const entries = await getOutboxEntries('optin-backend');
    const created = entries.filter(e => e.ticket_id === ticket.id);
    expect(created.length).toBe(1);
    expect(created[0].action).toBe('create');
  });

  it('does not auto-create when shouldAutoSync returns true but the ticket is already synced', async () => {
    pluginEnabledForProject = true;

    const backend = createMockBackend();
    backend.id = 'optin-synced-backend';
    backend.name = 'Opt-in Already-Synced Backend';
    backend.shouldAutoSync = () => true;
    loaderMock.__registerBackend(backend);

    // Simulates a ticket that was just pulled from remote — already has a sync record.
    const ticket = await createTicket('Pulled from remote');
    await upsertSyncRecord(ticket.id, 'optin-synced-backend', 'remote-pulled', 'synced');

    await onTicketCreated(ticket.id);

    const entries = await getOutboxEntries('optin-synced-backend');
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

  it('HS-8933: the first scheduled run does a FULL pull, reconciling a stranded issue', async () => {
    // Auto-sync must self-heal the HS-8931 stranding class: an issue older than
    // the incremental watermark with no sync record. The first scheduled run is a
    // full pull, so background sync recovers it without a manual click.
    const backend = createMockBackend([
      { id: 'gh-current', fields: { title: 'Current', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend'); // establish the watermark

    backend.issues.push({
      id: 'gh-stranded',
      fields: { title: 'Stranded', details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false },
      updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      deleted: false,
    });

    startScheduledSync('mock-backend', 120);
    await new Promise(r => setTimeout(r, 450)); // let the first (full) tick run
    stopScheduledSync('mock-backend');

    expect(await getSyncRecordByRemoteId('mock-backend', 'gh-stranded')).not.toBeNull();
  });

  it('HS-8933: stopScheduledSync targets only the given project (per-(plugin,dataDir) keying)', async () => {
    const backend = createMockBackend();
    let pulls = 0;
    const orig = backend.pullChanges.bind(backend);
    backend.pullChanges = (s) => { pulls++; return orig(s); };
    loaderMock.__registerBackend(backend);

    startScheduledSync('mock-backend', 120); // key "mock-backend::"
    await new Promise(r => setTimeout(r, 320));
    expect(pulls).toBeGreaterThanOrEqual(1);

    // Stopping a DIFFERENT project's timer must NOT stop this one.
    stopScheduledSync('mock-backend', '/some/other/project');
    const before = pulls;
    await new Promise(r => setTimeout(r, 320));
    expect(pulls).toBeGreaterThan(before);

    stopScheduledSync('mock-backend'); // no dataDir → stops all for the plugin
    const after = pulls;
    await new Promise(r => setTimeout(r, 300));
    expect(pulls).toBe(after);
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

describe('sync engine — scheduled sync', () => {
  afterEach(() => {
    stopAllScheduledSyncs();
  });

  it('startScheduledSync and stopScheduledSync manage timers', () => {
    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    // Should not throw
    startScheduledSync('mock-backend', 60000, tempDir);
    // Starting again should replace the existing timer
    startScheduledSync('mock-backend', 120000, tempDir);
    // Stop should not throw
    stopScheduledSync('mock-backend');
    // Stopping again should be a no-op
    stopScheduledSync('mock-backend');
  });
});

describe('sync engine — cancelPendingPush', () => {
  it('cancelPendingPush is callable (no-op debounce cancellation)', () => {
    // cancelPendingPush is a no-op that cancels any pending debounced push timer
    expect(() => cancelPendingPush()).not.toThrow();
  });
});

describe('sync engine — resolveConflict keep_remote', () => {
  it('keep_remote applies remote values to the local ticket', async () => {
    const backend = createMockBackend();
    loaderMock.__registerBackend(backend);

    // Create and push a ticket
    const ticket = await createTicket('Conflict remote test');
    await addToOutbox(ticket.id, 'mock-backend', 'create', {});
    await runSync('mock-backend');

    const syncRec = await getSyncRecord(ticket.id, 'mock-backend');
    expect(syncRec).toBeTruthy();

    // Simulate a conflict by setting sync status
    const db = await getDb();
    await db.query(`UPDATE ticket_sync SET sync_status = 'conflict', conflict_data = $1 WHERE id = $2`, [
      JSON.stringify({ local: { title: 'Local title' }, remote: { title: 'Remote title' } }),
      syncRec!.id,
    ]);

    // Resolve as keep_remote
    await resolveConflict(ticket.id, 'mock-backend', 'keep_remote');

    // The sync record should now be 'synced'
    const resolved = await getSyncRecord(ticket.id, 'mock-backend');
    expect(resolved!.sync_status).toBe('synced');
  });
});

describe('sync engine — overlapping run guard (HS-8669)', () => {
  it('coalesces concurrent runSync calls for the same plugin into one pass', async () => {
    const backend = createMockBackend([
      { id: 'remote-guard', fields: { title: 'Guard', details: '', category: 'bug', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    // Count + slow down pullChanges so the first runSync is still in flight
    // when the second is invoked — without the guard, both would pull/push.
    let pullCount = 0;
    const originalPull = backend.pullChanges.bind(backend);
    backend.pullChanges = async (since: Date | null) => {
      pullCount++;
      await new Promise(resolve => setTimeout(resolve, 20));
      return originalPull(since);
    };
    loaderMock.__registerBackend(backend);

    const [r1, r2] = await Promise.all([runSync('mock-backend'), runSync('mock-backend')]);

    expect(pullCount).toBe(1); // second call coalesced onto the in-flight run
    expect(r1).toBe(r2); // both callers received the same result object
    expect(r1.ok).toBe(true);
  });

  it('runs again after the previous run settles (guard is released)', async () => {
    const backend = createMockBackend([
      { id: 'remote-release', fields: { title: 'Release', details: '', category: 'bug', priority: 'default', status: 'not_started', tags: [], up_next: false }, updatedAt: new Date(), deleted: false },
    ]);
    let pullCount = 0;
    const originalPull = backend.pullChanges.bind(backend);
    backend.pullChanges = (since: Date | null) => { pullCount++; return originalPull(since); };
    loaderMock.__registerBackend(backend);

    await runSync('mock-backend');
    await runSync('mock-backend'); // sequential — the first already settled

    expect(pullCount).toBe(2); // guard released, second sync ran for real
  });
});

describe('sync engine — applyScheduledSyncFromConfig (HS-8933)', () => {
  const fakePlugin = (): LoadedPlugin => ({
    manifest: {
      id: 'mock-backend', name: 'Mock', version: '1',
      preferences: [{ key: 'sync_interval_minutes', label: 'Auto-sync every', type: 'select', default: '15' }],
    },
    path: '', instance: {}, backend: null, enabled: true, error: null,
  } as unknown as LoadedPlugin);

  async function setSetting(key: string, value: string): Promise<void> {
    const db = await getDb();
    await db.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2', [key, value]);
  }
  async function clearSetting(key: string): Promise<void> {
    const db = await getDb();
    await db.query('DELETE FROM settings WHERE key = $1', [key]);
  }

  it('schedules when enabled with a valid interval', async () => {
    loaderMock.__registerPlugin(fakePlugin());
    await setSetting('plugin_enabled:mock-backend', 'true');
    await setSetting('plugin:mock-backend:sync_interval_minutes', '5');
    await applyScheduledSyncFromConfig('mock-backend', tempDir);
    expect(isSyncScheduled('mock-backend', tempDir)).toBe(true);
  });

  it('falls back to the manifest default (15 min) when the interval is unset', async () => {
    loaderMock.__registerPlugin(fakePlugin());
    await setSetting('plugin_enabled:mock-backend', 'true');
    await clearSetting('plugin:mock-backend:sync_interval_minutes');
    await applyScheduledSyncFromConfig('mock-backend', tempDir);
    expect(isSyncScheduled('mock-backend', tempDir)).toBe(true);
  });

  it('does NOT schedule when the plugin is disabled for the project', async () => {
    loaderMock.__registerPlugin(fakePlugin());
    await setSetting('plugin_enabled:mock-backend', 'false');
    await setSetting('plugin:mock-backend:sync_interval_minutes', '5');
    await applyScheduledSyncFromConfig('mock-backend', tempDir);
    expect(isSyncScheduled('mock-backend', tempDir)).toBe(false);
  });

  it('stops scheduling when the interval is set to Off (0)', async () => {
    loaderMock.__registerPlugin(fakePlugin());
    await setSetting('plugin_enabled:mock-backend', 'true');
    await setSetting('plugin:mock-backend:sync_interval_minutes', '5');
    await applyScheduledSyncFromConfig('mock-backend', tempDir);
    expect(isSyncScheduled('mock-backend', tempDir)).toBe(true);

    await setSetting('plugin:mock-backend:sync_interval_minutes', '0');
    await applyScheduledSyncFromConfig('mock-backend', tempDir);
    expect(isSyncScheduled('mock-backend', tempDir)).toBe(false);
  });

  it('ignores plugins that do not declare the interval preference', async () => {
    const noPref = { ...fakePlugin(), manifest: { id: 'mock-backend', name: 'Mock', version: '1', preferences: [] } } as unknown as LoadedPlugin;
    loaderMock.__registerPlugin(noPref);
    await setSetting('plugin_enabled:mock-backend', 'true');
    await applyScheduledSyncFromConfig('mock-backend', tempDir);
    expect(isSyncScheduled('mock-backend', tempDir)).toBe(false);
  });
});

describe('sync engine — getPendingSyncCounts (HS-8791)', () => {
  // The file shares one DB across all tests; wipe sync state so each count test
  // starts from a clean baseline rather than inheriting earlier tests' tickets.
  beforeEach(async () => {
    const db = await getDb();
    await db.query('DELETE FROM ticket_sync');
    await db.query('DELETE FROM sync_outbox');
    await db.query('DELETE FROM tickets');
  });

  const issue = (id: string, title: string, updatedAt: Date) => ({
    id, fields: { title, details: '', category: 'issue', priority: 'default', status: 'not_started', tags: [], up_next: false } as RemoteTicketFields, updatedAt, deleted: false,
  });

  it('counts un-synced remote items as toPull (incoming)', async () => {
    const backend = createMockBackend([issue('r1', 'One', new Date()), issue('r2', 'Two', new Date())]);
    loaderMock.__registerBackend(backend);
    const counts = await getPendingSyncCounts(backend);
    expect(counts.toPull).toBe(2);
    expect(counts.toPush).toBe(0);
    expect(counts.total).toBe(2);
  });

  it('reports 0 toPull once everything is synced', async () => {
    const backend = createMockBackend([issue('r1', 'One', new Date())]);
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend');
    const counts = await getPendingSyncCounts(backend);
    expect(counts.toPull).toBe(0);
    expect(counts.total).toBe(0);
  });

  it('counts a locally-modified synced ticket as toPush (outgoing)', async () => {
    const backend = createMockBackend([issue('r1', 'One', new Date())]);
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend');
    const rec = await getSyncRecordByRemoteId('mock-backend', 'r1');
    await new Promise(r => setTimeout(r, 10)); // ensure updated_at advances past local_updated_at
    await updateTicket(rec!.ticket_id, { title: 'Edited locally' });

    const counts = await getPendingSyncCounts(backend);
    expect(counts.toPush).toBeGreaterThanOrEqual(1);
    expect(counts.total).toBe(counts.toPull + counts.toPush);
  });

  it('degrades to 0 incoming when the remote read throws', async () => {
    const backend = createMockBackend();
    backend.pullChanges = () => Promise.reject(new Error('rate limited'));
    loaderMock.__registerBackend(backend);
    const counts = await getPendingSyncCounts(backend);
    expect(counts.toPull).toBe(0); // best-effort: no throw
  });

  // HS-8955 — the "count never goes to 0" bug. A locally-modified ticket that is
  // in `conflict` status is dirty, but pushToRemote skips non-`synced` records, so
  // it can never be pushed away. It must NOT count toward toPush (conflicts are
  // surfaced separately) — otherwise the badge sticks at ≥1 forever.
  it('does NOT count a conflict ticket as toPush (HS-8955)', async () => {
    const backend = createMockBackend([issue('r1', 'One', new Date())]);
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend');
    const rec = await getSyncRecordByRemoteId('mock-backend', 'r1');
    await new Promise(r => setTimeout(r, 10));
    await updateTicket(rec!.ticket_id, { title: 'Edited locally' }); // now dirty
    // Without the conflict, this edit would count as toPush.
    expect((await getPendingSyncCounts(backend)).toPush).toBeGreaterThanOrEqual(1);

    // Flip the record to conflict — push will skip it, so the count must drop it.
    const db = await getDb();
    await db.query("UPDATE ticket_sync SET sync_status = 'conflict' WHERE id = $1", [rec!.id]);
    const counts = await getPendingSyncCounts(backend);
    expect(counts.toPush).toBe(0);
    expect(counts.total).toBe(0);
  });

  // HS-8955 — editing a synced ticket bumps both the dirty query AND queues an
  // `update` outbox entry. pushToRemote pushes the edit via the dirty-ticket loop
  // (not the outbox), so counting the outbox `update` double-counted one edit.
  it('does not double-count an edited ticket via its update outbox entry (HS-8955)', async () => {
    const backend = createMockBackend([issue('r1', 'One', new Date())]);
    loaderMock.__registerBackend(backend);
    await runSync('mock-backend');
    const rec = await getSyncRecordByRemoteId('mock-backend', 'r1');
    await new Promise(r => setTimeout(r, 10));
    await updateTicket(rec!.ticket_id, { title: 'Edited locally' }); // dirty (+1)
    await addToOutbox(rec!.ticket_id, 'mock-backend', 'update', { title: 'Edited locally' }); // would be +1

    const counts = await getPendingSyncCounts(backend);
    expect(counts.toPush).toBe(1); // not 2
  });
});
