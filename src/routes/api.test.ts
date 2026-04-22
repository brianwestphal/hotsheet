import { existsSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { apiRoutes } from './api.js';

interface TicketResponse {
  id: number;
  title: string;
  ticket_number: string;
  category: string;
  priority: string;
  status: string;
  up_next: boolean;
  notes: string;
  tags: string;
  details: string;
  attachments: unknown[];
  completed_at: string | null;
  deleted_at: string | null;
  original_filename: string;
  stored_path: string;
}

interface NoteEntry {
  id: string;
  text: string;
  created_at: string;
}

interface StatsResponse {
  total: number;
  open: number;
  up_next: number;
  by_category: Record<string, number>;
  by_status: Record<string, number>;
}

interface DashboardResponse {
  throughput: { date: string; completed: number; created: number }[];
  cycleTime: unknown[];
  categoryBreakdown: unknown[];
  categoryPeriod: unknown[];
  kpi: {
    completedThisWeek: number;
    completedLastWeek: number;
    wipCount: number;
    createdThisWeek: number;
    medianCycleTimeDays: number | null;
  };
  snapshots: unknown[];
}

interface SettingsResponse {
  detail_position: string;
  channel_enabled: string;
  [key: string]: string;
}

interface FileSettingsResponse {
  appName?: string;
  secret?: string;
  secretPathHash?: string;
  port?: number;
  [key: string]: unknown;
}

interface PollResponse {
  version: number;
}

interface OkResponse {
  ok: boolean;
  path?: string;
}

interface ChannelStatusResponse {
  enabled: boolean;
  alive: boolean;
  done: boolean;
  port: number | null;
}

interface WorklistInfoResponse {
  prompt: string;
  skillCreated: boolean;
}

interface CategoryEntry {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  shortcutKey: string;
  description: string;
}

// Mock markdown sync and skills to avoid side effects in API tests
vi.mock('../sync/markdown.js', () => ({
  scheduleAllSync: vi.fn(),
  scheduleWorklistSync: vi.fn(),
  scheduleOpenTicketsSync: vi.fn(),
  flushPendingSyncs: vi.fn(() => Promise.resolve()),
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
  registerChannelForAll: vi.fn(),
  unregisterChannel: vi.fn(),
  unregisterChannelForAll: vi.fn(),
  shutdownChannel: vi.fn(() => Promise.resolve()),
  triggerChannel: vi.fn(() => Promise.resolve(true)),
  checkChannelVersion: vi.fn(() => Promise.resolve(null)),
}));

// Mock global config so channel enable/disable tests don't modify the real ~/.hotsheet/config.json
let mockGlobalConfig: Record<string, unknown> = {};
vi.mock('../global-config.js', () => ({
  readGlobalConfig: vi.fn(() => mockGlobalConfig),
  writeGlobalConfig: vi.fn((updates: Record<string, unknown>) => {
    mockGlobalConfig = { ...mockGlobalConfig, ...updates };
    return mockGlobalConfig;
  }),
}));

// Mock openInFileManager so the print test doesn't open a browser
vi.mock('../open-in-file-manager.js', () => ({
  openInFileManager: vi.fn(() => Promise.resolve()),
  revealInFileManager: vi.fn(() => Promise.resolve()),
}));

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    c.set('projectSecret', 'test-secret');
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
    const data = await res.json() as TicketResponse;
    expect(data.title).toBe('API test');
    expect(data.ticket_number).toMatch(/^HS-\d+$/);
    ticketId = data.id;
  });

  it('POST /api/tickets with defaults', async () => {
    const res = await app.request('/api/tickets', post({
      title: 'With defaults',
      defaults: { category: 'bug', priority: 'high', up_next: true },
    }));
    const data = await res.json() as TicketResponse;
    expect(data.category).toBe('bug');
    expect(data.priority).toBe('high');
    expect(data.up_next).toBe(true);
  });

  it('GET /api/tickets/:id returns ticket with attachments array', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`);
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse;
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
    const data = await res.json() as TicketResponse;
    expect(data.title).toBe('Updated title');
    expect(data.category).toBe('feature');
  });

  it('PATCH /api/tickets/:id returns 404 for missing', async () => {
    const res = await app.request('/api/tickets/99999', patch({ title: 'Nope' }));
    expect(res.status).toBe(404);
  });

  it('PATCH /api/tickets/:id appends notes', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, patch({ notes: 'A note' }));
    const data = await res.json() as TicketResponse;
    const notes = JSON.parse(data.notes) as NoteEntry[];
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('A note');
  });

  it('DELETE /api/tickets/:id soft-deletes', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'To delete' }))).json() as TicketResponse;
    const res = await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const check = await (await app.request(`/api/tickets/${t.id}`)).json() as TicketResponse;
    expect(check.status).toBe('deleted');
  });

  it('DELETE /api/tickets/:id/hard permanently removes', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'To hard delete' }))).json() as TicketResponse;
    const res = await app.request(`/api/tickets/${t.id}/hard`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const check = await app.request(`/api/tickets/${t.id}`);
    expect(check.status).toBe(404);
  });

  // HS-6700: malformed JSON bodies used to surface as an unhandled 500 + stack
  // trace in the server log. The onError handler in apiRoutes now maps JSON
  // parse errors to a clean 400.
  it('PATCH /api/tickets/:id returns 400 for malformed JSON (bad escape)', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"notes": "bad \\x escape"}', // \x is not a valid JSON escape
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/Invalid JSON body/);
  });

  it('PATCH /api/tickets/:id returns 400 for truncated JSON', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title": "oops', // missing closing quote + brace
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/Invalid JSON body/);
  });

  it('POST /api/tickets returns 400 for malformed JSON', async () => {
    const res = await app.request('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"title": "bad \\q escape"}',
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toMatch(/Invalid JSON body/);
  });
});

describe('filtering & sorting', () => {
  it('GET /api/tickets returns default filtered list', async () => {
    const res = await app.request('/api/tickets');
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('filters by status=open', async () => {
    const res = await app.request('/api/tickets?status=open');
    const data = await res.json() as TicketResponse[];
    for (const t of data) {
      expect(['not_started', 'started']).toContain(t.status);
    }
  });

  it('filters by up_next=true', async () => {
    const res = await app.request('/api/tickets?up_next=true');
    const data = await res.json() as TicketResponse[];
    for (const t of data) {
      expect(t.up_next).toBe(true);
    }
  });

  it('search is case-insensitive', async () => {
    await app.request('/api/tickets', post({ title: 'UniqueSearchTerm123' }));
    const res = await app.request('/api/tickets?search=uniquesearchterm123');
    const data = await res.json() as TicketResponse[];
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].title).toBe('UniqueSearchTerm123');
  });

  it('sorts by priority asc', async () => {
    const res = await app.request('/api/tickets?sort_by=priority&sort_dir=asc');
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('empty string params are treated as not provided', async () => {
    const res = await app.request('/api/tickets?category=&status=&search=');
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('batch operations', () => {
  it('batch delete', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'Batch 1' }))).json() as TicketResponse;
    const t2 = await (await app.request('/api/tickets', post({ title: 'Batch 2' }))).json() as TicketResponse;
    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id],
      action: 'delete',
    }));
    expect(res.status).toBe(200);
    const r1 = await (await app.request(`/api/tickets/${t1.id}`)).json() as TicketResponse;
    expect(r1.status).toBe('deleted');
  });

  it('batch category update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch cat' }))).json() as TicketResponse;
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'category',
      value: 'task',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json() as TicketResponse;
    expect(r.category).toBe('task');
  });

  it('batch priority update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch pri' }))).json() as TicketResponse;
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'priority',
      value: 'highest',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json() as TicketResponse;
    expect(r.priority).toBe('highest');
  });

  it('batch status update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch status' }))).json() as TicketResponse;
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'status',
      value: 'completed',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json() as TicketResponse;
    expect(r.status).toBe('completed');
    expect(r.completed_at).not.toBeNull();
  });

  it('batch up_next update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch upnext' }))).json() as TicketResponse;
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'up_next',
      value: true,
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json() as TicketResponse;
    expect(r.up_next).toBe(true);
  });

  it('batch restore', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Batch restore' }))).json() as TicketResponse;
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    await app.request('/api/tickets/batch', post({
      ids: [t.id],
      action: 'restore',
    }));
    const r = await (await app.request(`/api/tickets/${t.id}`)).json() as TicketResponse;
    expect(r.status).toBe('not_started');
  });
});

describe('up next toggle', () => {
  it('POST /api/tickets/:id/up-next toggles', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Up next' }))).json() as TicketResponse;
    expect(t.up_next).toBe(false);
    const r1 = await (await app.request(`/api/tickets/${t.id}/up-next`, { method: 'POST' })).json() as TicketResponse;
    expect(r1.up_next).toBe(true);
    const r2 = await (await app.request(`/api/tickets/${t.id}/up-next`, { method: 'POST' })).json() as TicketResponse;
    expect(r2.up_next).toBe(false);
  });

  it('returns 404 for missing ticket', async () => {
    const res = await app.request('/api/tickets/99999/up-next', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('restore', () => {
  it('POST /api/tickets/:id/restore restores deleted ticket', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Restore' }))).json() as TicketResponse;
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    const res = await app.request(`/api/tickets/${t.id}/restore`, { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse;
    expect(data.status).toBe('not_started');
  });
});

describe('trash', () => {
  it('POST /api/trash/empty hard-deletes all trashed tickets', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Trash empty' }))).json() as TicketResponse;
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    const res = await app.request('/api/trash/empty', { method: 'POST' });
    expect(res.status).toBe(200);
    const check = await app.request(`/api/tickets/${t.id}`);
    expect(check.status).toBe(404);
  });
});

describe('attachments', () => {
  it('POST /api/tickets/:id/attachments uploads a file', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Attach upload' }))).json() as TicketResponse;
    const formData = new FormData();
    formData.append('file', new File(['test content'], 'test.png', { type: 'image/png' }));
    const res = await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    });
    expect(res.status).toBe(201);
    const data = await res.json() as TicketResponse;
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
    const t = await (await app.request('/api/tickets', post({ title: 'Attach delete' }))).json() as TicketResponse;
    const formData = new FormData();
    formData.append('file', new File(['data'], 'todelete.txt', { type: 'text/plain' }));
    const uploaded = await (await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    })).json() as TicketResponse;

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
    const t = await (await app.request('/api/tickets', post({ title: 'Hard del attach' }))).json() as TicketResponse;
    const formData = new FormData();
    formData.append('file', new File(['data'], 'harddel.txt', { type: 'text/plain' }));
    const uploaded = await (await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    })).json() as TicketResponse;

    const res = await app.request(`/api/tickets/${t.id}/hard`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(existsSync(uploaded.stored_path)).toBe(false);
  });

  it('POST /api/trash/empty cleans up attachment files', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Trash attach' }))).json() as TicketResponse;
    const formData = new FormData();
    formData.append('file', new File(['data'], 'trash.txt', { type: 'text/plain' }));
    const uploaded = await (await app.request(`/api/tickets/${t.id}/attachments`, {
      method: 'POST',
      body: formData,
    })).json() as TicketResponse;

    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });
    await app.request('/api/trash/empty', { method: 'POST' });
    expect(existsSync(uploaded.stored_path)).toBe(false);
  });
});

describe('stats', () => {
  it('GET /api/stats returns correct structure', async () => {
    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const data = await res.json() as StatsResponse;
    expect(typeof data.total).toBe('number');
    expect(typeof data.open).toBe('number');
    expect(typeof data.up_next).toBe('number');
    expect(data.by_category).toBeDefined();
    expect(data.by_status).toBeDefined();
  });
});

describe('settings', () => {
  it('GET /api/settings returns settings object', async () => {
    const res = await app.request('/api/settings');
    expect(res.status).toBe(200);
    const data = await res.json() as SettingsResponse;
    expect(typeof data).toBe('object');
  });

  it('PATCH /api/settings upserts', async () => {
    await app.request('/api/settings', patch({ detail_position: 'bottom' }));
    const res = await app.request('/api/settings');
    const data = await res.json() as SettingsResponse;
    expect(data.detail_position).toBe('bottom');
  });

  it('GET /api/file-settings returns file settings', async () => {
    const res = await app.request('/api/file-settings');
    expect(res.status).toBe(200);
    const data = await res.json() as FileSettingsResponse;
    expect(typeof data).toBe('object');
  });

  it('PATCH /api/file-settings merges settings', async () => {
    await app.request('/api/file-settings', patch({ appName: 'Test App' }));
    const res = await app.request('/api/file-settings');
    const data = await res.json() as FileSettingsResponse;
    expect(data.appName).toBe('Test App');
  });

  // HS-6370 regression guard: when the client sends a native JSON array for
  // `terminals` (or any other JSON-valued setting), it must be persisted to
  // settings.json as a native array, not double-encoded as a JSON string.
  it('PATCH /api/file-settings stores terminals as a native array (HS-6370)', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const terminals = [
      { id: 'main', name: 'Claude', command: '{{claudeCommand}}', lazy: true },
      { id: 'logs', name: 'Logs', command: 'tail -f /tmp/app.log', lazy: false },
    ];
    const res = await app.request('/api/file-settings', patch({ terminals }));
    expect(res.status).toBe(200);

    const onDisk: unknown = JSON.parse(fs.readFileSync(path.join(tempDir, 'settings.json'), 'utf-8'));
    const stored = (onDisk as { terminals: unknown }).terminals;
    expect(Array.isArray(stored)).toBe(true);
    expect(stored).toEqual(terminals);
  });
});

interface TerminalListResponse {
  configured: { id: string; name?: string; command: string; lazy?: boolean; bellPending?: boolean; state?: 'alive' | 'exited' | 'not_spawned' }[];
  dynamic: { id: string; name?: string; command: string; lazy?: boolean; bellPending?: boolean; state?: 'alive' | 'exited' | 'not_spawned' }[];
}

interface TerminalCreateResponse {
  config: { id: string; command: string; name?: string; cwd?: string };
}

describe('terminal route', () => {
  // HS-6341: a freshly-created dynamic terminal must appear in /list before any
  // websocket attaches. Without this, the client renders no tab for it but
  // still switches the drawer to its (non-existent) panel — a blank drawer.
  it('POST /api/terminal/create then GET /list includes the new dynamic terminal', async () => {
    const create = await app.request('/api/terminal/create', { method: 'POST' });
    expect(create.status).toBe(200);
    const created = await create.json() as TerminalCreateResponse;
    expect(created.config.id).toMatch(/^dyn-/);
    expect(typeof created.config.command).toBe('string');
    expect(created.config.command.length).toBeGreaterThan(0);
    // Server must seed a name so the drawer tab has a visible label even
    // before the websocket attaches and the PTY emits anything (HS-6341).
    expect(typeof created.config.name).toBe('string');
    expect(created.config.name?.length ?? 0).toBeGreaterThan(0);

    const list = await app.request('/api/terminal/list');
    expect(list.status).toBe(200);
    const data = await list.json() as TerminalListResponse;
    const ids = data.dynamic.map(t => t.id);
    expect(ids).toContain(created.config.id);
    const echoed = data.dynamic.find(t => t.id === created.config.id);
    expect(echoed?.name).toBe(created.config.name);
  });

  it('POST /api/terminal/destroy removes the dynamic terminal from /list', async () => {
    const create = await app.request('/api/terminal/create', { method: 'POST' });
    const created = await create.json() as TerminalCreateResponse;

    await app.request('/api/terminal/destroy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: created.config.id }),
    });

    const list = await app.request('/api/terminal/list');
    const data = await list.json() as TerminalListResponse;
    const ids = data.dynamic.map(t => t.id);
    expect(ids).not.toContain(created.config.id);
  });

  // HS-6603 §24.3.1 / §24.3.2 — /list includes bellPending; clear-bell flips it.
  it('GET /api/terminal/list annotates each entry with bellPending (default false)', async () => {
    const list = await app.request('/api/terminal/list');
    expect(list.status).toBe(200);
    const data = await list.json() as TerminalListResponse;
    for (const entry of [...data.configured, ...data.dynamic]) {
      expect(entry.bellPending).toBe(false);
    }
  });

  // HS-6834 §25.5 — /list includes session state so the terminal dashboard
  // knows which entries are safe to WebSocket-attach vs. which render as
  // placeholders (HS-6838). Freshly-registered / never-attached terminals
  // should report `not_spawned`.
  it('GET /api/terminal/list annotates each entry with state (default not_spawned)', async () => {
    const create = await app.request('/api/terminal/create', { method: 'POST' });
    const created = await create.json() as TerminalCreateResponse;
    const list = await app.request('/api/terminal/list');
    const data = await list.json() as TerminalListResponse;
    const entry = data.dynamic.find(t => t.id === created.config.id);
    expect(entry).toBeDefined();
    expect(entry?.state).toBe('not_spawned');
  });

  it('POST /api/terminal/clear-bell returns { ok: true } even when no flag was set', async () => {
    const res = await app.request('/api/terminal/clear-bell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ terminalId: 'does-not-exist' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe('long-poll', () => {
  it('returns immediately when client version is behind', async () => {
    // Create a ticket to ensure changeVersion > 0
    await app.request('/api/tickets', post({ title: 'Poll setup' }));
    const res = await app.request('/api/poll?version=0');
    expect(res.status).toBe(200);
    const data = await res.json() as PollResponse;
    expect(data.version).toBeGreaterThan(0);
  });

  it('resolves when a change occurs', async () => {
    // Get current version
    const { version } = await (await app.request('/api/poll?version=0')).json() as PollResponse;

    // Start poll at current version (will wait for change)
    const pollPromise = app.request(`/api/poll?version=${version}`);

    // Trigger a change
    await app.request('/api/tickets', post({ title: 'Trigger change' }));

    // Poll should resolve with new version
    const res = await pollPromise;
    const data = await res.json() as PollResponse;
    expect(data.version).toBeGreaterThan(version);
  });
});

describe('path traversal protection', () => {
  it('does not serve files outside the attachments directory via ../ traversal', async () => {
    // Place a sensitive file one level above the attachments dir (in the data dir)
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(path.join(tempDir, 'secret-data.txt'), 'top secret');

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
    const fs = await import('fs');
    const path = await import('path');
    const attachDir = path.join(tempDir, 'attachments');
    fs.writeFileSync(path.join(attachDir, 'traversal-test.txt'), 'safe content');

    const res = await app.request('/api/attachments/file/traversal-test.txt');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('safe content');
  });
});

describe('file-settings secret stripping', () => {
  it('GET /api/file-settings does NOT return secret or secretPathHash', async () => {
    // Write a settings.json with secret fields
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(
      path.join(tempDir, 'settings.json'),
      JSON.stringify({
        appName: 'Secret Test',
        secret: 'super-secret-value',
        secretPathHash: 'hash-value-here',
        port: 4174,
      }),
    );

    const res = await app.request('/api/file-settings');
    expect(res.status).toBe(200);
    const data = await res.json() as FileSettingsResponse;

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
    const data = await res.json() as DashboardResponse;

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
    const data = await res.json() as DashboardResponse;
    // Should still return valid structure
    expect(data).toHaveProperty('kpi');
    expect(data).toHaveProperty('throughput');
  });
});

describe('batch operations — extended', () => {
  it('batch delete marks multiple tickets as deleted', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'BatchDel A' }))).json() as TicketResponse;
    const t2 = await (await app.request('/api/tickets', post({ title: 'BatchDel B' }))).json() as TicketResponse;
    const t3 = await (await app.request('/api/tickets', post({ title: 'BatchDel C' }))).json() as TicketResponse;

    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id, t3.id],
      action: 'delete',
    }));
    expect(res.status).toBe(200);

    // All three should be deleted
    for (const id of [t1.id, t2.id, t3.id]) {
      const check = await (await app.request(`/api/tickets/${id}`)).json() as TicketResponse;
      expect(check.status).toBe('deleted');
    }
  });

  it('batch status change to started sets status on multiple tickets', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'BatchStatus A' }))).json() as TicketResponse;
    const t2 = await (await app.request('/api/tickets', post({ title: 'BatchStatus B' }))).json() as TicketResponse;

    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id],
      action: 'status',
      value: 'started',
    }));
    expect(res.status).toBe(200);

    for (const id of [t1.id, t2.id]) {
      const check = await (await app.request(`/api/tickets/${id}`)).json() as TicketResponse;
      expect(check.status).toBe('started');
    }
  });

  it('batch restore recovers multiple deleted tickets', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'BatchRestore A' }))).json() as TicketResponse;
    const t2 = await (await app.request('/api/tickets', post({ title: 'BatchRestore B' }))).json() as TicketResponse;

    // Soft-delete them
    await app.request(`/api/tickets/${t1.id}`, { method: 'DELETE' });
    await app.request(`/api/tickets/${t2.id}`, { method: 'DELETE' });

    // Confirm deleted
    expect((await (await app.request(`/api/tickets/${t1.id}`)).json() as TicketResponse).status).toBe('deleted');
    expect((await (await app.request(`/api/tickets/${t2.id}`)).json() as TicketResponse).status).toBe('deleted');

    // Batch restore
    const res = await app.request('/api/tickets/batch', post({
      ids: [t1.id, t2.id],
      action: 'restore',
    }));
    expect(res.status).toBe(200);

    // Both should be restored to not_started
    for (const id of [t1.id, t2.id]) {
      const check = await (await app.request(`/api/tickets/${id}`)).json() as TicketResponse;
      expect(check.status).toBe('not_started');
    }
  });
});

describe('CSRF origin validation', () => {
  // The CSRF middleware lives in server.ts's startServer, not in apiRoutes directly.
  // We create a separate app instance with that middleware to test it.
  let csrfApp: Hono<AppEnv>;

  beforeAll(async () => {
    const fs = await import('fs');
    const path = await import('path');

    // Write settings.json with a secret to activate the CSRF middleware
    fs.writeFileSync(
      path.join(tempDir, 'settings.json'),
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
      if (expectedSecret == null || expectedSecret === '') { await next(); return; }

      const headerSecret = c.req.header('X-Hotsheet-Secret');
      const method = c.req.method;
      const isMutation = method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';

      if (headerSecret != null && headerSecret !== '') {
        if (headerSecret !== expectedSecret) {
          return c.json({ error: 'Secret mismatch' }, 403);
        }
      } else if (isMutation) {
        const origin = c.req.header('Origin');
        const referer = c.req.header('Referer');
        const localhostPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/;
        const isSameOrigin = (origin != null && origin !== '' && localhostPattern.test(origin))
          || (referer != null && referer !== '' && localhostPattern.test(referer));
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
    const data = await res.json() as TicketResponse;
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
    const data = await res.json() as string[];
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
    const data = await res.json() as string[];
    expect(Array.isArray(data)).toBe(true);
  });
});

describe('notes CRUD', () => {
  let ticketId: number;

  it('PATCH /api/tickets/:id adds notes via update', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'Notes test' }))).json() as TicketResponse;
    ticketId = t.id;

    // Add a first note
    const res = await app.request(`/api/tickets/${ticketId}`, patch({ notes: 'First note' }));
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse;
    const notes = JSON.parse(data.notes) as NoteEntry[];
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('First note');
    expect(notes[0].id).toBeDefined();
  });

  it('PATCH /api/tickets/:id appends additional notes', async () => {
    const res = await app.request(`/api/tickets/${ticketId}`, patch({ notes: 'Second note' }));
    const data = await res.json() as TicketResponse;
    const notes = JSON.parse(data.notes) as NoteEntry[];
    expect(notes).toHaveLength(2);
    expect(notes[1].text).toBe('Second note');
  });

  it('PATCH /api/tickets/:id/notes/:noteId edits a note', async () => {
    // Get current notes to find the note ID
    const ticket = await (await app.request(`/api/tickets/${ticketId}`)).json() as TicketResponse;
    const notes = JSON.parse(ticket.notes) as NoteEntry[];
    const noteId = notes[0].id;

    const res = await app.request(`/api/tickets/${ticketId}/notes/${noteId}`, patch({ text: 'Edited note' }));
    expect(res.status).toBe(200);
    const updatedNotes = await res.json() as NoteEntry[];
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
    const ticket = await (await app.request(`/api/tickets/${ticketId}`)).json() as TicketResponse;
    const notes = JSON.parse(ticket.notes) as NoteEntry[];
    const noteId = notes[0].id;
    const originalLength = notes.length;

    const res = await app.request(`/api/tickets/${ticketId}/notes/${noteId}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const updatedNotes = await res.json() as NoteEntry[];
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
    const ticket = await (await app.request(`/api/tickets/${ticketId}`)).json() as TicketResponse;
    const notes = JSON.parse(ticket.notes) as NoteEntry[];
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
    const data = await res.json() as WorklistInfoResponse;
    expect(typeof data.prompt).toBe('string');
    expect(data.prompt).toContain('worklist.md');
    expect(typeof data.skillCreated).toBe('boolean');
  });
});

describe('channel endpoints', () => {
  it('POST /api/channel/done sets the done flag', async () => {
    const res = await app.request('/api/channel/done', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);
  });

  it('GET /api/channel/status returns status fields', async () => {
    const res = await app.request('/api/channel/status');
    expect(res.status).toBe(200);
    const data = await res.json() as ChannelStatusResponse;
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
    const data1 = await res1.json() as ChannelStatusResponse;
    expect(data1.done).toBe(true);

    // Second read should show done=false (consumed)
    const res2 = await app.request('/api/channel/status');
    const data2 = await res2.json() as ChannelStatusResponse;
    expect(data2.done).toBe(false);
  });

  it('POST /api/channel/enable enables the channel', async () => {
    const res = await app.request('/api/channel/enable', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);

    // Verify via global config (channel_enabled moved from per-project to global)
    const status = await (await app.request('/api/channel/status')).json() as { enabled: boolean };
    expect(status.enabled).toBe(true);
  });

  it('POST /api/channel/disable disables the channel', async () => {
    const res = await app.request('/api/channel/disable', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);

    // Verify via global config
    const status = await (await app.request('/api/channel/status')).json() as { enabled: boolean };
    expect(status.enabled).toBe(false);
  });

  // HS-6477: when /channel/permission/respond runs without a prior
  // permission_request log entry (race against the long-poll, or channel
  // restarted), it must still log a useful entry — tool name + description +
  // input_preview from the body — instead of the bare {request_id, behavior}.
  it('POST /api/channel/permission/respond writes detail-rich log entry when no prior request was logged', async () => {
    const channelConfig = await import('../channel-config.js');
    vi.mocked(channelConfig.getChannelPort).mockReturnValueOnce(65000);
    // The channel server fetch will fail (no real server on 65000) — that
    // returns 503 to the client, but the log entry path runs first.
    const res = await app.request('/api/channel/permission/respond', post({
      request_id: 'race-id-1',
      behavior: 'allow',
      tool_name: 'Bash',
      description: 'Run npm test',
      input_preview: 'npm test --watch=false',
    }));
    expect(res.status).toBe(503);

    const logRes = await app.request('/api/command-log');
    const log = await logRes.json() as { event_type: string; summary: string; detail: string }[];
    const entry = log.find(e => e.event_type === 'permission_request' && !e.summary.includes('race-id-1') && e.summary.includes('Bash'));
    expect(entry).toBeDefined();
    expect(entry!.summary).toBe('Permission: Bash — Allowed');
    expect(entry!.detail).toContain('Run npm test');
    expect(entry!.detail).toContain('npm test --watch=false');
    // Critical regression guard: the bare JSON body must not be the only thing logged.
    expect(entry!.detail).not.toBe('{"request_id":"race-id-1","behavior":"allow","tool_name":"Bash","description":"Run npm test","input_preview":"npm test --watch=false"}');
  });

  it('POST /api/channel/permission/respond falls back to raw JSON when client sends no description/preview', async () => {
    const channelConfig = await import('../channel-config.js');
    vi.mocked(channelConfig.getChannelPort).mockReturnValueOnce(65000);
    const res = await app.request('/api/channel/permission/respond', post({
      request_id: 'race-id-2',
      behavior: 'deny',
    }));
    expect(res.status).toBe(503);

    const logRes = await app.request('/api/command-log');
    const log = await logRes.json() as { event_type: string; summary: string; detail: string }[];
    const entry = log.find(e => e.summary === 'Permission: tool — Denied');
    expect(entry).toBeDefined();
    // Pre-HS-6477 behavior preserved when no client context is available.
    expect(entry!.detail).toContain('"request_id":"race-id-2"');
  });
});

describe('print endpoint', () => {
  it('POST /api/print writes HTML and returns ok', async () => {
    const res = await app.request('/api/print', post({
      html: '<html><body><h1>Print Test</h1></body></html>',
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);
    expect(typeof data.path).toBe('string');
    expect(data.path).toContain('hotsheet-print');
  });
});

describe('categories', () => {
  it('GET /api/categories returns categories array', async () => {
    const res = await app.request('/api/categories');
    expect(res.status).toBe(200);
    const data = await res.json() as CategoryEntry[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('PUT /api/categories saves custom categories', async () => {
    const customCategories = [
      { id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#ff0000', shortcutKey: 'b', description: 'Bugs' },
      { id: 'feature', label: 'Feature', shortLabel: 'FEA', color: '#00ff00', shortcutKey: 'f', description: 'Features' },
      { id: 'task', label: 'Task', shortLabel: 'TSK', color: '#0000ff', shortcutKey: 't', description: 'Tasks' },
    ];
    const res = await app.request('/api/categories', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(customCategories),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as CategoryEntry[];
    expect(data).toHaveLength(3);

    // Verify persistence
    const check = await (await app.request('/api/categories')).json() as CategoryEntry[];
    expect(check).toHaveLength(3);
    expect(check[0].id).toBe('bug');
  });

  it('GET /api/category-presets returns presets', async () => {
    const res = await app.request('/api/category-presets');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
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
    }))).json() as TicketResponse;

    const res = await app.request('/api/tickets/duplicate', post({ ids: [t1.id] }));
    expect(res.status).toBe(201);
    const created = await res.json() as TicketResponse[];
    expect(Array.isArray(created)).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0].title).toBe('Dup source - Copy');
    expect(created[0].category).toBe('bug');
    expect(created[0].id).not.toBe(t1.id);
  });

  it('POST /api/tickets/duplicate handles multiple IDs', async () => {
    const t1 = await (await app.request('/api/tickets', post({ title: 'Dup A' }))).json() as TicketResponse;
    const t2 = await (await app.request('/api/tickets', post({ title: 'Dup B' }))).json() as TicketResponse;

    const res = await app.request('/api/tickets/duplicate', post({ ids: [t1.id, t2.id] }));
    expect(res.status).toBe(201);
    const created = await res.json() as TicketResponse[];
    expect(created).toHaveLength(2);
  });
});

describe('bracket tag extraction', () => {
  it('POST /api/tickets with [tag] syntax extracts tags', async () => {
    const res = await app.request('/api/tickets', post({ title: 'Fix login [auth] [urgent]' }));
    expect(res.status).toBe(201);
    const data = await res.json() as TicketResponse;
    expect(data.title).toBe('Fix login');
    const tags = JSON.parse(data.tags) as string[];
    expect(tags).toContain('auth');
    expect(tags).toContain('urgent');
  });

  it('POST /api/tickets with [tag] merges with explicit defaults.tags', async () => {
    const res = await app.request('/api/tickets', post({
      title: 'Something [newtag]',
      defaults: { tags: JSON.stringify(['existing']) },
    }));
    expect(res.status).toBe(201);
    const data = await res.json() as TicketResponse;
    const tags = JSON.parse(data.tags) as string[];
    expect(tags).toContain('existing');
    expect(tags).toContain('newtag');
  });
});

describe('custom view query', () => {
  it('POST /api/tickets/query with status condition returns matching tickets', async () => {
    // Create a ticket and move it to started
    const t = await (await app.request('/api/tickets', post({ title: 'QueryTest Started' }))).json() as TicketResponse;
    await app.request(`/api/tickets/${t.id}`, patch({ status: 'started' }));

    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [{ field: 'status', operator: 'equals', value: 'started' }],
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
    // Every returned ticket should have status 'started'
    for (const ticket of data) {
      expect(ticket.status).toBe('started');
    }
    // Our ticket should be in the results
    expect(data.some((ticket) => ticket.id === t.id)).toBe(true);
  });

  it('POST /api/tickets/query with category condition', async () => {
    const t = await (await app.request('/api/tickets', post({
      title: 'QueryTest Bug',
      defaults: { category: 'bug' },
    }))).json() as TicketResponse;

    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [{ field: 'category', operator: 'equals', value: 'bug' }],
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
    for (const ticket of data) {
      expect(ticket.category).toBe('bug');
    }
    expect(data.some((ticket) => ticket.id === t.id)).toBe(true);
  });

  it('POST /api/tickets/query with "any" logic matches either condition', async () => {
    const tBug = await (await app.request('/api/tickets', post({
      title: 'QueryAny Bug',
      defaults: { category: 'bug' },
    }))).json() as TicketResponse;
    const tFeature = await (await app.request('/api/tickets', post({
      title: 'QueryAny Feature',
      defaults: { category: 'feature' },
    }))).json() as TicketResponse;

    const res = await app.request('/api/tickets/query', post({
      logic: 'any',
      conditions: [
        { field: 'category', operator: 'equals', value: 'bug' },
        { field: 'category', operator: 'equals', value: 'feature' },
      ],
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
    for (const ticket of data) {
      expect(['bug', 'feature']).toContain(ticket.category);
    }
    expect(data.some((ticket) => ticket.id === tBug.id)).toBe(true);
    expect(data.some((ticket) => ticket.id === tFeature.id)).toBe(true);
  });

  it('POST /api/tickets/query with sort params', async () => {
    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [{ field: 'status', operator: 'equals', value: 'not_started' }],
      sort_by: 'created_at',
      sort_dir: 'desc',
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as TicketResponse[];
    expect(Array.isArray(data)).toBe(true);
  });

  it('POST /api/tickets/query excludes deleted tickets', async () => {
    const t = await (await app.request('/api/tickets', post({ title: 'QueryDeleted' }))).json() as TicketResponse;
    await app.request(`/api/tickets/${t.id}`, { method: 'DELETE' });

    const res = await app.request('/api/tickets/query', post({
      logic: 'all',
      conditions: [],
    }));
    const data = await res.json() as TicketResponse[];
    expect(data.every((ticket) => ticket.id !== t.id)).toBe(true);
  });
});

// ---------- channel route endpoint tests ----------

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...(actual as object), execFileSync: vi.fn() };
});

interface ClaudeCheckResponse {
  installed: boolean;
  version: string | null;
  meetsMinimum: boolean;
}

interface ChannelPermissionResponse {
  pending: unknown;
}

interface ChannelPermissionRespondResponse {
  ok?: boolean;
  error?: string;
}

describe('GET /api/channel/claude-check', () => {
  it('returns installed=true with version when claude is found', async () => {
    const { execFileSync } = await import('child_process');
    const mockExec = vi.mocked(execFileSync);
    mockExec.mockReturnValue('Claude Code v2.1.85\n');

    const res = await app.request('/api/channel/claude-check');
    expect(res.status).toBe(200);
    const data = await res.json() as ClaudeCheckResponse;
    expect(data.installed).toBe(true);
    expect(data.version).toBe('2.1.85');
    expect(data.meetsMinimum).toBe(true);
  });

  it('returns meetsMinimum=false for old versions', async () => {
    const { execFileSync } = await import('child_process');
    const mockExec = vi.mocked(execFileSync);
    mockExec.mockReturnValue('Claude Code v2.0.5\n');

    const res = await app.request('/api/channel/claude-check');
    expect(res.status).toBe(200);
    const data = await res.json() as ClaudeCheckResponse;
    expect(data.installed).toBe(true);
    expect(data.version).toBe('2.0.5');
    expect(data.meetsMinimum).toBe(false);
  });

  it('returns installed=false when claude is not found', async () => {
    const { execFileSync } = await import('child_process');
    const mockExec = vi.mocked(execFileSync);
    mockExec.mockImplementation(() => { throw new Error('command not found'); });

    const res = await app.request('/api/channel/claude-check');
    expect(res.status).toBe(200);
    const data = await res.json() as ClaudeCheckResponse;
    expect(data.installed).toBe(false);
    expect(data.version).toBeNull();
    expect(data.meetsMinimum).toBe(false);
  });

  it('returns meetsMinimum=true for major version above 2', async () => {
    const { execFileSync } = await import('child_process');
    const mockExec = vi.mocked(execFileSync);
    mockExec.mockReturnValue('3.0.0\n');

    const res = await app.request('/api/channel/claude-check');
    const data = await res.json() as ClaudeCheckResponse;
    expect(data.installed).toBe(true);
    expect(data.version).toBe('3.0.0');
    expect(data.meetsMinimum).toBe(true);
  });
});

describe('POST /api/channel/trigger', () => {
  it('calls triggerChannel and returns ok', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockTrigger = vi.mocked(channelConfig.triggerChannel);
    mockTrigger.mockResolvedValue(true);

    const res = await app.request('/api/channel/trigger', post({ message: 'Do the work' }));
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);
    expect(mockTrigger).toHaveBeenCalledWith(
      expect.any(String),    // dataDir
      expect.any(Number),    // serverPort
      'Do the work',
    );
  });

  it('returns ok=false when triggerChannel fails', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockTrigger = vi.mocked(channelConfig.triggerChannel);
    mockTrigger.mockResolvedValue(false);

    const res = await app.request('/api/channel/trigger', post({}));
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(false);
  });
});

describe('GET /api/channel/permission', () => {
  it('returns pending permission data when channel port is available', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(9999);

    const permissionData = { pending: { request_id: 'req-1', tool: 'bash', description: 'Run ls' } };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(permissionData), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const res = await app.request('/api/channel/permission');
    expect(res.status).toBe(200);
    const data = await res.json() as ChannelPermissionResponse;
    expect(data.pending).toEqual(permissionData.pending);

    fetchSpy.mockRestore();
    mockGetPort.mockReturnValue(null); // reset
  });

  it('returns pending=null when channel port is null', async () => {
    const channelConfig = await import('../channel-config.js');
    const { notifyPermission } = await import('./notify.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(null);

    // Wake the long-poll immediately so it doesn't wait 30s
    const resPromise = app.request('/api/channel/permission');
    setTimeout(() => notifyPermission(), 50);
    const res = await resPromise;
    expect(res.status).toBe(200);
    const data = await res.json() as ChannelPermissionResponse;
    expect(data.pending).toBeNull();
  });

  it('returns pending=null when fetch to channel server fails', async () => {
    const channelConfig = await import('../channel-config.js');
    const { notifyPermission } = await import('./notify.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(9999);

    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('Connection refused'));

    // Wake the long-poll immediately so it doesn't wait 30s
    const resPromise = app.request('/api/channel/permission');
    setTimeout(() => notifyPermission(), 50);
    const res = await resPromise;
    expect(res.status).toBe(200);
    const data = await res.json() as ChannelPermissionResponse;
    expect(data.pending).toBeNull();

    fetchSpy.mockRestore();
    mockGetPort.mockReturnValue(null);
  });
});

describe('POST /api/channel/permission/respond', () => {
  it('forwards response to channel server and returns result', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(9999);

    const responseBody = { ok: true };
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(responseBody), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const res = await app.request('/api/channel/permission/respond', post({
      request_id: 'req-1',
      behavior: 'allow',
    }));
    expect(res.status).toBe(200);
    const data = await res.json() as ChannelPermissionRespondResponse;
    expect(data.ok).toBe(true);

    // Verify fetch was called with correct args
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/permission/respond',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ request_id: 'req-1', behavior: 'allow' }),
      }),
    );

    fetchSpy.mockRestore();
    mockGetPort.mockReturnValue(null);
  });

  it('returns 503 when channel port is null', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(null);

    const res = await app.request('/api/channel/permission/respond', post({
      request_id: 'req-1',
      behavior: 'deny',
    }));
    expect(res.status).toBe(503);
    const data = await res.json() as ChannelPermissionRespondResponse;
    expect(data.error).toBe('Channel not available');
  });

  it('returns 503 when fetch to channel server fails', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(9999);

    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    const res = await app.request('/api/channel/permission/respond', post({
      request_id: 'req-1',
      behavior: 'allow',
    }));
    expect(res.status).toBe(503);
    const data = await res.json() as ChannelPermissionRespondResponse;
    expect(data.error).toBe('Failed to reach channel server');

    fetchSpy.mockRestore();
    mockGetPort.mockReturnValue(null);
  });
});

describe('POST /api/channel/permission/dismiss', () => {
  it('returns ok when channel port is available', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(9999);

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce(
      new Response('{}', { status: 200 }),
    );

    const res = await app.request('/api/channel/permission/dismiss', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);

    // Verify fetch was called to the dismiss endpoint
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:9999/permission/dismiss',
      expect.objectContaining({ method: 'POST' }),
    );

    fetchSpy.mockRestore();
    mockGetPort.mockReturnValue(null);
  });

  it('returns ok when channel port is null (no-op)', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(null);

    const res = await app.request('/api/channel/permission/dismiss', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);
  });

  it('returns ok even when fetch to channel server fails', async () => {
    const channelConfig = await import('../channel-config.js');
    const mockGetPort = vi.mocked(channelConfig.getChannelPort);
    mockGetPort.mockReturnValue(9999);

    const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Connection refused'));

    const res = await app.request('/api/channel/permission/dismiss', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as OkResponse;
    expect(data.ok).toBe(true);

    fetchSpy.mockRestore();
    mockGetPort.mockReturnValue(null);
  });
});
