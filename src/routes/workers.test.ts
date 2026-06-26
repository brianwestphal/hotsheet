// HS-8969 — integration coverage for the worker-launch route
// (`POST /api/workers/launch`, docs/90 §90.5/§90.7) against a REAL temp git repo,
// mirroring `worktrees.test.ts`'s setup. The worker-loop core, launcher, and typed
// API are unit-tested elsewhere; this exercises the git-repo-gated route handler
// end to end (it derives repoRoot/ownerDataDir from the active project and shells
// out to real `git worktree add`). The multi-worker no-double-claim flow is proven
// at the DB layer in `workers/workerLoop.test.ts`, so it isn't repeated here.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { WorkerLaunchSpec } from '../api/workers.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { _resetPoolsForTesting, readyCount } from '../workers/poolManager.js';
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

// HS-9048 — owner-side branch integration endpoints against a real temp git repo.
describe('worker integration endpoints — real git (HS-9048)', () => {
  let base: string;
  let repoRoot: string;
  let ownerData: string;

  function commitFileOn(branch: string, file: string, content: string): void {
    execFileSync('git', ['checkout', '-q', '-B', branch], { cwd: repoRoot });
    writeFileSync(join(repoRoot, file), content);
    execFileSync('git', ['add', file], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', `work ${file}`], { cwd: repoRoot });
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hs-worker-integ-'));
    repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    gitInit(repoRoot);
    ownerData = join(repoRoot, '.hotsheet');
    mkdirSync(ownerData, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    _resetPoolsForTesting();
  });

  it('GET /api/workers/integratable lists ready hotsheet/* branches + the target', async () => {
    commitFileOn('hotsheet/worker-1', 'a.txt', 'a\n');
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });

    const res = await appFor(ownerData).request('/api/workers/integratable');
    expect(res.status).toBe(200);
    const data = await res.json() as { target: string; branches: { branch: string; ahead: number }[] };
    expect(data.target).toBe('main');
    expect(data.branches.map(b => b.branch)).toEqual(['hotsheet/worker-1']);
  });

  it('POST /api/workers/integrate merges a ready branch into the target', async () => {
    commitFileOn('hotsheet/worker-1', 'a.txt', 'a\n');
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });

    const res = await appFor(ownerData).request('/api/workers/integrate', post({ branch: 'hotsheet/worker-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'merged' });
    expect(execFileSync('git', ['log', '--oneline', 'main'], { cwd: repoRoot, encoding: 'utf-8' })).toContain('work a.txt');
  });

  it('returns 400 on a non-git project', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'hs-integ-nogit-'));
    try {
      const res = await appFor(nonGit).request('/api/workers/integratable');
      expect(res.status).toBe(400);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  // HS-9090 — the explicit "branch ready" signal + its clear-on-integrate.
  it('POST /api/workers/ready sets a worker\'s ready signal; integrating the branch clears it', async () => {
    const app = appFor(ownerData);
    // Register a pool worker, then signal its branch ready.
    await app.request('/api/workers/pool/register', post({ label: 'worker-1', worker: 'w1', worktreePath: '/wt/w1' }));
    const readyRes = await app.request('/api/workers/ready', post({ worker: 'w1', branch: 'hotsheet/worker-1' }));
    expect(readyRes.status).toBe(200);
    expect(readyCount(ownerData)).toBe(1);

    // Merge the branch — the integrate route clears the ready signal for it.
    commitFileOn('hotsheet/worker-1', 'a.txt', 'a\n');
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
    const intRes = await app.request('/api/workers/integrate', post({ branch: 'hotsheet/worker-1' }));
    expect((await intRes.json() as { status: string }).status).toBe('merged');
    expect(readyCount(ownerData)).toBe(0);
  });

  it('POST /api/workers/ready returns 404 for an unregistered worker', async () => {
    const res = await appFor(ownerData).request('/api/workers/ready', post({ worker: 'ghost', branch: 'hotsheet/x' }));
    expect(res.status).toBe(404);
  });

  // HS-9076 — the server reconcile endpoint (the no-UI scaling trigger).
  it('POST /api/workers/pool/reconcile is a no-op at target 0 (no workers spawned)', async () => {
    const res = await appFor(ownerData).request('/api/workers/pool/reconcile', post({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ spawned: 0, drained: 0, reaped: 0, targetN: 0 });
  });

  it('POST /api/workers/pool/reconcile returns 400 on a non-git project', async () => {
    const nonGit = mkdtempSync(join(tmpdir(), 'hs-reconcile-nogit-'));
    try {
      const res = await appFor(nonGit).request('/api/workers/pool/reconcile', post({}));
      expect(res.status).toBe(400);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  // HS-9081 (docs/102 §102.3) — the pool poll folds in the per-worktree git summary.
  it('GET /api/workers/pool includes a per-worker git summary (ahead/behind/dirty)', async () => {
    // The pool route reads live claims, so it needs the DB connection up.
    const dbDir = await setupTestDb();
    try {
      const app = appFor(ownerData);
      // A worker branch one commit ahead of main, then back on main; leave the
      // (owner) worktree dirty so the porcelain check trips.
      commitFileOn('hotsheet/worker-1', 'a.txt', 'a\n');
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: repoRoot });
      writeFileSync(join(repoRoot, 'scratch.txt'), 'wip\n');
      // Register a worker whose worktree is the repo root + branch is that worker branch.
      await app.request('/api/workers/pool/register', post({ label: 'worker-1', worker: 'w1', worktreePath: repoRoot, branch: 'hotsheet/worker-1' }));

      const res = await app.request('/api/workers/pool');
      expect(res.status).toBe(200);
      const data = await res.json() as { target?: string | null; workers: { worker: string; git?: { ahead: number; behind: number; dirty: boolean } }[] };
      const w1 = data.workers.find(w => w.worker === 'w1');
      expect(w1?.git).toEqual({ ahead: 1, behind: 0, dirty: true });
      // HS-9082 — the integration target is surfaced so the panel can build the
      // "diff worker branch vs target" Glassbox review range.
      expect(data.target).toBe('main');
    } finally {
      await cleanupTestDb(dbDir);
    }
  });
});
