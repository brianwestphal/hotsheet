/**
 * HS-9549 — the HTTP boundary of the worktree routes (docs/89 Phase B).
 *
 * ## What this does and does not cover
 *
 * The worktree LOGIC — create, list, remove, `deleteBranch`, the follower pointer,
 * `node_modules` provisioning — is already covered by `src/worktrees.test.ts`. This
 * file covers what that one cannot: the route layer, which was at 12 % statements
 * and **0 % branches** with no test file at all.
 *
 * That layer is thin but not trivial. Each of the three handlers has the same four
 * outcomes — not-a-git-repo, malformed body, success, and a throwing helper mapped
 * to a 500 — and getting any of them wrong turns a recoverable error into either a
 * crash or a silent success. The `isGitRepo` guard in particular is the only thing
 * standing between "wrong directory" and shelling out `git worktree` somewhere the
 * user did not mean.
 *
 * The helpers are mocked deliberately. Driving real `git worktree` through the
 * routes would re-test `worktrees.test.ts`'s territory at ten times the cost, and
 * would make the error-mapping cases (which need a helper that throws on demand)
 * awkward to arrange. What is under test here is the wiring, so the wiring is what
 * is real and the work is what is faked.
 */
import { mkdtempSync, rmSync } from 'fs';
import { Hono } from 'hono';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppEnv } from '../types.js';

interface RemoveOpts { force?: boolean; deleteBranch?: boolean }

const isGitRepo = vi.fn<(root: string) => boolean>();
const listWorktrees = vi.fn<(repoRoot: string) => Promise<unknown>>();
const createWorktree = vi.fn<(repoRoot: string, dataDir: string, req: unknown) => Promise<unknown>>();
const removeWorktree = vi.fn<(repoRoot: string, path: string, opts: RemoveOpts) => Promise<void>>();

vi.mock('../gitignore.js', () => ({ isGitRepo: (root: string) => isGitRepo(root) }));
vi.mock('../worktrees.js', () => ({
  listWorktrees: (repoRoot: string) => listWorktrees(repoRoot),
  createWorktree: (repoRoot: string, dataDir: string, req: unknown) => createWorktree(repoRoot, dataDir, req),
  removeWorktree: (repoRoot: string, path: string, opts: RemoveOpts) => removeWorktree(repoRoot, path, opts),
}));

let app: Hono<AppEnv>;
let dataDir: string;

interface ErrorResponse { error: string }

beforeEach(async () => {
  vi.clearAllMocks();
  isGitRepo.mockReturnValue(true);
  // A `.hotsheet` data dir, so `projectRootFromDataDir` has something to strip —
  // the repo root the handlers pass to git is the PARENT, and that derivation is
  // part of what these tests pin.
  dataDir = join(mkdtempSync(join(tmpdir(), 'hs-wt-routes-')), '.hotsheet');
  const { worktreeRoutes } = await import('./worktrees.js');
  app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('dataDir', dataDir); await next(); });
  app.route('/api', worktreeRoutes);
});

afterEach(() => {
  rmSync(join(dataDir, '..'), { recursive: true, force: true });
});

const post = (path: string, body: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('the not-a-git-repo guard', () => {
  it('refuses all three routes with 400, and never reaches git', async () => {
    // The guard that matters most: without it these handlers would shell out
    // `git worktree` against whatever directory the project happens to sit in.
    isGitRepo.mockReturnValue(false);

    for (const res of [
      await app.request('/api/worktrees'),
      await post('/api/worktrees', { branch: 'feature/x' }),
      await post('/api/worktrees/remove', { path: '/tmp/whatever' }),
    ]) {
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorResponse).error).toBe('Not a git repository');
    }

    expect(listWorktrees).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    // The one that would have been destructive.
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('derives the repo root by stripping `.hotsheet` from the data dir', async () => {
    // A wrong derivation here points every git call at the data dir instead of the
    // repo, which fails confusingly rather than loudly.
    await app.request('/api/worktrees');
    expect(isGitRepo).toHaveBeenCalledWith(join(dataDir, '..'));
  });
});

describe('GET /api/worktrees', () => {
  it('returns the list', async () => {
    const entries = [{ path: '/repo', branch: 'main', isMain: true }];
    listWorktrees.mockResolvedValue(entries);
    const res = await app.request('/api/worktrees');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(entries);
  });

  it('maps a throwing helper to a 500 carrying the message, not a crash', async () => {
    listWorktrees.mockRejectedValue(new Error('git exploded'));
    const res = await app.request('/api/worktrees');
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorResponse).error).toBe('git exploded');
  });

  it('reports an empty repo as an empty list, not an error', async () => {
    listWorktrees.mockResolvedValue([]);
    const res = await app.request('/api/worktrees');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe('POST /api/worktrees', () => {
  it('passes the validated body through and returns the created info', async () => {
    const info = { path: '/repo-worktrees/feature-x', branch: 'feature/x' };
    createWorktree.mockResolvedValue(info);
    const res = await post('/api/worktrees', { branch: 'feature/x' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(info);
    expect(createWorktree).toHaveBeenCalledWith(
      join(dataDir, '..'), dataDir, expect.objectContaining({ branch: 'feature/x' }),
    );
  });

  it('rejects a body that fails the schema with 400, without calling git', async () => {
    const res = await post('/api/worktrees', { notABranch: 1 });
    expect(res.status).toBe(400);
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('maps a creation failure to 500 with the reason', async () => {
    // e.g. the branch already has a worktree — the user needs to see why.
    createWorktree.mockRejectedValue(new Error("branch 'feature/x' is already checked out"));
    const res = await post('/api/worktrees', { branch: 'feature/x' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorResponse).error).toContain('already checked out');
  });
});

describe('POST /api/worktrees/remove', () => {
  it('forwards force + deleteBranch rather than dropping them', async () => {
    // These two flags decide whether uncommitted work is discarded and whether a
    // branch disappears. Silently dropping either is the destructive failure mode,
    // and a handler that ignored them would still return a cheerful `{ok:true}`.
    removeWorktree.mockResolvedValue(undefined);
    const res = await post('/api/worktrees/remove', {
      path: '/repo-worktrees/feature-x', force: true, deleteBranch: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(removeWorktree).toHaveBeenCalledWith(
      join(dataDir, '..'), '/repo-worktrees/feature-x', { force: true, deleteBranch: true },
    );
  });

  it('defaults force and deleteBranch to undefined when omitted — no accidental force', async () => {
    removeWorktree.mockResolvedValue(undefined);
    await post('/api/worktrees/remove', { path: '/repo-worktrees/feature-x' });
    expect(removeWorktree).toHaveBeenCalledWith(
      join(dataDir, '..'), '/repo-worktrees/feature-x', { force: undefined, deleteBranch: undefined },
    );
  });

  it('rejects a body with no path, without calling remove', async () => {
    const res = await post('/api/worktrees/remove', { force: true });
    expect(res.status).toBe(400);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('surfaces a refusal from git as a 500 instead of reporting success', async () => {
    // `git worktree remove` refuses a dirty tree unless forced. The handler must
    // NOT swallow that into `{ok:true}` — the user would believe work was removed
    // cleanly when it was not removed at all.
    removeWorktree.mockRejectedValue(new Error('contains modified or untracked files'));
    const res = await post('/api/worktrees/remove', { path: '/repo-worktrees/feature-x' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as ErrorResponse).error).toContain('modified or untracked');
  });
});
