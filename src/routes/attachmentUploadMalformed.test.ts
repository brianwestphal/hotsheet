/**
 * HS-9227 — a malformed / truncated multipart upload body must NOT crash the
 * attachment-upload route with a bare 500.
 *
 * `c.req.parseBody()` delegates to undici's `parseFormData`, which throws
 * `TypeError: Failed to parse body as FormData` when the body doesn't match its
 * `multipart/form-data` Content-Type (a dropped connection mid-upload, a
 * corrupted boundary, or a client that lies about the content type). The route
 * now wraps the parse in `tryParseBody` and answers with a clean 400 instead of
 * letting the TypeError bubble up as a 500.
 */
import { rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { closeAllDatabases, getDbForDir, runWithDataDir } from '../db/connection.js';
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

interface TicketResponse { id: number; ticket_number: string }

let app: Hono<AppEnv>;
let dataDir = '';

beforeAll(async () => {
  dataDir = join(tmpdir(), `hs-9227-${String(Date.now())}`);
  await getDbForDir(dataDir);

  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', dataDir);
    c.set('projectSecret', 'test');
    await runWithDataDir(dataDir, () => next());
  });
  app.route('/api', apiRoutes);
}, 60_000);

afterAll(async () => {
  await closeAllDatabases();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

async function createTicket(title: string): Promise<TicketResponse> {
  const res = await app.request('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  expect(res.status).toBe(201);
  return await res.json() as TicketResponse;
}

describe('attachment upload — malformed body (HS-9227)', () => {
  it('answers 400 (not 500) when the body is not parseable as the declared multipart', async () => {
    const ticket = await createTicket('malformed upload');
    // A Content-Type claiming a multipart boundary the body never produces →
    // undici's parseFormData throws "Failed to parse body as FormData".
    const res = await app.request(`/api/tickets/${String(ticket.id)}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=----hs9227boundary' },
      body: 'this is not a valid multipart payload',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('Malformed upload body');
  });

  it('answers 400 when the multipart body carries no `file` field', async () => {
    const ticket = await createTicket('no file field');
    const form = new FormData();
    form.append('notthefile', 'just text');
    const res = await app.request(`/api/tickets/${String(ticket.id)}/attachments`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('No file uploaded');
  });

  it('still accepts a well-formed upload', async () => {
    const ticket = await createTicket('good upload');
    const form = new FormData();
    form.append('file', new File(['hello'], 'note.txt', { type: 'text/plain' }));
    const res = await app.request(`/api/tickets/${String(ticket.id)}/attachments`, {
      method: 'POST',
      body: form,
    });
    expect(res.status).toBe(201);
  });

  it('answers 400 (not 500) for a malformed feedback-draft upload', async () => {
    const ticket = await createTicket('malformed draft upload');
    const res = await app.request(`/api/tickets/${String(ticket.id)}/feedback-drafts/fd_x/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=----hs9227boundary' },
      body: 'not a real multipart body',
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('Malformed upload body');
  });
});
