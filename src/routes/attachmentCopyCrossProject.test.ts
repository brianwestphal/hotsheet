/**
 * HS-8739 — server-side cross-project attachment copy
 * (`POST /api/tickets/:id/attachments/copy-from`).
 *
 * Two project DBs (source + target) are initialized directly via `getDbForDir`
 * (à la `multiProjectIsolation.test.ts`); the route's internal
 * `getProjectBySecret` is overridden to resolve the source dataDir. The test
 * uploads a file to a source ticket, copies it into a target ticket, and
 * asserts the bytes landed in the TARGET project's attachments dir (a real
 * copy, not a pointer to the source file). Also covers the dedup-naming loop,
 * draft-attachment exclusion, and the unknown-source / malformed-body 400s.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeAllDatabases, getDbForDir, runWithDataDir } from '../db/connection.js';
import type * as ProjectsModule from '../projects.js';
import type { AppEnv } from '../types.js';
import { apiRoutes } from './api.js';

vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(), scheduleWorklistSync: vi.fn(), scheduleOpenTicketsSync: vi.fn(),
  flushPendingSyncs: vi.fn(() => Promise.resolve()), initMarkdownSync: vi.fn(), getSyncState: vi.fn(),
}));
vi.mock('../skills.js', () => ({
  ensureSkills: vi.fn(() => []), consumeSkillsCreatedFlag: vi.fn(() => false), initSkills: vi.fn(),
  ensureSkillsForDir: vi.fn(), setSkillCategories: vi.fn(),
  SKILL_VERSION: 2, parseVersionHeader: vi.fn(), updateFile: vi.fn(),
}));
vi.mock('../channel-config.js', () => ({
  isChannelAlive: vi.fn(() => Promise.resolve(false)), getChannelPort: vi.fn(() => null),
  registerChannel: vi.fn(), registerChannelForAll: vi.fn(), unregisterChannel: vi.fn(),
  unregisterChannelForAll: vi.fn(), shutdownChannel: vi.fn(() => Promise.resolve()),
  triggerChannel: vi.fn(() => Promise.resolve(true)), checkChannelVersion: vi.fn(() => Promise.resolve(null)),
}));

// A mutable secret→dataDir registry the `getProjectBySecret` override reads.
// `vi.hoisted` makes it reachable from the (hoisted) mock factory; it's filled
// in `beforeAll` once the temp dirs exist.
const reg = vi.hoisted(() => ({ secretToDir: new Map<string, string>() }));
vi.mock('../projects.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProjectsModule>();
  return {
    ...actual,
    getProjectBySecret: (secret: string) => {
      const dataDir = reg.secretToDir.get(secret);
      // The copy-from route only reads `.dataDir`; a minimal stub suffices.
      return dataDir === undefined ? undefined : ({ dataDir } as unknown as ProjectsModule.ProjectContext);
    },
  };
});

interface TicketResponse { id: number; ticket_number: string }
interface AttachmentResponse { id: number; original_filename: string; stored_path: string }
interface TicketDetail { attachments: AttachmentResponse[] }

const SOURCE_SECRET = 'hs-8739-source';
const TARGET_SECRET = 'hs-8739-target';
let app: Hono<AppEnv>;
let sourceDir = '';
let targetDir = '';

beforeAll(async () => {
  const base = tmpdir();
  sourceDir = join(base, `hs-8739-src-${String(Date.now())}`);
  targetDir = join(base, `hs-8739-tgt-${String(Date.now())}`);
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  await getDbForDir(sourceDir);
  await getDbForDir(targetDir);
  reg.secretToDir.set(SOURCE_SECRET, sourceDir);
  reg.secretToDir.set(TARGET_SECRET, targetDir);

  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const headerSecret = c.req.header('X-Hotsheet-Secret') ?? '';
    const dir = headerSecret === SOURCE_SECRET ? sourceDir : targetDir;
    c.set('dataDir', dir);
    c.set('projectSecret', headerSecret);
    await runWithDataDir(dir, () => next());
  });
  app.route('/api', apiRoutes);
}, 60_000);

afterAll(async () => {
  await closeAllDatabases();
  for (const d of [sourceDir, targetDir]) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}, 60_000);

async function createTicket(secret: string, title: string): Promise<TicketResponse> {
  const res = await app.request('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return await res.json() as TicketResponse;
}

async function uploadFile(secret: string, ticketId: number, name: string, content: string): Promise<void> {
  const form = new FormData();
  form.append('file', new File([content], name, { type: 'text/plain' }));
  const res = await app.request(`/api/tickets/${String(ticketId)}/attachments`, {
    method: 'POST', headers: { 'X-Hotsheet-Secret': secret }, body: form,
  });
  expect(res.status).toBe(201);
}

async function copyFrom(targetTicketId: number, body: unknown): Promise<Response> {
  return app.request(`/api/tickets/${String(targetTicketId)}/attachments/copy-from`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': TARGET_SECRET },
    body: JSON.stringify(body),
  });
}

async function attachmentsOf(secret: string, ticketId: number): Promise<AttachmentResponse[]> {
  const res = await app.request(`/api/tickets/${String(ticketId)}`, { headers: { 'X-Hotsheet-Secret': secret } });
  expect(res.status).toBe(200);
  return (await res.json() as TicketDetail).attachments;
}

describe('cross-project attachment copy (HS-8739)', () => {
  it('copies a source ticket\'s attachment file + row into the target project', async () => {
    const srcTicket = await createTicket(SOURCE_SECRET, 'Source with file');
    await uploadFile(SOURCE_SECRET, srcTicket.id, 'doc.txt', 'hello bytes');
    const tgtTicket = await createTicket(TARGET_SECRET, 'Target');

    const res = await copyFrom(tgtTicket.id, { sourceSecret: SOURCE_SECRET, sourceTicketId: srcTicket.id });
    expect(res.status).toBe(200);
    expect((await res.json() as { copied: number }).copied).toBe(1);

    // Target now lists the attachment, stored under the TARGET dir (a real
    // copy, not a pointer to the source file), with content preserved.
    const tgt = await attachmentsOf(TARGET_SECRET, tgtTicket.id);
    expect(tgt).toHaveLength(1);
    expect(tgt[0].original_filename).toBe('doc.txt');
    expect(tgt[0].stored_path.startsWith(targetDir)).toBe(true);
    expect(existsSync(tgt[0].stored_path)).toBe(true);
    expect(readFileSync(tgt[0].stored_path, 'utf8')).toBe('hello bytes');

    // Source untouched.
    expect(await attachmentsOf(SOURCE_SECRET, srcTicket.id)).toHaveLength(1);
  });

  it('does not clobber an existing target file — a second copy is suffixed', async () => {
    const srcTicket = await createTicket(SOURCE_SECRET, 'Src dup');
    await uploadFile(SOURCE_SECRET, srcTicket.id, 'same.txt', 'A');
    const tgtTicket = await createTicket(TARGET_SECRET, 'Tgt dup');

    await copyFrom(tgtTicket.id, { sourceSecret: SOURCE_SECRET, sourceTicketId: srcTicket.id });
    await copyFrom(tgtTicket.id, { sourceSecret: SOURCE_SECRET, sourceTicketId: srcTicket.id });

    const tgt = await attachmentsOf(TARGET_SECRET, tgtTicket.id);
    expect(tgt).toHaveLength(2);
    expect(new Set(tgt.map(a => a.stored_path)).size).toBe(2); // distinct files, no overwrite
  });

  it('ignores draft attachments — only promoted ones are carried', async () => {
    const srcTicket = await createTicket(SOURCE_SECRET, 'Src draft');
    await uploadFile(SOURCE_SECRET, srcTicket.id, 'real.txt', 'real');
    const { addDraftAttachment } = await import('../db/queries.js');
    await runWithDataDir(sourceDir, () => addDraftAttachment(srcTicket.id, 'fd_x', 'draft.txt', join(sourceDir, 'attachments', 'nope.txt')));
    const tgtTicket = await createTicket(TARGET_SECRET, 'Tgt draft');

    const res = await copyFrom(tgtTicket.id, { sourceSecret: SOURCE_SECRET, sourceTicketId: srcTicket.id });
    expect((await res.json() as { copied: number }).copied).toBe(1);
    expect((await attachmentsOf(TARGET_SECRET, tgtTicket.id)).map(a => a.original_filename)).toEqual(['real.txt']);
  });

  it('returns 400 for an unknown source project', async () => {
    const tgtTicket = await createTicket(TARGET_SECRET, 'Tgt 400');
    const res = await copyFrom(tgtTicket.id, { sourceSecret: 'not-a-real-secret', sourceTicketId: 1 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a malformed body', async () => {
    const tgtTicket = await createTicket(TARGET_SECRET, 'Tgt bad body');
    const res = await copyFrom(tgtTicket.id, { sourceSecret: '' });
    expect(res.status).toBe(400);
  });
});
