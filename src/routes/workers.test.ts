// HS-8969 — integration coverage for the worker-launch route
// (`POST /api/workers/launch`, docs/90 §90.5/§90.7) against a REAL temp git repo,
// mirroring `worktrees.test.ts`'s setup. The worker-loop core, launcher, and typed
// API are unit-tested elsewhere; this exercises the git-repo-gated route handler
// end to end (it derives repoRoot/ownerDataDir from the active project and shells
// out to real `git worktree add`). The multi-worker no-double-claim flow is proven
// at the DB layer in `workers/workerLoop.test.ts`, so it isn't repeated here.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkerLaunchSpec } from '../api/workers.js';
import type { AppEnv } from '../types.js';
import { listWorktrees } from '../worktrees.js';
import { workerRoutes } from './workers.js';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
}

/** Build a Hono app that serves the worker routes with `dataDir` set to `dataDir`. */
function appFor(dataDir: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('dataDir', dataDir); await next(); });
  app.route('/api', workerRoutes);
  return app;
}

function post(body: unknown) {
  return { method: 'POST' as const, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

describe('POST /api/workers/launch — real git (HS-8969)', () => {
  let base: string;
  let repoRoot: string;
  let ownerData: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hs-worker-launch-'));
    repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    gitInit(repoRoot);
    ownerData = join(repoRoot, '.hotsheet');
    mkdirSync(ownerData, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates a follower worktree and returns the launch spec for {branch}', async () => {
    const app = appFor(ownerData);
    const res = await app.request('/api/workers/launch', post({ branch: 'feature-x' }));
    expect(res.status).toBe(200);
    const spec = await res.json() as WorkerLaunchSpec;
    expect(spec.worker).toBe('feature-x');
    expect(spec.label).toBe('feature-x');
    expect(spec.command).toBe('claude "/hotsheet-worker"');
    expect(spec.worktreeCreated).toBe(true);
    expect(spec.cwd).not.toBe(repoRoot);

    // A real follower worktree now exists, pointing back at the owner .hotsheet.
    const list = await listWorktrees(repoRoot);
    expect(list).toHaveLength(2);
    const follower = list.find(w => w.branch === 'feature-x');
    expect(follower).toBeDefined();
    expect(resolve(follower!.path)).toBe(resolve(spec.cwd));
    expect(follower!.authoritativeDataDir).toBe(resolve(ownerData));
  });

  it('returns 400 when the project is not a git repository', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'hs-worker-nogit-'));
    try {
      const app = appFor(join(nonGit, '.hotsheet'));
      const res = await app.request('/api/workers/launch', post({ branch: 'x' }));
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toMatch(/not a git repository/i);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it('refuses to run a worker in the main worktree (400)', async () => {
    const app = appFor(ownerData);
    const res = await app.request('/api/workers/launch', post({ worktreePath: repoRoot }));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/main worktree/i);
  });

  it('returns 400 when neither branch nor worktreePath is given', async () => {
    const app = appFor(ownerData);
    const res = await app.request('/api/workers/launch', post({}));
    expect(res.status).toBe(400);
  });
});
