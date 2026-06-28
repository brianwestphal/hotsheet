/**
 * HS-9132 — integration coverage for the attachment-sync slice
 * (`syncEngine/attachments.ts`), previously ~0% (the `syncEngine.test.ts` mock
 * backend has no `uploadAttachment`). Runs against a real PGLite test DB with a
 * real on-disk attachment file + an upload/comment-capable mock backend.
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../../db/connection.js';
import { getNoteSyncRecords, upsertSyncRecord } from '../../db/sync.js';
import { createTicket } from '../../db/tickets.js';
import { cleanupTestDb, setupTestDb } from '../../test-helpers.js';
import type { TicketingBackend } from '../types.js';
import { syncAttachments, syncTicketAttachments } from './attachments.js';

let tempDir: string;
let fileDir: string;
let pluginSeq = 0;

function makeBackend(opts: { uploadReturns?: string | null; noUpload?: boolean } = {}): TicketingBackend & { uploads: Array<{ filename: string; mime: string }>; comments: string[] } {
  const uploads: Array<{ filename: string; mime: string }> = [];
  const comments: string[] = [];
  const backend = {
    id: `att-plugin-${pluginSeq++}`,
    name: 'Attachment Backend',
    uploads, comments,
    capabilities: { create: true, update: true, delete: true, incrementalPull: true, syncableFields: [] },
    fieldMappings: { category: { toRemote: {}, toLocal: {} }, priority: { toRemote: {}, toLocal: {} }, status: { toRemote: {}, toLocal: {} } },
    createRemote: () => Promise.resolve('r'),
    updateRemote: () => Promise.resolve({}),
    deleteRemote: () => Promise.resolve(),
    pullChanges: () => Promise.resolve([]),
    getRemoteTicket: () => Promise.resolve(null),
    checkConnection: () => Promise.resolve({ connected: true }),
    createComment: (_remoteId: string, text: string): Promise<string> => { comments.push(text); return Promise.resolve(`rc-${comments.length}`); },
    uploadAttachment: (filename: string, _content: Buffer, mime: string): Promise<string | null> => {
      uploads.push({ filename, mime });
      return Promise.resolve(opts.uploadReturns === undefined ? `https://cdn/${filename}` : opts.uploadReturns);
    },
  } as unknown as TicketingBackend & { uploads: Array<{ filename: string; mime: string }>; comments: string[] };
  if (opts.noUpload === true) delete (backend as { uploadAttachment?: unknown }).uploadAttachment;
  return backend;
}

async function seedTicketWithAttachment(filename: string): Promise<{ ticketId: number; attId: number }> {
  const t = await createTicket('Att ticket');
  const path = join(fileDir, `${Date.now()}-${filename}`);
  writeFileSync(path, 'file bytes');
  const db = await getDb();
  const res = await db.query<{ id: number }>(
    'INSERT INTO attachments (ticket_id, original_filename, stored_path) VALUES ($1, $2, $3) RETURNING id',
    [t.id, filename, path],
  );
  return { ticketId: t.id, attId: res.rows[0].id };
}

beforeAll(async () => { tempDir = await setupTestDb(); fileDir = mkdtempSync(join(tmpdir(), 'hs-att-')); });
afterAll(async () => { await cleanupTestDb(tempDir); });

describe('syncTicketAttachments', () => {
  it('uploads an image attachment + posts image-markdown + records att_<id> (idempotent on rerun)', async () => {
    const { ticketId, attId } = await seedTicketWithAttachment('shot.png');
    const backend = makeBackend();
    await syncTicketAttachments(backend, ticketId, 'remote-img');
    expect(backend.uploads).toEqual([{ filename: 'shot.png', mime: 'image/png' }]);
    expect(backend.comments).toEqual(['![shot.png](https://cdn/shot.png)']);
    const maps = await getNoteSyncRecords(ticketId, backend.id);
    expect(maps.some(m => m.note_id === `att_${attId}`)).toBe(true);

    // Rerun: already-synced → no second upload/comment.
    await syncTicketAttachments(backend, ticketId, 'remote-img');
    expect(backend.uploads).toHaveLength(1);
    expect(backend.comments).toHaveLength(1);
  });

  it('uses file-markdown for a non-image attachment', async () => {
    const { ticketId } = await seedTicketWithAttachment('notes.txt');
    const backend = makeBackend();
    await syncTicketAttachments(backend, ticketId, 'remote-file');
    expect(backend.comments).toEqual(['[notes.txt](https://cdn/notes.txt)']);
  });

  it('records nothing when the upload returns null', async () => {
    const { ticketId, attId } = await seedTicketWithAttachment('skip.png');
    const backend = makeBackend({ uploadReturns: null });
    await syncTicketAttachments(backend, ticketId, 'remote-null');
    expect(backend.comments).toHaveLength(0);
    const maps = await getNoteSyncRecords(ticketId, backend.id);
    expect(maps.some(m => m.note_id === `att_${attId}`)).toBe(false);
  });

  it('no-ops a ticket with no attachments', async () => {
    const t = await createTicket('No atts');
    const backend = makeBackend();
    await syncTicketAttachments(backend, t.id, 'remote-empty');
    expect(backend.uploads).toHaveLength(0);
  });

  it('no-ops when the backend cannot upload attachments', async () => {
    const { ticketId } = await seedTicketWithAttachment('x.png');
    const backend = makeBackend({ noUpload: true });
    await syncTicketAttachments(backend, ticketId, 'remote-noup');
    expect(backend.comments).toHaveLength(0);
  });
});

describe('syncAttachments (per-plugin loop)', () => {
  it('processes every synced record for the plugin', async () => {
    const { ticketId } = await seedTicketWithAttachment('loop.png');
    const backend = makeBackend();
    await upsertSyncRecord(ticketId, backend.id, 'remote-loop', 'synced');
    await syncAttachments(backend);
    expect(backend.uploads).toEqual([{ filename: 'loop.png', mime: 'image/png' }]);
  });

  it('no-ops entirely when the backend cannot upload', async () => {
    const backend = makeBackend({ noUpload: true });
    await expect(syncAttachments(backend)).resolves.toBeUndefined();
    expect(backend.uploads).toHaveLength(0);
  });
});
