import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFileSettings } from './file-settings.js';
import {
  createWorktree, defaultWorktreePath, isFollowerWorktree,
  listWorktrees, parseWorktreeList, removeWorktree,
} from './worktrees.js';

// HS-8935 — git worktree management (docs/89-git-worktrees.md Phase B).

describe('parseWorktreeList', () => {
  it('parses main + branch + detached entries', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaaa1111',
      'branch refs/heads/main',
      '',
      'worktree /repo-worktrees/feature',
      'HEAD bbbb2222',
      'branch refs/heads/feature-x',
      '',
      'worktree /repo-worktrees/detached',
      'HEAD cccc3333',
      'detached',
      '',
    ].join('\n');
    const out = parseWorktreeList(porcelain);
    expect(out).toEqual([
      { path: '/repo', head: 'aaaa1111', branch: 'main' },
      { path: '/repo-worktrees/feature', head: 'bbbb2222', branch: 'feature-x' },
      { path: '/repo-worktrees/detached', head: 'cccc3333', branch: null },
    ]);
  });

  it('returns [] for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('defaultWorktreePath', () => {
  it('is a sibling <repo>-worktrees/<branch> with slashes sanitized', () => {
    expect(defaultWorktreePath('/a/b/myrepo', 'feature/x')).toBe(resolve('/a/b', 'myrepo-worktrees', 'feature-x'));
  });
});

// Real-git integration — git is available in CI. Drives an actual temp repo so
// the create/list/remove + follower-pointer behavior is exercised end to end.
describe('worktrees — real git', () => {
  let base: string;
  let repoRoot: string;
  let ownerData: string;

  function gitInit(dir: string): void {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hs-wt-git-'));
    repoRoot = join(base, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    gitInit(repoRoot);
    ownerData = join(repoRoot, '.hotsheet');
    mkdirSync(ownerData, { recursive: true });
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('creates a follower worktree (pointer written), lists it, removes it', async () => {
    const wt = await createWorktree(repoRoot, ownerData, { branch: 'feature-x', newBranch: true });
    expect(wt.branch).toBe('feature-x');
    expect(wt.authoritativeDataDir).toBe(resolve(ownerData));

    // The follower pointer was written into the worktree's .hotsheet.
    const ptr = readFileSettings(join(wt.path, '.hotsheet')).authoritativeDataDir;
    expect(ptr !== undefined && resolve(ptr)).toBe(resolve(ownerData));
    expect(isFollowerWorktree(wt.path)).toBe(true);
    expect(isFollowerWorktree(repoRoot)).toBe(false); // owner is not a follower

    // Listed: main first, plus the follower annotated with its owner.
    const list = await listWorktrees(repoRoot);
    expect(list).toHaveLength(2);
    expect(list[0].isMain).toBe(true);
    expect(list[0].authoritativeDataDir).toBeNull();
    const follower = list.find(w => w.branch === 'feature-x');
    expect(follower?.authoritativeDataDir).toBe(resolve(ownerData));

    // HS-8936 — the agent wiring landed: a `.mcp.json` at the worktree root
    // registering the channel for the OWNER's data dir (so the worktree's
    // hotsheet_* tools drive the shared instance).
    const mcp = JSON.parse(readFileSync(join(wt.path, '.mcp.json'), 'utf-8')) as { mcpServers: Record<string, { args: string[] }> };
    const serverKey = Object.keys(mcp.mcpServers).find(k => k.startsWith('hotsheet-channel-'));
    expect(serverKey).toBeDefined();
    expect(mcp.mcpServers[serverKey!].args).toContain(resolve(ownerData));

    // Removed (force: the worktree has an untracked .hotsheet/).
    await removeWorktree(repoRoot, wt.path, { force: true });
    const after = await listWorktrees(repoRoot);
    expect(after).toHaveLength(1);
    expect(after[0].isMain).toBe(true);
  });

  it('defaults the worktree location to a sibling <repo>-worktrees/<branch>', async () => {
    const wt = await createWorktree(repoRoot, ownerData, { branch: 'feat-default', newBranch: true });
    // realpath both sides — `git` reports the symlink-resolved path (macOS
    // /var → /private/var) while our computed path isn't symlink-resolved.
    expect(realpathSync(wt.path)).toBe(realpathSync(join(base, `${basename(repoRoot)}-worktrees`, 'feat-default')));
    await removeWorktree(repoRoot, wt.path, { force: true });
  });

  it('removeWorktree with deleteBranch also deletes the branch', async () => {
    const wt = await createWorktree(repoRoot, ownerData, { branch: 'throwaway', newBranch: true });
    await removeWorktree(repoRoot, wt.path, { force: true, deleteBranch: true });
    const branches = execFileSync('git', ['branch', '--list', 'throwaway'], { cwd: repoRoot, encoding: 'utf-8' });
    expect(branches.trim()).toBe('');
  });
});
