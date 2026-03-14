import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Hono } from 'hono';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';

// Mock markdown sync and skills to avoid side effects in API tests
vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(),
  scheduleWorklistSync: vi.fn(),
  scheduleOpenTicketsSync: vi.fn(),
  initMarkdownSync: vi.fn(),
}));

vi.mock('../skills.js', () => ({
  ensureSkills: vi.fn(() => []),
  consumeSkillsCreatedFlag: vi.fn(() => false),
  initSkills: vi.fn(),
  SKILL_VERSION: 2,
  parseVersionHeader: vi.fn(),
  updateFile: vi.fn(),
}));

import { apiRoutes } from './api.js';

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    await next();
  });
  app.route('/api', apiRoutes);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

function post(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function patch(body: unknown) {
  return {
    method: 'PATCH' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('ticket CRUD', () => {
  let ticketId: number;

  it('POST /api/tickets creates a ticket (201)', async () => {
    const res = await app.request('/api/tickets', post({ title: 'API test' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.title).toBe('API test');
    expect(data.ticket_number).toMatch(/^HS-\d+$/);
    ticketId = data.id;
  });

  it('POST /api/tickets with defaults', async () => {
    const res = await app.request('/api/tickets', post({
      title: 'With defaults',
      defaults: { category: 'bug', priority: 'high', up_next: true },
    }));
    const data = await res.json();
    expect(data.category).toBe('bug');
    expect(data.priority).toBe('high');
    expect(data.up_next).toBe(true);
  });

  it('GET /api/tickets/:id returns ticket with attachments array', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(ticketId);
    expect(data.attachments).toBeInstanceOf(Array);
  });

  it('GET /api/tickets/:id returns 404 for missing', async () => {
    const res = await app.request('/api/tickets/99999');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/tickets/:id updates fields', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, patch({
      title: 'Updated title',
      category: 'feature',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.title).toBe('Updated title');
    expect(data.category).toBe('feature');
  });

  it('PATCH /api/tickets/:id returns 404 for missing', async () => {
    const res = await app.request('/api/tickets/99999', patch({ title: 'Nope' }));
    expect(res.status).toBe(404);
  });

  it('PATCH /api/tickets/:id appends notes', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, patch({ notes: 'A note' }));
    const data = await res.json();
    const notes = JSON.parse(data.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('A note');
  });

  it('DELETE /api/tickets/:id soft-deletes', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'To delete' }))).json();
    const res = await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const check = await (await app.request(`/api/tickets/${t.id}`)).json();
    expect(check.status).toBe('deleted');
  });

  it('DELETE /api/tickets/:id/hard permanently removes', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'To hard delete' }))).json();
    const res = await app.request(`/api/tickets/${t.id}/hard`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const check = await app.request(`/api/tickets/${t.id}`);
    expect(check.status).toBe(404);
  });
});

describe('filtering & sorting', () => {
  it('GET /api/tickets returns default filtered list', async () => {
    const res = await app.request('/api/tickets');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('filters by status=open', async () => {
    const res = await app.request('/api/tickets?status=open');
    const data = await res.json();
    for (const t of data) {
      expect(['not_started', 'started']).toContain(t.status);
    }
  });

  it('filters by up_next=true', async () => {
    const res = await app.request('/api/tickets?up_next=true');
    const data = await res.json();
    for (const t of data) {
      expect(t.up_next).toBe(true);
    }
  });

  it('search is case-insensitive', async () => {
    await app.request('/api/tickets', post({ title: 'UniqueSearchTerm123' }));
    const res = await app.request('/api/tickets?search=uniquesearchterm123');
    const data = await res.json();
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].title).toBe('UniqueSearchTerm123');
  });

  it('sorts by priority asc', async () => {
    const res = await app.request('/api/tickets?sort_by=priority&sort_dir=asc');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('empty string params are treated as not provided', async () => {
    const res = await app.request('/api/tickets?category=&status=&search=');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('batch operations', () => {
  it('batch delete', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'Batch 1' }))).json();
    const t2 = await (await app.request('/api/tickets', post({ title: 'Batch 2' }))).json();
    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id],
      action: 'delete',
    }));
    expect(res.status).toBe(200);
    const r1 = await (await app.request(`/api/tickets/${t1.id}`)).json();
    expect(r1.status).toBe('deleted');
  });

  it('batch category update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch cat' }))).json();
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'category',
      value: 'task',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json();
    expect(r.category).toBe('task');
  });

  it('batch priority update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch pri' }))).json();
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'priority',
      value: 'highest',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json();
    expect(r.priority).toBe('highest');
  });

  it('batch status update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch status' }))).json();
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'status',
      value: 'completed',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json();
    expect(r.status).toBe('completed');
    expect(r.completed_at).not.toBeNull();
  });

  it('batch up_next update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch upnext' }))).json();
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'up_next',
      value: true,
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json();
    expect(r.up_next).toBe(true);
  });

  it('batch restore', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch restore' }))).json();
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'restore',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json();
    expect(r.status).toBe('not_started');
  });
});

describe('up next toggle', () => {
  it('POST /api/tickets/:id/up-next toggles', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Up next' }))).json();
    expect(t.up_next).toBe(false);
    const r1 = await (await app.request(`/api/tickets/${t.id}/up-next`, { method: 'POST' })).json();
    expect(r1.up_next).toBe(true);
    const r2 = await (await app.request(`/api/tickets/${t.id}/up-next`, { method: 'POST' })).json();
    expect(r2.up_next).toBe(false);
  });

  it('returns 404 for missing ticket', async () => {
    const res = await app.request('/api/tickets/99999/up-next', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('restore', () => {
  it('POST /api/tickets/:id/restore restores deleted ticket', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Restore' }))).json();
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    const res = await app.request(`/api/tickets/${t.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('not_started');
  });
});

describe('trash', () => {
  it('POST /api/trash/empty hard-deletes all trashed tickets', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Trash empty' }))).json();
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    const res = await app.request('/api/trash/empty', { method: 'POST' });
    expect(res.status).toBe(200);
    const check = await app.request(`/api/tickets/${t.id}`);
    expect(check.status).toBe(404);
  });
});

describe('attachments', () => {
  it('POST /api/tickets/:id/attachments uploads a file', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Attach upload' }))).json();
    const formData = new FormData();
    formData.append('file', new File(['test content'], 'test.png', { type: 'image/png' }));
    const res = await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.original_filename).toBe('test.png');
    expect(data.stored_path).toContain(t.ticket_number);
    expect(existsSync(data.stored_path)).toBe(true);
  });

  it('POST /api/tickets/:id/attachments returns 404 for missing ticket', async () => {
    const formData = new FormData();
    formData.append('file', new File(['x'], 'x.txt', { type: 'text/plain' }));
    const res = await app.request('/api/tickets/99999/attachments', {
      method: 'POST',
      body: formData,
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/attachments/file/* serves a file with correct MIME type', async () => {
    // Write a file directly to the attachments dir
    const attachDir = join(tempDir, 'attachments');
    writeFileSync(join(attachDir, 'serve-test.txt'), 'hello world');
    const res = await app.request('/api/attachments/file/serve-test.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/plain');
    const text = await res.text();
    expect(text).toBe('hello world');
  });

  it('GET /api/attachments/file/* returns 404 for missing file', async () => {
    const res = await app.request('/api/attachments/file/nonexistent.png');
    expect(res.status).toBe(404);
  });

  it('DELETE /api/attachments/:id removes record and file', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Attach delete' }))).json();
    const formData = new FormData();
    formData.append('file', new File(['data'], 'todelete.txt', { type: 'text/plain' }));
    const uploaded = await (await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    })).json();

    const res = await app.request(`/api/attachments/${uploaded.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    // File should be removed from disk
    expect(existsSync(uploaded.stored_path)).toBe(false);
  });

  it('DELETE /api/attachments/:id returns 404 for missing', async () => {
    const res = await app.request('/api/attachments/99999', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tickets/:id/hard cleans up attachment files', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Hard del attach' }))).json();
    const formData = new FormData();
    formData.append('file', new File(['data'], 'harddel.txt', { type: 'text/plain' }));
    const uploaded = await (await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    })).json();

    const res = await app.request(`/api/tickets/${t.id}/hard`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(existsSync(uploaded.stored_path)).toBe(false);
  });

  it('POST /api/trash/empty cleans up attachment files', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Trash attach' }))).json();
    const formData = new FormData();
    formData.append('file', new File(['data'], 'trash.txt', { type: 'text/plain' }));
    const uploaded = await (await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    })).json();

    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    await app.request('/api/trash/empty', { method: 'POST' });
    expect(existsSync(uploaded.stored_path)).toBe(false);
  });
});

describe('stats', () => {
  it('GET /api/stats returns correct structure', async () => {
    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.total).toBe('number');
    expect(typeof data.open).toBe('number');
    expect(typeof data.up_next).toBe('number');
    expect(data.by_category).toBeDefined();
    expect(data.by_status).toBeDefined();
  });
});

describe('settings', () => {
  it('GET /api/settings returns settings', async () => {
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.detail_position).toBe('side');
  });

  it('PATCH /api/settings upserts', async () => {
    await app.request('/api/settings', patch({ detail_position: 'bottom' }));
    const res = await app.request('/api/settings');
    const data = await res.json();
    expect(data.detail_position).toBe('bottom');
  });

  it('GET /api/file-settings returns file settings', async () => {
    const res = await app.request('/api/file-settings');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data).toBe('object');
  });

  it('PATCH /api/file-settings merges settings', async () => {
    await app.request('/api/file-settings', patch({ appName: 'Test App' }));
    const res = await app.request('/api/file-settings');
    const data = await res.json();
    expect(data.appName).toBe('Test App');
  });
});

describe('long-poll', () => {
  it('returns immediately when client version is behind', async () => {
    // Create a ticket to ensure changeVersion > 0
    await app.request('/api/tickets', post({ title: 'Poll setup' }));
    const res = await app.request('/api/poll?version=0');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.version).toBeGreaterThan(0);
  });

  it('resolves when a change occurs', async () => {
    // Get current version
    const { version } = await (await app.request('/api/poll?version=0')).json();

    // Start poll at current version (will wait for change)
    const pollPromise = app.request(`/api/poll?version=${version}`);

    // Trigger a change
    await app.request('/api/tickets', post({ title: 'Trigger change' }));

    // Poll should resolve with new version
    const res = await pollPromise;
    const data = await res.json();
    expect(data.version).toBeGreaterThan(version);
  });
});
