// HS-9048 — owner-side branch integration (docs/89 §89.7), against a real temp
// git repo (mirrors `worktrees.test.ts`).
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectTargetBranch, integrateBranch, listReadyBranches } from './integrate.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

/** Commit `content` to `file` on the current branch. */
function commitFile(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content);
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', message]);
}

describe('integrate — real git', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'hs-integrate-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    commitFile(repo, 'README.md', '# base\n', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  describe('detectTargetBranch', () => {
    it('detects a local main', async () => {
      expect(await detectTargetBranch(repo)).toBe('main');
    });

    it('falls back to master when there is no main', async () => {
      git(repo, ['branch', '-m', 'main', 'master']);
      expect(await detectTargetBranch(repo)).toBe('master');
    });
  });

  describe('listReadyBranches', () => {
    it('lists hotsheet/* branches that are ahead, with ahead/behind counts', async () => {
      // A worker branch with one commit ahead of main.
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'a.txt', 'a\n', 'work 1');
      // Advance main so the branch is also 1 behind.
      git(repo, ['checkout', '-q', 'main']);
      commitFile(repo, 'b.txt', 'b\n', 'main moves');
      // A second worker branch with NO commits ahead (just main).
      git(repo, ['branch', 'hotsheet/worker-2', 'main']);
      // A non-worker branch — must be ignored.
      git(repo, ['checkout', '-q', '-b', 'feature/x']);
      commitFile(repo, 'c.txt', 'c\n', 'feature');
      git(repo, ['checkout', '-q', 'main']);

      const ready = await listReadyBranches(repo, 'main');
      expect(ready.map(r => r.branch)).toEqual(['hotsheet/worker-1']);
      expect(ready[0]).toMatchObject({ ahead: 1, behind: 1 });
    });

    it('returns [] when there are no worker branches', async () => {
      expect(await listReadyBranches(repo, 'main')).toEqual([]);
    });
  });

  describe('integrateBranch', () => {
    it('merges a ready branch into the target (clean) → merged', async () => {
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'a.txt', 'a\n', 'work 1');
      git(repo, ['checkout', '-q', 'main']);

      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main');
      expect(res).toEqual({ ok: true, status: 'merged' });
      // The commit is now on main.
      expect(git(repo, ['log', '--oneline', 'main']).includes('work 1')).toBe(true);
    });

    it('refuses when the worktree is dirty → dirty-tree', async () => {
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'a.txt', 'a\n', 'work 1');
      git(repo, ['checkout', '-q', 'main']);
      writeFileSync(join(repo, 'README.md'), '# dirty\n'); // uncommitted change

      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main');
      expect(res.status).toBe('dirty-tree');
      expect(res.ok).toBe(false);
    });

    it('refuses when not on the target branch → not-on-target', async () => {
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'a.txt', 'a\n', 'work 1');
      // Stay on hotsheet/worker-1 (not main).
      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main');
      expect(res.status).toBe('not-on-target');
      expect(res.detail).toBe('hotsheet/worker-1');
    });

    it('reports nothing-to-integrate for a branch with no commits ahead', async () => {
      git(repo, ['branch', 'hotsheet/worker-2', 'main']);
      const res = await integrateBranch(repo, 'hotsheet/worker-2', 'main');
      expect(res.status).toBe('nothing-to-integrate');
    });

    it('aborts on a conflict and reports the conflicted files → conflict', async () => {
      // Branch edits the same line README that main will also edit.
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'README.md', '# from worker\n', 'worker edit');
      git(repo, ['checkout', '-q', 'main']);
      commitFile(repo, 'README.md', '# from main\n', 'main edit');

      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main');
      expect(res.ok).toBe(false);
      expect(res.status).toBe('conflict');
      expect(res.conflicts).toContain('README.md');
      // The merge was aborted — the tree is clean again (no in-progress merge).
      expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    });
  });
});
