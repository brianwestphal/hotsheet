/**
 * HS-8561 — unit coverage for `src/routes/git.ts`. Pre-fix coverage was
 * 10.52%; this suite exercises every public route handler + the
 * exported `projectRootFromDataDir` pure helper. Server-side mocks
 * cover the four external surfaces the routes call into:
 *
 *   - file-settings.readFileSettings → controls the
 *     git_tracking_enabled opt-out branch
 *   - git/watcher.ensureGitWatcher / getCachedGitStatus /
 *     dropGitStatusCache → drives the status + cache-drop paths
 *   - git/status.getGitStatusFiles / runGitFetch → drives the
 *     files=true opt-in + the fetch handler
 *   - gitignore.getGitRoot + open-in-file-manager.openInFileManager
 *     → drives the reveal handler's path-resolve + invocation paths
 *
 * Tests assert on JSON response shapes (not internal mock call counts
 * where they're not the user-visible contract) so a refactor that
 * preserves behavior can change the helper wiring without rewriting
 * tests.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

// --- Mocks ---
// Each external dependency is a `vi.fn` so individual tests can stub
// the per-call return value via `mock.mockReturnValue(...)`. Explicit
// return-type annotations keep `@typescript-eslint/no-unsafe-return`
// quiet (vi.fn defaults to `any`).

const mockGitStatus = vi.fn<(root: string) => unknown>();
const mockGitFiles = vi.fn<(root: string) => unknown>();
const mockRunGitFetch = vi.fn<(root: string) => unknown>();
const mockDropCache = vi.fn<(root: string) => void>();
const mockEnsureWatcher = vi.fn<(root: string) => void>();
const mockGetGitRoot = vi.fn<(root: string) => string | null>();
const mockOpenInFileManager = vi.fn<(path: string) => Promise<void>>();
const mockReadFileSettings = vi.fn<(dir: string) => Record<string, unknown>>();

vi.mock('../file-settings.js', () => ({
  readFileSettings: (dataDir: string): Record<string, unknown> => mockReadFileSettings(dataDir),
}));

vi.mock('../git/status.js', () => ({
  getGitStatusFiles: (root: string): unknown => mockGitFiles(root),
  runGitFetch: (root: string): unknown => mockRunGitFetch(root),
}));

vi.mock('../git/watcher.js', () => ({
  dropGitStatusCache: (root: string): void => mockDropCache(root),
  ensureGitWatcher: (root: string): void => mockEnsureWatcher(root),
  getCachedGitStatus: (root: string): unknown => mockGitStatus(root),
}));

vi.mock('../gitignore.js', () => ({
  getGitRoot: (root: string): string | null => mockGetGitRoot(root),
}));

vi.mock('../open-in-file-manager.js', () => ({
  openInFileManager: (path: string): Promise<void> => mockOpenInFileManager(path),
}));

// Import AFTER mocks so the routes module picks up the mocked deps.
const { gitRoutes, projectRootFromDataDir } = await import('./git.js');

function buildApp(dataDir = '/tmp/proj/.hotsheet'): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', (c, next) => {
    c.set('dataDir', dataDir);
    return next();
  });
  app.route('/api', gitRoutes);
  return app;
}

beforeEach(() => {
  mockGitStatus.mockReset();
  mockGitFiles.mockReset();
  mockRunGitFetch.mockReset();
  mockDropCache.mockReset();
  mockEnsureWatcher.mockReset();
  mockGetGitRoot.mockReset();
  mockOpenInFileManager.mockReset();
  mockReadFileSettings.mockReset().mockReturnValue({}); // default: tracking enabled (no opt-out)
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('projectRootFromDataDir', () => {
  it('strips the trailing `.hotsheet` segment', () => {
    expect(projectRootFromDataDir('/tmp/proj/.hotsheet')).toBe('/tmp/proj');
  });

  it('strips a trailing `.hotsheet/` (with slash)', () => {
    expect(projectRootFromDataDir('/tmp/proj/.hotsheet/')).toBe('/tmp/proj');
  });

  it('handles a Windows-style path separator', () => {
    expect(projectRootFromDataDir('C:\\Users\\me\\proj\\.hotsheet')).toBe('C:\\Users\\me\\proj');
  });

  it('returns the input unchanged when there is no `.hotsheet` suffix', () => {
    // Defensive: callers always pass a dataDir, but pin the no-op shape.
    expect(projectRootFromDataDir('/tmp/proj')).toBe('/tmp/proj');
  });
});

describe('GET /git/status', () => {
  it('returns null when git_tracking_enabled is false (per-project opt-out)', async () => {
    mockReadFileSettings.mockReturnValue({ git_tracking_enabled: false });
    const res = await buildApp().request('/api/git/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    // Watcher should NOT be wired up when tracking is disabled.
    expect(mockEnsureWatcher).not.toHaveBeenCalled();
  });

  it('returns null when getCachedGitStatus returns null (non-git repo or git missing)', async () => {
    mockGitStatus.mockReturnValue(null);
    const res = await buildApp().request('/api/git/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    // Watcher IS set up even when status is null — the first read may have
    // landed before any git activity.
    expect(mockEnsureWatcher).toHaveBeenCalledWith('/tmp/proj');
  });

  it('returns the cached status JSON on the happy path', async () => {
    const status = { branch: 'main', dirty: 3, ahead: 1, behind: 0, hasUpstream: true };
    mockGitStatus.mockReturnValue(status);
    const res = await buildApp().request('/api/git/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
    expect(mockGitFiles).not.toHaveBeenCalled();
  });

  it('includes per-bucket file lists when `?files=true` is passed (HS-7956 popover)', async () => {
    const status = { branch: 'main', dirty: 1, ahead: 0, behind: 0, hasUpstream: true };
    const files = { modified: ['src/foo.ts'], staged: [], untracked: [], deleted: [] };
    mockGitStatus.mockReturnValue(status);
    mockGitFiles.mockReturnValue(files);
    const res = await buildApp().request('/api/git/status?files=true');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...status, files });
    expect(mockGitFiles).toHaveBeenCalledWith('/tmp/proj');
  });

  it('uses the request-context dataDir to compute the project root', async () => {
    mockGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await buildApp('/tmp/other/.hotsheet').request('/api/git/status');
    expect(mockGitStatus).toHaveBeenCalledWith('/tmp/other');
    expect(mockEnsureWatcher).toHaveBeenCalledWith('/tmp/other');
  });

  it('does NOT call getGitStatusFiles when `?files=` is anything other than `true`', async () => {
    mockGitStatus.mockReturnValue({ branch: 'main', dirty: 0, ahead: 0, behind: 0, hasUpstream: true });
    await buildApp().request('/api/git/status?files=1');
    expect(mockGitFiles).not.toHaveBeenCalled();
  });
});

describe('POST /git/fetch', () => {
  it('returns ok:false + a friendly hint when git_tracking_enabled is false', async () => {
    mockReadFileSettings.mockReturnValue({ git_tracking_enabled: false });
    const res = await buildApp().request('/api/git/fetch', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, lastFetchedAt: null, error: 'git tracking disabled in settings' });
    expect(mockRunGitFetch).not.toHaveBeenCalled();
    expect(mockDropCache).not.toHaveBeenCalled();
  });

  it('drops the status cache on successful fetch', async () => {
    const result = { ok: true, lastFetchedAt: '2026-05-23T00:00:00.000Z' };
    mockRunGitFetch.mockReturnValue(result);
    const res = await buildApp().request('/api/git/fetch', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockDropCache).toHaveBeenCalledWith('/tmp/proj');
  });

  it('does NOT drop the cache when the fetch fails', async () => {
    const result = { ok: false, lastFetchedAt: null, error: 'no upstream configured' };
    mockRunGitFetch.mockReturnValue(result);
    const res = await buildApp().request('/api/git/fetch', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(result);
    expect(mockDropCache).not.toHaveBeenCalled();
  });

  it('returns the raw result object verbatim (no shape transformation)', async () => {
    const result = { ok: true, lastFetchedAt: '2026-05-23T00:00:00.000Z', extra: 'field-passes-through' };
    mockRunGitFetch.mockReturnValue(result);
    const res = await buildApp().request('/api/git/fetch', { method: 'POST' });
    expect(await res.json()).toEqual(result);
  });
});

describe('POST /git/reveal', () => {
  it('returns 400 when the body has no `path`', async () => {
    const res = await buildApp().request('/api/git/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'Invalid path' });
    expect(mockOpenInFileManager).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is empty / not JSON', async () => {
    const res = await buildApp().request('/api/git/reveal', { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'Invalid path' });
    expect(mockOpenInFileManager).not.toHaveBeenCalled();
  });

  it('returns 400 for a `..`-traversal path (privilege-boundary guard)', async () => {
    const res = await buildApp().request('/api/git/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '../etc/passwd' }),
    });
    expect(res.status).toBe(400);
    expect(mockOpenInFileManager).not.toHaveBeenCalled();
  });

  it('returns 400 for any path containing `..` anywhere (defensive)', async () => {
    const res = await buildApp().request('/api/git/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'src/..secret/file.txt' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an absolute path (slash-leading guard)', async () => {
    const res = await buildApp().request('/api/git/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    expect(res.status).toBe(400);
    expect(mockOpenInFileManager).not.toHaveBeenCalled();
  });

  it('opens the resolved (gitRoot-joined) path on the happy path', async () => {
    mockGetGitRoot.mockReturnValue('/tmp/proj');
    mockOpenInFileManager.mockResolvedValue(undefined);
    const res = await buildApp().request('/api/git/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'src/foo.ts' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockOpenInFileManager).toHaveBeenCalledWith('/tmp/proj/src/foo.ts');
  });

  it('falls back to the project root when getGitRoot returns null (non-git project)', async () => {
    mockGetGitRoot.mockReturnValue(null);
    mockOpenInFileManager.mockResolvedValue(undefined);
    const res = await buildApp('/tmp/fallback/.hotsheet').request('/api/git/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'README.md' }),
    });
    expect(res.status).toBe(200);
    expect(mockOpenInFileManager).toHaveBeenCalledWith('/tmp/fallback/README.md');
  });
});
