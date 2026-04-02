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

vi.mock('../channel-config.js', () => ({
  isChannelAlive: vi.fn(() => Promise.resolve(false)),
  getChannelPort: vi.fn(() => null),
  registerChannel: vi.fn(),
  unregisterChannel: vi.fn(),
  triggerChannel: vi.fn(() => Promise.resolve(true)),
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

describe('path traversal protection', () => {
  it('does not serve files outside the attachments directory via ../ traversal', async () => {
    // Place a sensitive file one level above the attachments dir (in the data dir)
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    writeFileSync(join(tempDir, 'secret-data.txt'), 'top secret');

    // Attempt to traverse up from the attachments directory to reach it
    // Hono normalizes path separators, so ../secret-data.txt collapses before the handler.
    // The handler's resolve() + startsWith() check provides defense in depth.
    const res = await app.request('/api/attachments/file/../secret-data.txt');
    // Must not return the secret file content — either 403 (traversal caught) or 404 (path normalization)
    expect([403, 404]).toContain(res.status);
    if (res.status === 200) {
      const text = await res.text();
      expect(text).not.toBe('top secret');
    }
  });

  it('rejects traversal attempts that resolve outside attachments dir (direct resolve check)', async () => {
    // Test the protection logic directly: the handler uses resolve() and checks startsWith().
    // When Hono normalizes URLs, the path after '/api/attachments/file/' may be empty or
    // point to a non-existent file. Verify no file from outside attachments is served.
    const attempts = [
      '/api/attachments/file/../../../etc/passwd',
      '/api/attachments/file/../../etc/passwd',
      '/api/attachments/file/../secret-data.txt',
    ];
    for (const path of attempts) {
      const res = await app.request(path);
      // Must never return 200 with content from outside the attachments dir
      expect([403, 404]).toContain(res.status);
    }
  });

  it('allows normal file paths within the attachments dir', async () => {
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    const attachDir = join(tempDir, 'attachments');
    writeFileSync(join(attachDir, 'traversal-test.txt'), 'safe content');

    const res = await app.request('/api/attachments/file/traversal-test.txt');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('safe content');
  });
});

describe('file-settings secret stripping', () => {
  it('GET /api/file-settings does NOT return secret or secretPathHash', async () => {
    // Write a settings.json with secret fields
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({
        appName: 'Secret Test',
        secret: 'super-secret-value',
        secretPathHash: 'hash-value-here',
        port: 4174,
      }),
    );

    const res = await app.request('/api/file-settings');
    expect(res.status).toBe(200);
    const data = await res.json();

    // Should include safe fields
    expect(data.appName).toBe('Secret Test');
    // Must NOT include secret or secretPathHash
    expect(data).not.toHaveProperty('secret');
    expect(data).not.toHaveProperty('secretPathHash');
    // port is also stripped by the destructuring in the route
    expect(data).not.toHaveProperty('port');
  });
});

describe('dashboard stats endpoint', () => {
  it('GET /api/dashboard?days=7 returns expected structure', async () => {
    const res = await app.request('/api/dashboard?days=7');
    expect(res.status).toBe(200);
    const data = await res.json();

    // Top-level keys
    expect(data).toHaveProperty('throughput');
    expect(data).toHaveProperty('cycleTime');
    expect(data).toHaveProperty('categoryBreakdown');
    expect(data).toHaveProperty('categoryPeriod');
    expect(data).toHaveProperty('kpi');
    expect(data).toHaveProperty('snapshots');

    // throughput is an array of { date, completed, created }
    expect(Array.isArray(data.throughput)).toBe(true);
    if (data.throughput.length > 0) {
      expect(data.throughput[0]).toHaveProperty('date');
      expect(data.throughput[0]).toHaveProperty('completed');
      expect(data.throughput[0]).toHaveProperty('created');
    }

    // kpi has the expected fields
    expect(typeof data.kpi.completedThisWeek).toBe('number');
    expect(typeof data.kpi.completedLastWeek).toBe('number');
    expect(typeof data.kpi.wipCount).toBe('number');
    expect(typeof data.kpi.createdThisWeek).toBe('number');
    // medianCycleTimeDays is number or null
    expect([null, 'number']).toContain(
      data.kpi.medianCycleTimeDays === null ? null : typeof data.kpi.medianCycleTimeDays,
    );

    // snapshots is an array
    expect(Array.isArray(data.snapshots)).toBe(true);
  });

  it('GET /api/dashboard defaults to 30 days when no param', async () => {
    const res = await app.request('/api/dashboard');
    expect(res.status).toBe(200);
    const data = await res.json();
    // Should still return valid structure
    expect(data).toHaveProperty('kpi');
    expect(data).toHaveProperty('throughput');
  });
});

describe('batch operations — extended', () => {
  it('batch delete marks multiple tickets as deleted', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'BatchDel A' }))).json();
    const t2 = await (await app.request('/api/tickets', post({ title: 'BatchDel B' }))).json();
    const t3 = await (await app.request('/api/tickets', post({ title: 'BatchDel C' }))).json();

    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id, t3.id],
      action: 'delete',
    }));
    expect(res.status).toBe(200);

    // All three should be deleted
    for (const id of [t1.id, t2.id, t3.id]) {
      const check = await (await app.request(`/api/tickets/${id}`)).json();
      expect(check.status).toBe('deleted');
    }
  });

  it('batch status change to started sets status on multiple tickets', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'BatchStatus A' }))).json();
    const t2 = await (await app.request('/api/tickets', post({ title: 'BatchStatus B' }))).json();

    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id],
      action: 'status',
      value: 'started',
    }));
    expect(res.status).toBe(200);

    for (const id of [t1.id, t2.id]) {
      const check = await (await app.request(`/api/tickets/${id}`)).json();
      expect(check.status).toBe('started');
    }
  });

  it('batch restore recovers multiple deleted tickets', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'BatchRestore A' }))).json();
    const t2 = await (await app.request('/api/tickets', post({ title: 'BatchRestore B' }))).json();

    // Soft-delete them
    await app.request(`/api/tickets/${t1.id}`, { method: 'DELETE' });
    await app.request(`/api/tickets/${t2.id}`, { method: 'DELETE' });

    // Confirm deleted
    expect((await (await app.request(`/api/tickets/${t1.id}`)).json()).status).toBe('deleted');
    expect((await (await app.request(`/api/tickets/${t2.id}`)).json()).status).toBe('deleted');

    // Batch restore
    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id],
      action: 'restore',
    }));
    expect(res.status).toBe(200);

    // Both should be restored to not_started
    for (const id of [t1.id, t2.id]) {
      const check = await (await app.request(`/api/tickets/${id}`)).json();
      expect(check.status).toBe('not_started');
    }
  });
});

describe('CSRF origin validation', () => {
  // The CSRF middleware lives in server.ts's startServer, not in apiRoutes directly.
  // We create a separate app instance with that middleware to test it.
  let csrfApp: Hono<AppEnv>;

  beforeAll(async () => {
    const { writeFileSync } = await import('fs');
    const { join } = await import('path');

    // Write settings.json with a secret to activate the CSRF middleware
    writeFileSync(
      join(tempDir, 'settings.json'),
      JSON.stringify({ secret: 'test-secret-csrf', secretPathHash: 'abc', port: 4174 }),
    );

    // Build an app that replicates the middleware from server.ts
    csrfApp = new Hono<AppEnv>();
    csrfApp.use('*', async (c, next) => {
      c.set('dataDir', tempDir);
      await next();
    });

    // Replicate the CSRF/secret middleware from server.ts
    csrfApp.use('/api/*', async (c, next) => {
      const { readFileSettings } = await import('../file-settings.js');
      const dataDir = c.get('dataDir');
      const settings = readFileSettings(dataDir);
      const expectedSecret = settings.secret;
      if (!expectedSecret) { await next(); return; }

      const headerSecret = c.req.header('X-Hotsheet-Secret');
      const method = c.req.method;
      const isMutation = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';

      if (headerSecret) {
        if (headerSecret !== expectedSecret) {
          return c.json({ error: 'Secret mismatch' }, 403);
        }
      } else if (isMutation) {
        const origin = c.req.header('Origin');
        const referer = c.req.header('Referer');
        const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
        const isSameOrigin = (origin && localhostPattern.test(origin))
          || (referer && localhostPattern.test(referer));
        if (!isSameOrigin) {
          return c.json({ error: 'Missing X-Hotsheet-Secret header.' }, 403);
        }
      }
      await next();
    });

    csrfApp.route('/api', apiRoutes);
  });

  it('rejects POST with non-localhost Origin header (403)', async () => {
    const res = await csrfApp.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil-site.com',
      },
      body: JSON.stringify({ title: 'CSRF attempt' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects POST with no Origin and no secret header (403)', async () => {
    const res = await csrfApp.request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'No origin' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows POST with localhost Origin header', async () => {
    const res = await csrfApp.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://localhost:4174',
      },
      body: JSON.stringify({ title: 'Localhost OK' }),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.title).toBe('Localhost OK');
  });

  it('allows POST with 127.0.0.1 Origin header', async () => {
    const res = await csrfApp.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'http://127.0.0.1:4174',
      },
      body: JSON.stringify({ title: '127 OK' }),
    });
    expect(res.status).toBe(201);
  });

  it('allows POST with correct X-Hotsheet-Secret header', async () => {
    const res = await csrfApp.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hotsheet-Secret': 'test-secret-csrf',
      },
      body: JSON.stringify({ title: 'Secret header OK' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects POST with wrong X-Hotsheet-Secret header (403)', async () => {
    const res = await csrfApp.request('/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hotsheet-Secret': 'wrong-secret',
      },
      body: JSON.stringify({ title: 'Wrong secret' }),
    });
    expect(res.status).toBe(403);
  });

  it('allows GET requests without Origin or secret', async () => {
    const res = await csrfApp.request('/api/tickets');
    expect(res.status).toBe(200);
  });
});

describe('tags', () => {
  it('GET /api/tags returns an array of strings', async () => {
    // Create a ticket with tags to ensure at least one tag exists
    await app.request('/api/tickets', post({
      title: 'Tagged ticket',
      defaults: { tags: JSON.stringify(['backend', 'urgent']) },
    }));
    const res = await app.request('/api/tags');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    // Every item should be a string
    for (const tag of data) {
      expect(typeof tag).toBe('string');
    }
  });

  it('GET /api/tags returns empty array when no tags exist', async () => {
    // Even if other tickets exist, the endpoint should return an array
    const res = await app.request('/api/tags');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('notes CRUD', () => {
  let ticketId: number;

  it('PATCH /api/tickets/:id adds notes via update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Notes test' }))).json();
    ticketId = t.id;

    // Add a first note
    const res = await app.request(`/api/tickets/${ticketId}`, patch({ notes: 'First note' }));
    expect(res.status).toBe(200);
    const data = await res.json();
    const notes = JSON.parse(data.notes);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('First note');
    expect(notes[0].id).toBeDefined();
  });

  it('PATCH /api/tickets/:id appends additional notes', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, patch({ notes: 'Second note' }));
    const data = await res.json();
    const notes = JSON.parse(data.notes);
    expect(notes).toHaveLength(2);
    expect(notes[1].text).toBe('Second note');
  });

  it('PATCH /api/tickets/:id/notes/:noteId edits a note', async () => {
    // Get current notes to find the note ID
    const ticket = await (await app.request(`/api/tickets/${ticketId}`)).json();
    const notes = JSON.parse(ticket.notes);
    const noteId = notes[0].id;

    const res = await app.request(`/api/tickets/${ticketId}/notes/${noteId}`, patch({ text: 'Edited note' }));
    expect(res.status).toBe(200);
    const updatedNotes = await res.json();
    expect(updatedNotes[0].text).toBe('Edited note');
  });

  it('PATCH /api/tickets/:id/notes/:noteId returns 404 for missing ticket', async () => {
    const res = await app.request('/api/tickets/99999/notes/fake-id', patch({ text: 'Nope' }));
    expect(res.status).toBe(404);
  });

  it('PATCH /api/tickets/:id/notes/:noteId returns 404 for missing note ID', async () => {
    const res = await app.request(`/api/tickets/${ticketId}/notes/nonexistent-id`, patch({ text: 'Nope' }));
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tickets/:id/notes/:noteId removes a note', async () => {
    // Get current notes
    const ticket = await (await app.request(`/api/tickets/${ticketId}`)).json();
    const notes = JSON.parse(ticket.notes);
    const noteId = notes[0].id;
    const originalLength = notes.length;

    const res = await app.request(`/api/tickets/${ticketId}/notes/${noteId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const updatedNotes = await res.json();
    expect(updatedNotes).toHaveLength(originalLength - 1);
  });

  it('DELETE /api/tickets/:id/notes/:noteId returns 404 for missing ticket', async () => {
    const res = await app.request('/api/tickets/99999/notes/fake-id', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/tickets/:id/notes/:noteId returns 404 for missing note', async () => {
    const res = await app.request(`/api/tickets/${ticketId}/notes/nonexistent-id`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('PUT /api/tickets/:id/notes-bulk replaces all notes', async () => {
    const newNotes = JSON.stringify([
      { id: 'bulk-1', text: 'Bulk note A', created_at: new Date().toISOString() },
      { id: 'bulk-2', text: 'Bulk note B', created_at: new Date().toISOString() },
    ]);
    const res = await app.request(`/api/tickets/${ticketId}/notes-bulk`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: newNotes }),
    });
    expect(res.status).toBe(200);

    // Verify the notes were replaced
    const ticket = await (await app.request(`/api/tickets/${ticketId}`)).json();
    const notes = JSON.parse(ticket.notes);
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toBe('Bulk note A');
    expect(notes[1].text).toBe('Bulk note B');
  });

  it('PUT /api/tickets/:id/notes-bulk returns 404 for missing ticket', async () => {
    const res = await app.request('/api/tickets/99999/notes-bulk', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: '[]' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('worklist info', () => {
  it('GET /api/worklist-info returns prompt and skillCreated flag', async () => {
    const res = await app.request('/api/worklist-info');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.prompt).toBe('string');
    expect(data.prompt).toContain('worklist.md');
    expect(typeof data.skillCreated).toBe('boolean');
  });
});

describe('channel endpoints', () => {
  it('POST /api/channel/done sets the done flag', async () => {
    const res = await app.request('/api/channel/done', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
  });

  it('GET /api/channel/status returns status fields', async () => {
    const res = await app.request('/api/channel/status');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.enabled).toBe('boolean');
    expect(typeof data.alive).toBe('boolean');
    expect(typeof data.done).toBe('boolean');
    // port can be number or null
    expect(data.port === null || typeof data.port === 'number').toBe(true);
  });

  it('GET /api/channel/status consumes the done flag', async () => {
    // Set done flag
    await app.request('/api/channel/done', { method: 'POST' });

    // First read should show done=true
    const res1 = await app.request('/api/channel/status');
    const data1 = await res1.json();
    expect(data1.done).toBe(true);

    // Second read should show done=false (consumed)
    const res2 = await app.request('/api/channel/status');
    const data2 = await res2.json();
    expect(data2.done).toBe(false);
  });

  it('POST /api/channel/enable enables the channel', async () => {
    const res = await app.request('/api/channel/enable', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify the setting was persisted
    const settings = await (await app.request('/api/settings')).json();
    expect(settings.channel_enabled).toBe('true');
  });

  it('POST /api/channel/disable disables the channel', async () => {
    const res = await app.request('/api/channel/disable', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);

    // Verify the setting was persisted
    const settings = await (await app.request('/api/settings')).json();
    expect(settings.channel_enabled).toBe('false');
  });
});

describe('print endpoint', () => {
  it('POST /api/print writes HTML and returns ok', async () => {
    const res = await app.request('/api/print', post({
      html: '<html><body><h1>Print Test</h1></body></html>',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(typeof data.path).toBe('string');
    expect(data.path).toContain('hotsheet-print');
  });
});

describe('categories', () => {
  it('GET /api/categories returns categories array', async () => {
    const res = await app.request('/api/categories');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('PUT /api/categories saves custom categories', async () => {
    const customCategories = [
      { key: 'bug', label: 'Bug', color: '#ff0000' },
      { key: 'feature', label: 'Feature', color: '#00ff00' },
      { key: 'task', label: 'Task', color: '#0000ff' },
    ];
    const res = await app.request('/api/categories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customCategories),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(3);

    // Verify persistence
    const check = await (await app.request('/api/categories')).json();
    expect(check).toHaveLength(3);
    expect(check[0].key).toBe('bug');
  });

  it('GET /api/category-presets returns presets', async () => {
    const res = await app.request('/api/category-presets');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data).toBe('object');
    // Should have at least one preset
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });
});

describe('duplicate tickets', () => {
  it('POST /api/tickets/duplicate creates copies (201)', async () => {
    const t1 = await (await app.request('/api/tickets', post({
      title: 'Dup source',
      defaults: { category: 'bug', priority: 'high' },
    }))).json();

    const res = await app.request('/api/tickets/duplicate', post({ ids: [t1.id] }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(Array.isArray(created)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Dup source - Copy');
    expect(created[0].category).toBe('bug');
    expect(created[0].id).not.toBe(t1.id);
  });

  it('POST /api/tickets/duplicate handles multiple IDs', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'Dup A' }))).json();
    const t2 = await (await app.request('/api/tickets', post({ title: 'Dup B' }))).json();

    const res = await app.request('/api/tickets/duplicate', post({ ids: [t1.id, t2.id] }));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created).toHaveLength(2);
  });
});

describe('bracket tag extraction', () => {
  it('POST /api/tickets with [tag] syntax extracts tags', async () => {
    const res = await app.request('/api/tickets', post({ title: 'Fix login [auth] [urgent]' }));
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.title).toBe('Fix login');
    const tags = JSON.parse(data.tags);
    expect(tags).toContain('auth');
    expect(tags).toContain('urgent');
  });

  it('POST /api/tickets with [tag] merges with explicit defaults.tags', async () => {
    const res = await app.request('/api/tickets', post({
      title: 'Something [newtag]',
      defaults: { tags: JSON.stringify(['existing']) },
    }));
    expect(res.status).toBe(201);
    const data = await res.json();
    const tags = JSON.parse(data.tags);
    expect(tags).toContain('existing');
    expect(tags).toContain('newtag');
  });
});

describe('custom view query', () => {
  it('POST /api/tickets/query with status condition returns matching tickets', async () => {
    // Create a ticket and move it to started
    const t = await (await app.request('/api/tickets', post({ title: 'QueryTest Started' }))).json();
    await app.request(`/api/tickets/${t.id}`, patch({ status: 'started' }));

    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [{ field: 'status', operator: 'equals', value: 'started' }],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // Every returned ticket should have status 'started'
    for (const ticket of data) {
      expect(ticket.status).toBe('started');
    }
    // Our ticket should be in the results
    expect(data.some((ticket: { id: number }) => ticket.id === t.id)).toBe(true);
  });

  it('POST /api/tickets/query with category condition', async () => {
    const t = await (await app.request('/api/tickets', post({
      title: 'QueryTest Bug',
      defaults: { category: 'bug' },
    }))).json();

    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [{ field: 'category', operator: 'equals', value: 'bug' }],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    for (const ticket of data) {
      expect(ticket.category).toBe('bug');
    }
    expect(data.some((ticket: { id: number }) => ticket.id === t.id)).toBe(true);
  });

  it('POST /api/tickets/query with "any" logic matches either condition', async () => {
    const tBug = await (await app.request('/api/tickets', post({
      title: 'QueryAny Bug',
      defaults: { category: 'bug' },
    }))).json();
    const tFeature = await (await app.request('/api/tickets', post({
      title: 'QueryAny Feature',
      defaults: { category: 'feature' },
    }))).json();

    const res = await app.request('/api/tickets/query', post({
      logic: 'any',
      conditions: [
        { field: 'category', operator: 'equals', value: 'bug' },
        { field: 'category', operator: 'equals', value: 'feature' },
      ],
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    for (const ticket of data) {
      expect(['bug', 'feature']).toContain(ticket.category);
    }
    expect(data.some((ticket: { id: number }) => ticket.id === tBug.id)).toBe(true);
    expect(data.some((ticket: { id: number }) => ticket.id === tFeature.id)).toBe(true);
  });

  it('POST /api/tickets/query with sort params', async () => {
    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [{ field: 'status', operator: 'equals', value: 'not_started' }],
      sort_by: 'created_at',
      sort_dir: 'desc',
    }));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
  });

  it('POST /api/tickets/query excludes deleted tickets', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'QueryDeleted' }))).json();
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });

    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [],
    }));
    const data = await res.json();
    expect(data.every((ticket: { id: number }) => ticket.id !== t.id)).toBe(true);
  });
});
