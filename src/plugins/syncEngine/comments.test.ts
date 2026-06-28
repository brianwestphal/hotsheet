/**
 * HS-9132 — integration coverage for the comment-sync slice
 * (`syncEngine/comments.ts`). The existing `syncEngine.test.ts` mock backend has
 * no comment methods, so this 3-pass reconciliation was ~14% covered. These
 * tests run against a real PGLite test DB with a comment-capable mock backend.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../../db/connection.js';
import { generateNoteId } from '../../db/notes.js';
import { getNoteSyncRecords, getSyncRecord, upsertNoteSyncRecord, upsertSyncRecord } from '../../db/sync.js';
import { createTicket, getTicket } from '../../db/tickets.js';
import { cleanupTestDb, setupTestDb } from '../../test-helpers.js';
import type { RemoteComment, TicketingBackend } from '../types.js';
import { syncComments, syncTicketComments } from './comments.js';

let tempDir: string;
let pluginSeq = 0;

interface RC { id: string; text: string; createdAt: Date }

function makeBackend(comments: RC[] = [], opts: { getCommentsThrows?: string } = {}): TicketingBackend & { comments: RC[]; created: string[]; updated: Array<[string, string]>; deleted: string[] } {
  let seq = 0;
  const created: string[] = [];
  const updated: Array<[string, string]> = [];
  const deleted: string[] = [];
  const backend = {
    id: `cmt-plugin-${pluginSeq++}`,
    name: 'Comment Backend',
    comments, created, updated, deleted,
    capabilities: { create: true, update: true, delete: true, incrementalPull: true, syncableFields: [] },
    fieldMappings: { category: { toRemote: {}, toLocal: {} }, priority: { toRemote: {}, toLocal: {} }, status: { toRemote: {}, toLocal: {} } },
    createRemote: () => Promise.resolve('r'),
    updateRemote: () => Promise.resolve({}),
    deleteRemote: () => Promise.resolve(),
    pullChanges: () => Promise.resolve([]),
    getRemoteTicket: () => Promise.resolve(null),
    checkConnection: () => Promise.resolve({ connected: true }),
    getComments: (_remoteId: string): Promise<RemoteComment[]> => {
      if (opts.getCommentsThrows !== undefined) return Promise.reject(new Error(opts.getCommentsThrows));
      return Promise.resolve(comments.map(c => ({ id: c.id, text: c.text, createdAt: c.createdAt, updatedAt: c.createdAt })));
    },
    createComment: (_remoteId: string, text: string): Promise<string> => {
      const id = `rc-${seq++}`;
      comments.push({ id, text, createdAt: new Date() });
      created.push(text);
      return Promise.resolve(id);
    },
    updateComment: (_remoteId: string, commentId: string, text: string): Promise<void> => {
      updated.push([commentId, text]);
      const c = comments.find(x => x.id === commentId);
      if (c) c.text = text;
      return Promise.resolve();
    },
    deleteComment: (_remoteId: string, commentId: string): Promise<void> => {
      deleted.push(commentId);
      return Promise.resolve();
    },
  } as unknown as TicketingBackend & { comments: RC[]; created: string[]; updated: Array<[string, string]>; deleted: string[] };
  return backend;
}

async function seedTicket(notes: { id: string; text: string }[]): Promise<number> {
  const t = await createTicket('Synced ticket');
  const db = await getDb();
  const noteRows = notes.map(n => ({ id: n.id, text: n.text, created_at: new Date().toISOString() }));
  await db.query('UPDATE tickets SET notes = $1 WHERE id = $2', [JSON.stringify(noteRows), t.id]);
  return t.id;
}

beforeAll(async () => { tempDir = await setupTestDb(); });
afterAll(async () => { await cleanupTestDb(tempDir); });

describe('syncTicketComments', () => {
  it('no-ops when the backend has no getComments', async () => {
    const id = await seedTicket([]);
    const backend = makeBackend();
    delete (backend as { getComments?: unknown }).getComments;
    await expect(syncTicketComments(backend, id, 'remote-1')).resolves.toBeUndefined();
  });

  it('pulls a new remote comment into a local note + records the mapping', async () => {
    const id = await seedTicket([]);
    const backend = makeBackend([{ id: 'rc-remote', text: 'hello from remote', createdAt: new Date() }]);
    await upsertSyncRecord(id, backend.id, 'remote-pull', 'synced');
    await syncTicketComments(backend, id, 'remote-pull');

    const ticket = await getTicket(id);
    const notes = JSON.parse(ticket!.notes) as { text: string }[];
    expect(notes.some(n => n.text === 'hello from remote')).toBe(true);
    const maps = await getNoteSyncRecords(id, backend.id);
    expect(maps.some(m => m.remote_comment_id === 'rc-remote')).toBe(true);
  });

  it('pushes a new local note to the remote + records the mapping', async () => {
    const noteId = generateNoteId();
    const id = await seedTicket([{ id: noteId, text: 'local-only note' }]);
    const backend = makeBackend([]);
    await syncTicketComments(backend, id, 'remote-push');
    expect(backend.created).toContain('local-only note');
    const maps = await getNoteSyncRecords(id, backend.id);
    expect(maps.some(m => m.note_id === noteId)).toBe(true);
  });

  it('applies a remote edit to the local note (remote changed, local unchanged)', async () => {
    const noteId = generateNoteId();
    const id = await seedTicket([{ id: noteId, text: 'original' }]);
    const backend = makeBackend([{ id: 'rc-1', text: 'edited remotely', createdAt: new Date() }]);
    await upsertNoteSyncRecord(id, noteId, backend.id, 'rc-1', 'original'); // base = original
    await syncTicketComments(backend, id, 'remote-edit');
    const ticket = await getTicket(id);
    const notes = JSON.parse(ticket!.notes) as { id: string; text: string }[];
    expect(notes.find(n => n.id === noteId)?.text).toBe('edited remotely');
  });

  it('pushes a local edit to the remote (local changed, remote unchanged)', async () => {
    const noteId = generateNoteId();
    const id = await seedTicket([{ id: noteId, text: 'changed locally' }]);
    const backend = makeBackend([{ id: 'rc-2', text: 'original', createdAt: new Date() }]);
    await upsertNoteSyncRecord(id, noteId, backend.id, 'rc-2', 'original'); // base = original; local now differs
    await syncTicketComments(backend, id, 'remote-localedit');
    expect(backend.updated).toContainEqual(['rc-2', 'changed locally']);
  });

  it('deletes the remote comment + mapping when the local note was deleted', async () => {
    const noteId = generateNoteId();
    const id = await seedTicket([]); // note already gone locally
    const backend = makeBackend([{ id: 'rc-3', text: 'orphan', createdAt: new Date() }]);
    await upsertNoteSyncRecord(id, noteId, backend.id, 'rc-3', 'orphan');
    await syncTicketComments(backend, id, 'remote-del');
    expect(backend.deleted).toContain('rc-3');
    const maps = await getNoteSyncRecords(id, backend.id);
    expect(maps.some(m => m.note_id === noteId)).toBe(false);
  });

  it('dedups a remote comment whose text matches an existing unmapped local note', async () => {
    const noteId = generateNoteId();
    const id = await seedTicket([{ id: noteId, text: 'same text' }]);
    const backend = makeBackend([{ id: 'rc-dup', text: 'same text', createdAt: new Date() }]);
    await syncTicketComments(backend, id, 'remote-dup');
    const ticket = await getTicket(id);
    const notes = JSON.parse(ticket!.notes) as { text: string }[];
    expect(notes.filter(n => n.text === 'same text')).toHaveLength(1); // no duplicate
    const maps = await getNoteSyncRecords(id, backend.id);
    expect(maps.find(m => m.note_id === noteId)?.remote_comment_id).toBe('rc-dup');
  });
});

describe('syncComments (per-plugin loop)', () => {
  it('removes the sync record when getComments reports the issue is gone (404)', async () => {
    const id = await seedTicket([]);
    const backend = makeBackend([], { getCommentsThrows: 'HTTP 404 Not Found' });
    await upsertSyncRecord(id, backend.id, 'remote-404', 'synced');
    await syncComments(backend);
    expect(await getSyncRecord(id, backend.id)).toBeNull();
  });

  it('keeps the sync record on a transient (non-404) error', async () => {
    const id = await seedTicket([]);
    const backend = makeBackend([], { getCommentsThrows: 'ECONNRESET' });
    await upsertSyncRecord(id, backend.id, 'remote-transient', 'synced');
    await syncComments(backend);
    expect(await getSyncRecord(id, backend.id)).not.toBeNull();
  });
});
