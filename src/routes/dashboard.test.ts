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
  // HS-8910 — dashboard routes now ensure skills via the per-project helper.
  ensureSkillsForAllProjects: vi.fn(() => Promise.resolve(false)),
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
  // HS-8723 — git/status.ts (pulled in transitively) now `promisify`s
  // `execFile` at module load, so the mock must expose it as a function.
  execFile: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn(), on: vi.fn() })),
}));

const { dashboardRoutes, resolveGlassboxBinWith, buildGlassboxReviewArgs } = await import('./dashboard.js');

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

  /**
   * HS-8290 follow-up. The HS-8290 client code originally PATCHed
   * `/api/dashboard/global-config` (not `/api/global-config`) — that URL
   * 404s in production because `dashboardRoutes` is mounted at `/` inside
   * `apiRoutes`, NOT at `/dashboard`. The pre-existing client unit tests
   * passed because they only inspected the URL fetched, never the actual
   * server route. This regression test pins the working URL + asserts the
   * mistakenly-named URL is NOT a valid endpoint, so future drift is
   * caught here.
   */
  it('accepts the dashboard block at /api/global-config (HS-8290 regression)', async () => {
    const res = await app.request('/api/global-config', patch({
      dashboard: {
        layoutMode: 'flow',
        columnsPerRow: 3,
        visibilityGroupings: [{ id: 'default', name: 'Default', hiddenByProject: { 's1': ['t1'] } }],
        activeVisibilityGroupingId: 'default',
      },
    }));
    expect(res.status).toBe(200);
  });

  it('does NOT serve /api/dashboard/global-config (HS-8290 regression)', async () => {
    // The bug: client previously called `/api/dashboard/global-config` which
    // is a 404 — there's no `/dashboard` prefix on dashboardRoutes.
    const res = await app.request('/api/dashboard/global-config', patch({ dashboard: { layoutMode: 'flow' } }));
    expect(res.status).toBe(404);
  });

  /**
   * HS-8292 — pre-fix the schema enum was `['sectioned', 'flat']`, but the
   * client emits `'flow'` from `terminalDashboard.tsx::setLayoutMode`. Every
   * PATCH from the layout-toggle button silently 400'd, so flow mode never
   * persisted across reloads.
   */
  it('accepts layoutMode: "flow" (HS-8292)', async () => {
    // Pre-fix the schema enum was `['sectioned', 'flat']` so this PATCH
    // 400'd, the writeGlobalConfig mock never ran, and flow mode never
    // persisted. The dashboard test mocks writeGlobalConfig out, so the
    // round-trip GET assertion lives in `global-config.test.ts::layoutMode
    // round-trip`; here we just pin the validation gate.
    const res = await app.request('/api/global-config', patch({ dashboard: { layoutMode: 'flow' } }));
    expect(res.status).toBe(200);
  });

  it('accepts layoutMode: "sectioned" (HS-8292)', async () => {
    const res = await app.request('/api/global-config', patch({ dashboard: { layoutMode: 'sectioned' } }));
    expect(res.status).toBe(200);
  });

  it('rejects an unknown layoutMode value with 400 (HS-8292)', async () => {
    const res = await app.request('/api/global-config', patch({ dashboard: { layoutMode: 'flat' } }));
    expect(res.status).toBe(400);
  });

  /**
   * HS-8424 — HS-8406 added per-scope active-grouping selection on the
   * client (`activeVisibilityGroupingIdByScope`), but the server-side
   * `.strict()` schema didn't accept the key, so every visibility PATCH
   * after HS-8406 landed was rejected with 400 — no hide/show toggle
   * persisted across relaunches. The user reported the dashboard hide
   * action reverting after relaunch while inside the "Claude" grouping.
   */
  it('accepts dashboard.activeVisibilityGroupingIdByScope (HS-8424)', async () => {
    const res = await app.request('/api/global-config', patch({
      dashboard: {
        visibilityGroupings: [
          { id: 'default', name: 'Default', hiddenByProject: {} },
          { id: 'g-claude', name: 'Claude', hiddenByProject: { 's1': ['t1'] } },
        ],
        activeVisibilityGroupingIdByScope: { dashboard: 'g-claude' },
        activeVisibilityGroupingId: 'g-claude',
      },
    }));
    expect(res.status).toBe(200);
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

  it('reports available when `which` resolves the CLI (HS-8786)', async () => {
    const { execFileSync } = await import('child_process');
    vi.mocked(execFileSync).mockReturnValueOnce('/usr/local/bin/glassbox\n');
    const res = await app.request('/api/glassbox/status');
    const data = await res.json() as { available: boolean };
    expect(data.available).toBe(true);
  });
});

describe('POST /glassbox/launch', () => {
  it('launches the resolved glassbox CLI when available', async () => {
    const { execFileSync, spawn } = await import('child_process');
    vi.mocked(execFileSync).mockReturnValueOnce('/usr/local/bin/glassbox\n'); // `which` resolves it
    const res = await app.request('/api/glassbox/launch', { method: 'POST' });
    expect(res.status).toBe(200);
    const data = await res.json() as { ok: boolean };
    expect(data.ok).toBe(true);
    // Spawned the resolved ABSOLUTE path (HS-8786), not the bare name.
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe('/usr/local/bin/glassbox');
  });
  // The not-found → 404 path is covered deterministically by the
  // `resolveGlassboxBinWith` unit tests below (a route test would depend on
  // whether glassbox happens to be installed on the test machine).
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

// HS-8786 — the GUI-launchd-PATH fix: resolve `glassbox` via `which` (augmented
// PATH) then known install locations, so a bare-name lookup that fails under the
// minimal GUI PATH still finds the installed CLI.
describe('resolveGlassboxBinWith (HS-8786)', () => {
  const binDirs = ['/usr/local/bin', '/opt/homebrew/bin'];

  it('trusts a non-empty `which` result (which only returns existing executables)', () => {
    const bin = resolveGlassboxBinWith({
      which: () => '/opt/homebrew/bin/glassbox',
      fileExists: () => false, // not consulted for the which result
      binDirs,
    });
    expect(bin).toBe('/opt/homebrew/bin/glassbox');
  });

  it('falls back to a known install location when `which` fails (the GUI-PATH case)', () => {
    const bin = resolveGlassboxBinWith({
      which: () => null,                                  // not on the minimal GUI PATH
      fileExists: p => p === '/usr/local/bin/glassbox',   // but installed there
      binDirs,
    });
    expect(bin).toBe('/usr/local/bin/glassbox');
  });

  it('finds the macOS app-bundle CLI when nothing else matches', () => {
    const appBundle = '/Applications/Glassbox.app/Contents/Resources/resources/glassbox';
    const bin = resolveGlassboxBinWith({ which: () => null, fileExists: p => p === appBundle, binDirs });
    expect(bin).toBe(appBundle);
  });

  it('returns null when the CLI is not installed anywhere', () => {
    expect(resolveGlassboxBinWith({ which: () => null, fileExists: () => false, binDirs })).toBeNull();
  });
});

describe('buildGlassboxReviewArgs (HS-8472)', () => {
  it('maps a valid commit sha to --commit args', () => {
    expect(buildGlassboxReviewArgs({ mode: 'commit', sha: 'abc1234' })).toEqual(['--commit', 'abc1234']);
    expect(buildGlassboxReviewArgs({ mode: 'commit', sha: 'a'.repeat(40) })).toEqual(['--commit', 'a'.repeat(40)]);
  });

  it('rejects a non-hex or too-short sha', () => {
    expect(buildGlassboxReviewArgs({ mode: 'commit', sha: 'xyz1234' })).toBeNull();
    expect(buildGlassboxReviewArgs({ mode: 'commit', sha: 'abc' })).toBeNull(); // < 7 chars
    expect(buildGlassboxReviewArgs({ mode: 'commit', sha: '' })).toBeNull();
  });

  it('maps a valid range to --range from..to', () => {
    expect(buildGlassboxReviewArgs({ mode: 'range', from: 'origin/main', to: 'HEAD' }))
      .toEqual(['--range', 'origin/main..HEAD']);
  });

  it('rejects a flag-like ref (leading dash) so it cannot reach git as an option', () => {
    expect(buildGlassboxReviewArgs({ mode: 'range', from: '--upload-pack=evil', to: 'HEAD' })).toBeNull();
    expect(buildGlassboxReviewArgs({ mode: 'range', from: 'origin/main', to: '-x' })).toBeNull();
  });
});
