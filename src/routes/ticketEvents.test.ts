// HS-8980 — asserts every wired mutation route emits the right WebSocket-push
// event (docs/93 §93.4) alongside its existing notifyMutation bump. Drives the
// real route handlers against a temp DB and watches the event bus.

import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SyncEvent } from '../schemas.js';
import { eventBus } from '../sync/eventBus.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { apiRoutes } from './api.js';

const SECRET = 'test-secret';
let tempDir: string;
let app: Hono<AppEnv>;
let events: SyncEvent[];
let off: () => void;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    c.set('projectSecret', SECRET);
    await next();
  });
  app.route('/api', apiRoutes);
});

afterAll(async () => { await cleanupTestDb(tempDir); });

beforeEach(() => { events = []; off = eventBus.registerSink(SECRET, (e) => events.push(e)); });
afterEach(() => { off(); });

const typed = (type: string) => events.filter((e) => e.type === type);

async function createTicket(title = 'T'): Promise<{ id: number }> {
  const res = await app.request('/api/tickets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  return res.json() as Promise<{ id: number }>;
}

describe('ticket mutation events', () => {
  it('POST /tickets → ticket-created (carrying the row + a seq)', async () => {
    const t = await createTicket('created-evt');
    const created = typed('ticket-created');
    expect(created).toHaveLength(1);
    expect((created[0] as { ticket: { id: number } }).ticket.id).toBe(t.id);
    expect(typeof created[0].seq).toBe('number');
  });

  it('PATCH /tickets/:id → ticket-updated with the changed fields', async () => {
    const t = await createTicket();
    events = [];
    await app.request(`/api/tickets/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'renamed', priority: 'high' }),
    });
    const upd = typed('ticket-updated');
    expect(upd).toHaveLength(1);
    expect(upd[0]).toMatchObject({ id: t.id, changes: { title: 'renamed', priority: 'high' } });
  });

  it('HS-9043 — PATCH status=completed echoes the server-cleared up_next + completed_at', async () => {
    const t = await createTicket();
    // First flag it up-next.
    await app.request(`/api/tickets/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ up_next: true }),
    });
    events = [];
    // Completing it clears up_next + sets completed_at SERVER-SIDE; the event must
    // carry those derived fields so the UI matches the DB (not just `status`).
    await app.request(`/api/tickets/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }),
    });
    const upd = typed('ticket-updated');
    expect(upd).toHaveLength(1);
    const changes = (upd[0] as { changes: Record<string, unknown> }).changes;
    expect(changes).toMatchObject({ status: 'completed', up_next: false });
    expect(changes.completed_at).not.toBeNull();
  });

  it('PATCH /tickets/:id with only last_read_at emits nothing (read-tracking)', async () => {
    const t = await createTicket();
    events = [];
    await app.request(`/api/tickets/${t.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_read_at: new Date().toISOString() }),
    });
    expect(events).toHaveLength(0);
  });

  it('DELETE /tickets/:id → ticket-deleted', async () => {
    const t = await createTicket();
    events = [];
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    expect(typed('ticket-deleted')).toEqual([expect.objectContaining({ id: t.id })]);
  });

  it('POST /tickets/:id/up-next → ticket-updated {up_next}', async () => {
    const t = await createTicket();
    events = [];
    await app.request(`/api/tickets/${t.id}/up-next`, { method: 'POST' });
    const upd = typed('ticket-updated');
    expect(upd).toHaveLength(1);
    expect((upd[0] as { changes: { up_next?: boolean } }).changes.up_next).toBe(true);
  });
});

describe('batch events', () => {
  it('a uniform category flip → one category-changed with ticketIds', async () => {
    const a = await createTicket('a');
    const b = await createTicket('b');
    events = [];
    await app.request('/api/tickets/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [a.id, b.id], action: 'category', value: 'bug' }),
    });
    const ev = typed('category-changed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ ticketIds: [a.id, b.id], to: 'bug' });
  });

  it('a batch delete → one batch-operation', async () => {
    const a = await createTicket('a');
    events = [];
    await app.request('/api/tickets/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], action: 'delete' }),
    });
    expect(typed('batch-operation')).toEqual([expect.objectContaining({ op: 'delete', ids: [a.id] })]);
  });

  it('a read-tracking batch (mark_read) emits nothing', async () => {
    const a = await createTicket('a');
    events = [];
    await app.request('/api/tickets/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [a.id], action: 'mark_read' }),
    });
    expect(events).toHaveLength(0);
  });
});

describe('attachment events', () => {
  it('upload → attachment-added; delete → attachment-deleted', async () => {
    const t = await createTicket('att');
    events = [];
    const form = new FormData();
    form.append('file', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    const up = await app.request(`/api/tickets/${t.id}/attachments`, { method: 'POST', body: form });
    const att = await up.json() as { id: number };
    const added = typed('attachment-added');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ ticketId: t.id });

    events = [];
    await app.request(`/api/attachments/${att.id}`, { method: 'DELETE' });
    expect(typed('attachment-deleted')).toEqual([expect.objectContaining({ ticketId: t.id, attachmentId: att.id })]);
  });
});

describe('claim events (HS-8973)', () => {
  it('POST /tickets/:id/release → claims-changed', async () => {
    const t = await createTicket('claim');
    events = [];
    await app.request(`/api/tickets/${t.id}/release`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ worker: 'w1' }),
    });
    expect(typed('claims-changed')).toHaveLength(1);
  });
});

describe('settings events', () => {
  it('PATCH /settings → settings-changed per key', async () => {
    events = [];
    await app.request('/api/settings', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detail_position: 'right' }),
    });
    expect(typed('settings-changed')).toEqual([expect.objectContaining({ key: 'detail_position', value: 'right' })]);
  });

  it('PUT /categories → settings-changed {key:categories}', async () => {
    events = [];
    await app.request('/api/categories', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#f00', shortcutKey: 'b', description: '' }]),
    });
    expect(typed('settings-changed').some((e) => (e as { key: string }).key === 'categories')).toBe(true);
  });
});
