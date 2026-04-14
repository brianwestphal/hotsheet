/**
 * HS-5549: unit tests for routes/dashboard.ts.
 * Uses Hono test client with mocked external dependencies.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';

// --- Mocks ---

vi.mock('../projects.js', () => ({
  getAllProjects: vi.fn(() => []),
  getProjectBySecret: vi.fn(() => null),
}));

vi.mock('../skills.js', () => ({
  ensureSkillsForDir: vi.fn(),
  consumeSkillsCreatedFlag: vi.fn(() => false),
}));

vi.mock('../open-in-file-manager.js', () => ({
  openInFileManager: vi.fn(() => Promise.resolve()),
}));

vi.mock('../gitignore.js', () => ({
  isGitRepo: vi.fn(() => true),
  isHotsheetGitignored: vi.fn(() => false),
  ensureGitignore: vi.fn(),
}));

vi.mock('../global-config.js', () => ({
  readGlobalConfig: vi.fn(() => ({ someKey: 'someValue' })),
  writeGlobalConfig: vi.fn((data: Record<string, unknown>) => data),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const { dashboardRoutes } = await import('./dashboard.js');

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
  app.route('/api', dashboardRoutes);
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

beforeEach(() => {
  vi.clearAllMocks();
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

// --- Tests ---

describe('GET /stats', () => {
  it('returns ticket stats', async () => {
    const res = await app.request('/api/stats');
    expect(res.status).toBe(200);
    const data = await res.json() as { total: number; open: number; up_next: number };
    expect(typeof data.total).toBe('number');
    expect(typeof data.open).toBe('number');
    expect(typeof data.up_next).toBe('number');
  });
});

describe('GET /dashboard', () => {
  it('returns dashboard stats with snapshots', async () => {
    const res = await app.request('/api/dashboard');
    expect(res.status).toBe(200);
    const data = await res.json() as { snapshots: unknown[] };
    expect(Array.isArray(data.snapshots)).toBe(true);
  });

  it('accepts a days parameter', async () => {
    const res = await app.request('/api/dashboard?days=7');
    expect(res.status).toBe(200);
  });
});

describe('GET /worklist-info', () => {
  it('returns worklist prompt and skillCreated flag', async () => {
    const res = await app.request('/api/worklist-info');
    expect(res.status).toBe(200);
    const data = await res.json() as { prompt: string; skillCreated: boolean };
    expect(typeof data.prompt).toBe('string');
    expect(data.prompt).toContain('worklist.md');
    expect(typeof data.skillCreated).toBe('boolean');
  });
});

describe('GET /browse', () => {
  it('returns directory listing for a valid path', async () => {
    const res = await app.request('/api/browse?path=' + encodeURIComponent(tempDir));
    expect(res.status).toBe(200);
    const data = await res.json() as { path: string; entries: unknown[] };
    expect(data.path).toBe(tempDir);
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('returns 404 for non-existent path', async () => {
    const res = await app.request('/api/browse?path=/nonexistent/path/that/does/not/exist');
    expect(res.status).toBe(404);
  });

  it('includes parent path and hasHotsheet flag', async () => {
    const res = await app.request('/api/browse?path=' + encodeURIComponent(tempDir));
    expect(res.status).toBe(200);
    const data = await res.json() as { parent: string | null; hasHotsheet: boolean };
    expect(typeof data.hasHotsheet).toBe('boolean');
  });
});

describe('GET /global-config', () => {
  it('returns global config', async () => {
    const res = await app.request('/api/global-config');
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.someKey).toBe('someValue');
  });
});

describe('PATCH /global-config', () => {
  it('writes and returns merged global config', async () => {
    const res = await app.request('/api/global-config', patch({ channelEnabled: true }));
    expect(res.status).toBe(200);
    const { writeGlobalConfig } = await import('../global-config.js');
    expect(writeGlobalConfig).toHaveBeenCalled();
  });

  it('returns 400 for invalid body', async () => {
    const res = await app.request('/api/global-config', patch({ unknownKey: 'bad' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /ensure-skills', () => {
  it('ensures skills for all projects', async () => {
    const res = await app.request('/api/ensure-skills', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { updated: boolean };
    expect(typeof data.updated).toBe('boolean');
  });
});

describe('GET /glassbox/status', () => {
  it('returns availability status', async () => {
    const res = await app.request('/api/glassbox/status');
    expect(res.status).toBe(200);
    const data = await res.json() as { available: boolean };
    expect(typeof data.available).toBe('boolean');
  });
});

describe('POST /glassbox/launch', () => {
  it('launches glassbox when available', async () => {
    // First call /status to set glassboxAvailable = true (mocked execFileSync succeeds)
    await app.request('/api/glassbox/status');

    const res = await app.request('/api/glassbox/launch', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
  });
});

describe('GET /gitignore/status', () => {
  it('returns gitignore status', async () => {
    const res = await app.request('/api/gitignore/status');
    expect(res.status).toBe(200);
    const data = await res.json() as { inGitRepo: boolean; ignored: boolean };
    expect(data.inGitRepo).toBe(true);
    expect(typeof data.ignored).toBe('boolean');
  });

  it('returns inGitRepo: false when not in a git repo', async () => {
    const { isGitRepo } = await import('../gitignore.js');
    vi.mocked(isGitRepo).mockReturnValueOnce(false);
    const res = await app.request('/api/gitignore/status');
    expect(res.status).toBe(200);
    const data = await res.json() as { inGitRepo: boolean; ignored: boolean };
    expect(data.inGitRepo).toBe(false);
  });
});

describe('POST /gitignore/add', () => {
  it('calls ensureGitignore', async () => {
    const res = await app.request('/api/gitignore/add', { method: 'POST' });
    expect(res.status).toBe(200);
    const { ensureGitignore } = await import('../gitignore.js');
    expect(ensureGitignore).toHaveBeenCalled();
  });
});

describe('POST /print', () => {
  it('writes HTML to temp file and opens it', async () => {
    const res = await app.request('/api/print', post({ html: '<h1>Test</h1>' }));
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean; path: string };
    expect(data.ok).toBe(true);
    expect(data.path).toContain('hotsheet-print-');
    const { openInFileManager } = await import('../open-in-file-manager.js');
    expect(openInFileManager).toHaveBeenCalled();
  });

  it('returns 400 for missing html body', async () => {
    const res = await app.request('/api/print', post({}));
    expect(res.status).toBe(400);
  });
});
