/**
 * HS-5622: unit tests for routes/projects.ts.
 * Uses Hono test client with mocked project registry and file system.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';

// --- Mocks ---

const mockProject = {
  dataDir: '/tmp/test-project/.hotsheet',
  name: 'Test Project',
  secret: 'test-secret-123',
  db: {
    query: vi.fn(() => Promise.resolve({ rows: [{ count: '5' }] })),
  },
  markdownSyncState: { worklistTimeout: null, openTicketsTimeout: null },
  backupTimers: { fiveMin: null, hourly: null, daily: null },
};

const mockProject2 = {
  dataDir: '/tmp/test-project-2/.hotsheet',
  name: 'Second Project',
  secret: 'test-secret-456',
  db: {
    query: vi.fn(() => Promise.resolve({ rows: [{ count: '3' }] })),
  },
  markdownSyncState: { worklistTimeout: null, openTicketsTimeout: null },
  backupTimers: { fiveMin: null, hourly: null, daily: null },
};

let mockProjects = [mockProject, mockProject2];

vi.mock('../projects.js', () => ({
  getAllProjects: vi.fn(() => mockProjects),
  getProjectBySecret: vi.fn((secret: string) => mockProjects.find(p => p.secret === secret)),
  registerProject: vi.fn(() => Promise.resolve(mockProject)),
  reorderProjects: vi.fn((secrets: string[]) => secrets.map(s => mockProjects.find(p => p.secret === s)?.dataDir ?? '')),
  unregisterProject: vi.fn(),
}));

vi.mock('../project-list.js', () => ({
  addToProjectList: vi.fn(),
  readProjectList: vi.fn(() => mockProjects.map(p => p.dataDir)),
  removeFromProjectList: vi.fn(),
  reorderProjectList: vi.fn(),
}));

vi.mock('../open-in-file-manager.js', () => ({
  openInFileManager: vi.fn(() => Promise.resolve()),
}));

vi.mock('../global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({})),
}));

vi.mock('../channel-config.js', () => ({
  isChannelAlive: vi.fn(() => Promise.resolve(false)),
  getChannelPort: vi.fn(() => null),
  registerChannel: vi.fn(),
}));

vi.mock('./notify.js', () => ({
  notifyChange: vi.fn(),
  addPermissionWaiter: vi.fn(),
  getPermissionVersion: vi.fn(() => 0),
  addBellWaiter: vi.fn(),
  getBellVersion: vi.fn(() => 0),
}));

const mockBellPending = new Map<string, Array<{ terminalId: string; message: string | null }>>();
const mockAliveTerminals: Array<{ secret: string; terminalId: string; rootPid: number }> = [];
const mockPendingPrompts = new Map<string, Array<{ terminalId: string; match: unknown }>>();
vi.mock('../terminals/registry.js', () => ({
  listBellPendingForProject: vi.fn((secret: string) => mockBellPending.get(secret) ?? []),
  listAliveTerminalsAcrossProjects: vi.fn(() => mockAliveTerminals),
  listPendingPromptsForProject: vi.fn((secret: string) => mockPendingPrompts.get(secret) ?? []),
}));

const mockConfiguredTerminals = new Map<string, Array<{ id: string; name?: string; command: string }>>();
const mockDynamicTerminals = new Map<string, Array<{ id: string; name?: string; command: string }>>();
vi.mock('../terminals/config.js', () => ({
  DEFAULT_TERMINAL_ID: 'default',
  listTerminalConfigs: vi.fn((dataDir: string) => {
    for (const project of mockProjects) {
      if (project.dataDir === dataDir) return mockConfiguredTerminals.get(project.secret) ?? [];
    }
    return [];
  }),
}));

vi.mock('./terminal.js', () => ({
  listDynamicTerminalConfigs: vi.fn((secret: string) => mockDynamicTerminals.get(secret) ?? []),
}));

vi.mock('../file-settings.js', () => ({
  readFileSettings: vi.fn(() => ({})),
}));

vi.mock('../terminals/processInspect.js', () => ({
  DEFAULT_EXEMPT_PROCESSES: ['screen', 'tmux', 'less', 'more', 'view', 'mandoc', 'tail', 'log', 'top', 'htop'],
  inspectForegroundProcess: vi.fn(() => Promise.resolve({
    command: 'zsh', isShell: true, isExempt: true, error: null,
  })),
}));

// Mock fs.existsSync to return true for our mock project dirs
vi.mock('fs', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('test-project')) return true;
      return actual.existsSync(path);
    }),
  };
});

const { projectRoutes } = await import('./projects.js');

let tempDir: string;
let app: Hono<AppEnv>;

beforeAll(async () => {
  tempDir = await setupTestDb();
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('dataDir', tempDir);
    c.set('projectSecret', 'test-secret-123');
    await next();
  });
  app.route('/api/projects', projectRoutes);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockProjects = [mockProject, mockProject2];
  mockAliveTerminals.length = 0;
  mockConfiguredTerminals.clear();
  mockDynamicTerminals.clear();
});

function post(body: unknown) {
  return {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// --- Tests ---

describe('GET /projects', () => {
  it('returns all registered projects with ticket counts', async () => {
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    const data = await res.json() as { name: string; secret: string; ticketCount: number }[];
    expect(data.length).toBe(2);
    expect(data[0].name).toBe('Test Project');
    expect(data[0].secret).toBe('test-secret-123');
    expect(data[0].ticketCount).toBe(5);
    expect(data[1].name).toBe('Second Project');
    expect(data[1].ticketCount).toBe(3);
  });

  it('prunes stale projects whose data dirs do not exist', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockImplementation((path: unknown) => {
      if (String(path).includes('test-project-2')) return false;
      return true;
    });

    const { removeFromProjectList } = await import('../project-list.js');
    const { unregisterProject } = await import('../projects.js');

    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);

    expect(removeFromProjectList).toHaveBeenCalledWith(mockProject2.dataDir);
    expect(unregisterProject).toHaveBeenCalledWith(mockProject2.secret);
  });
});

describe('POST /projects/register', () => {
  it('registers a new project and returns its info', async () => {
    const res = await app.request('/api/projects/register', post({ dataDir: '/tmp/new-project/.hotsheet' }));
    expect(res.status).toBe(201);
    const data = await res.json() as { name: string; secret: string };
    expect(data.name).toBe('Test Project');
    expect(data.secret).toBe('test-secret-123');

    const { addToProjectList } = await import('../project-list.js');
    expect(addToProjectList).toHaveBeenCalled();
  });

  it('returns 400 for invalid body', async () => {
    const res = await app.request('/api/projects/register', post({}));
    expect(res.status).toBe(400);
  });

  it('returns 500 when registration fails', async () => {
    const { registerProject } = await import('../projects.js');
    vi.mocked(registerProject).mockRejectedValueOnce(new Error('Lock conflict'));

    const res = await app.request('/api/projects/register', post({ dataDir: '/tmp/fail/.hotsheet' }));
    expect(res.status).toBe(500);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('Lock conflict');
  });
});

describe('DELETE /projects/:secret', () => {
  it('unregisters a project', async () => {
    const res = await app.request('/api/projects/test-secret-123', { method: 'DELETE' });
    expect(res.status).toBe(200);

    const { removeFromProjectList } = await import('../project-list.js');
    const { unregisterProject } = await import('../projects.js');
    expect(removeFromProjectList).toHaveBeenCalledWith(mockProject.dataDir);
    expect(unregisterProject).toHaveBeenCalledWith('test-secret-123');
  });

  it('returns 404 for unknown project', async () => {
    const res = await app.request('/api/projects/nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when trying to remove the last project', async () => {
    mockProjects = [mockProject]; // Only one project
    const res = await app.request('/api/projects/test-secret-123', { method: 'DELETE' });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toContain('only project');
  });
});

describe('GET /projects/channel-status', () => {
  it('returns enabled: false when channel is not enabled', async () => {
    const res = await app.request('/api/projects/channel-status');
    expect(res.status).toBe(200);
    const data = await res.json() as { enabled: boolean };
    expect(data.enabled).toBe(false);
  });

  it('returns per-project alive status when channel is enabled', async () => {
    const { readGlobalConfig } = await import('../global-config.js');
    vi.mocked(readGlobalConfig).mockReturnValueOnce({ channelEnabled: true });
    const { isChannelAlive } = await import('../channel-config.js');
    vi.mocked(isChannelAlive).mockResolvedValue(true);

    const res = await app.request('/api/projects/channel-status');
    expect(res.status).toBe(200);
    const data = await res.json() as { enabled: boolean; projects: Record<string, boolean> };
    expect(data.enabled).toBe(true);
    expect(data.projects['test-secret-123']).toBe(true);
  });
});

describe('POST /projects/:secret/reveal', () => {
  it('opens the project folder in file manager', async () => {
    const res = await app.request('/api/projects/test-secret-123/reveal', { method: 'POST' });
    expect(res.status).toBe(200);
    const { openInFileManager } = await import('../open-in-file-manager.js');
    expect(openInFileManager).toHaveBeenCalled();
  });

  it('returns 404 for unknown project', async () => {
    const res = await app.request('/api/projects/nonexistent/reveal', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('POST /projects/reorder', () => {
  it('reorders projects by secret', async () => {
    const res = await app.request('/api/projects/reorder', post({ secrets: ['test-secret-456', 'test-secret-123'] }));
    expect(res.status).toBe(200);

    const { reorderProjects } = await import('../projects.js');
    const { reorderProjectList } = await import('../project-list.js');
    expect(reorderProjects).toHaveBeenCalledWith(['test-secret-456', 'test-secret-123']);
    expect(reorderProjectList).toHaveBeenCalled();
  });

  it('returns 400 for invalid body', async () => {
    const res = await app.request('/api/projects/reorder', post({}));
    expect(res.status).toBe(400);
  });
});

// HS-6603 §24.3.3 — /api/projects/bell-state long-poll.
describe('GET /projects/bell-state', () => {
  beforeEach(() => {
    mockBellPending.clear();
    mockPendingPrompts.clear();
  });

  it('returns an aggregate map keyed by project secret, each with anyTerminalPending + terminalIds + notifications (HS-7264)', async () => {
    mockBellPending.set('test-secret-123', [
      { terminalId: 'default', message: null },
      { terminalId: 'second', message: 'Build done' },
    ]);
    mockBellPending.set('test-secret-456', []);

    // Use a high client version to avoid the long-poll path (fast version-ahead return).
    const { getBellVersion } = await import('./notify.js');
    (getBellVersion as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const res = await app.request('/api/projects/bell-state?v=0');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      bells: Record<string, { anyTerminalPending: boolean; terminalIds: string[]; notifications: Record<string, string> }>;
      v: number;
    };
    expect(body.bells['test-secret-123'].anyTerminalPending).toBe(true);
    expect(body.bells['test-secret-123'].terminalIds).toEqual(['default', 'second']);
    // HS-7264 — OSC 9 notification message is surfaced via the parallel
    // `notifications` map (terminalId -> message). Bell-only terminals (no
    // OSC 9) are absent from this map even though their id is in terminalIds.
    expect(body.bells['test-secret-123'].notifications).toEqual({ second: 'Build done' });
    expect(body.bells['test-secret-456'].anyTerminalPending).toBe(false);
    expect(body.bells['test-secret-456'].terminalIds).toEqual([]);
    expect(body.bells['test-secret-456'].notifications).toEqual({});
    expect(typeof body.v).toBe('number');
  });

  // HS-8034 Phase 2 — server-side scanner matches surface as the new
  // `pendingPrompts: { [terminalId]: MatchResult }` map per project. Empty
  // object when no prompts pending.
  it('includes pendingPrompts populated from listPendingPromptsForProject (HS-8034)', async () => {
    const numberedMatch = {
      parserId: 'claude-numbered',
      shape: 'numbered',
      question: 'Loading dev channels — security risk',
      questionLines: ['Loading dev channels — security risk'],
      choices: [
        { index: 0, label: 'I am using this for local development', highlighted: true },
        { index: 1, label: 'Exit', highlighted: false },
      ],
      signature: 'claude-numbered:abcd1234:0',
    };
    mockPendingPrompts.set('test-secret-123', [
      { terminalId: 'default', match: numberedMatch },
    ]);
    mockPendingPrompts.set('test-secret-456', []);

    const { getBellVersion } = await import('./notify.js');
    (getBellVersion as ReturnType<typeof vi.fn>).mockReturnValue(0);

    const res = await app.request('/api/projects/bell-state?v=0');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      bells: Record<string, { pendingPrompts: Record<string, unknown> }>;
    };
    expect(body.bells['test-secret-123'].pendingPrompts).toEqual({ default: numberedMatch });
    expect(body.bells['test-secret-456'].pendingPrompts).toEqual({});
  });

  it('returns immediately on the fast path when server bellVersion is ahead of the client cursor', async () => {
    const { getBellVersion } = await import('./notify.js');
    (getBellVersion as ReturnType<typeof vi.fn>).mockReturnValue(42);

    const start = Date.now();
    const res = await app.request('/api/projects/bell-state?v=10');
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // Fast path should return immediately — allow 500ms buffer to avoid flakiness
    // but still rule out the 3s long-poll timeout.
    expect(elapsed).toBeLessThan(500);
    const body = await res.json() as { v: number };
    expect(body.v).toBe(42);
  });
});

// HS-7596 / §37 — /api/projects/quit-summary aggregator.
describe('GET /projects/quit-summary', () => {
  it('labels dynamic terminals via the in-memory dynamic-config registry, not just the persisted list (HS-7789)', async () => {
    // Persisted (configured) terminals: a "default" terminal labelled "Claude".
    mockConfiguredTerminals.set('test-secret-123', [
      { id: 'default', name: 'Claude', command: 'claude' },
    ]);
    // Dynamic terminal: id is `dyn-…` and the label lives in the dynamic-config
    // registry (only). Pre-fix this would fall through to the raw id in the dialog.
    mockDynamicTerminals.set('test-secret-123', [
      { id: 'dyn-moews3gs-i9y3oh', name: 'Build', command: '/bin/zsh' },
    ]);
    mockAliveTerminals.push(
      { secret: 'test-secret-123', terminalId: 'default', rootPid: 1000 },
      { secret: 'test-secret-123', terminalId: 'dyn-moews3gs-i9y3oh', rootPid: 2000 },
    );

    const res = await app.request('/api/projects/quit-summary');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      projects: Array<{
        secret: string;
        entries: Array<{ terminalId: string; label: string; foregroundCommand: string }>;
      }>;
    };
    const target = body.projects.find(p => p.secret === 'test-secret-123');
    expect(target).toBeDefined();
    const dynamicEntry = target!.entries.find(e => e.terminalId === 'dyn-moews3gs-i9y3oh');
    expect(dynamicEntry).toBeDefined();
    expect(dynamicEntry!.label).toBe('Build');
    const persistedEntry = target!.entries.find(e => e.terminalId === 'default');
    expect(persistedEntry).toBeDefined();
    expect(persistedEntry!.label).toBe('Claude');
  });

  it('falls back to a friendly basename derived from the dynamic config command when name is omitted', async () => {
    // Dynamic terminal without an explicit name — the route should derive a
    // basename from the command (matches /create's friendlyShellName).
    mockDynamicTerminals.set('test-secret-123', [
      { id: 'dyn-abc', command: '/bin/zsh' },
    ]);
    mockAliveTerminals.push({ secret: 'test-secret-123', terminalId: 'dyn-abc', rootPid: 3000 });

    const res = await app.request('/api/projects/quit-summary');
    const body = await res.json() as {
      projects: Array<{ secret: string; entries: Array<{ terminalId: string; label: string }> }>;
    };
    const target = body.projects.find(p => p.secret === 'test-secret-123');
    const entry = target?.entries.find(e => e.terminalId === 'dyn-abc');
    expect(entry).toBeDefined();
    // Falls back to the command basename — `zsh` — not the raw id.
    expect(entry!.label).toBe('zsh');
  });
});
