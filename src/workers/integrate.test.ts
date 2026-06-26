// HS-9048 — owner-side branch integration (docs/89 §89.7), against a real temp
// git repo (mirrors `worktrees.test.ts`).
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectTargetBranch, integrateBranch, listReadyBranches, summarizeWorktreesGit } from './integrate.js';

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

  // HS-9091 (docs/106 §106.2) — optional in-helper gate-running. The git is real;
  // the gate command is a portable `node -e` so it runs on any CI host. Each test
  // captures the pre-merge HEAD to assert that a failing/timed-out gate rolls the
  // target all the way back (target left clean).
  describe('integrateBranch — gate-running', () => {
    /** Set up `hotsheet/worker-1` one commit ahead, checked back out on main.
     *  Returns the pre-merge HEAD on main. */
    function readyWorker(): string {
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'a.txt', 'a\n', 'work 1');
      git(repo, ['checkout', '-q', 'main']);
      return git(repo, ['rev-parse', 'HEAD']).trim();
    }
    const PASS = 'node -e "process.exit(0)"';
    const FAIL = 'node -e "process.stderr.write(\'gate boom\'); process.exit(1)"';
    const HANG = 'node -e "setTimeout(()=>{}, 10000)"';

    it('a passing gate keeps the merge → merged + gate summary', async () => {
      readyWorker();
      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main', undefined, { gate: { command: PASS } });
      expect(res.status).toBe('merged');
      expect(res.ok).toBe(true);
      expect(res.gate).toMatchObject({ ran: true, passed: true, timedOut: false });
      // The merge commit is on main.
      expect(git(repo, ['log', '--oneline', 'main']).includes('work 1')).toBe(true);
    });

    it('a failing gate rolls the merge back → gate-failed, target clean', async () => {
      const before = readyWorker();
      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main', undefined, { gate: { command: FAIL } });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('gate-failed');
      expect(res.gate?.passed).toBe(false);
      expect(res.gate?.output).toContain('gate boom');
      // Rolled all the way back — HEAD is the pre-merge commit, work NOT on main.
      expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(git(repo, ['log', '--oneline', 'main']).includes('work 1')).toBe(false);
      expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    });

    it('a hanging gate is bounded → gate-timeout, rolled back', async () => {
      const before = readyWorker();
      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main', undefined, { gate: { command: HANG, timeoutMs: 400 } });
      expect(res.ok).toBe(false);
      expect(res.status).toBe('gate-timeout');
      expect(res.gate).toMatchObject({ ran: true, passed: false, timedOut: true });
      expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(before);
      expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    });

    it('runs the gate via an injected runner (no real spawn) and reports its outcome', async () => {
      readyWorker();
      const calls: Array<{ cwd: string; command: string }> = [];
      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main', undefined, {
        gate: {
          command: 'pretend-gate',
          run: (cwd, command) => { calls.push({ cwd, command }); return Promise.resolve({ exitCode: 0, output: 'ok', timedOut: false }); },
        },
      });
      expect(res.status).toBe('merged');
      expect(res.gate).toEqual({ ran: true, passed: true, output: 'ok', timedOut: false });
      expect(calls).toEqual([{ cwd: repo, command: 'pretend-gate' }]);
    });

    it('without a gate, behavior is unchanged → merged, no gate field', async () => {
      readyWorker();
      const res = await integrateBranch(repo, 'hotsheet/worker-1', 'main');
      expect(res.status).toBe('merged');
      expect(res.gate).toBeUndefined();
    });
  });

  // HS-9081 (docs/102 §102.3) — per-worktree git summary for the pool tiles.
  describe('summarizeWorktreesGit', () => {
    it('reports ahead/behind from the worker branch + dirty from the worktree', async () => {
      // worker-1 gains a commit ahead of main…
      git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
      commitFile(repo, 'a.txt', 'a\n', 'work 1');
      // …and main advances, so worker-1 is also 1 behind.
      git(repo, ['checkout', '-q', 'main']);
      commitFile(repo, 'b.txt', 'b\n', 'main moves');
      // Leave the (main) worktree dirty with an untracked file.
      writeFileSync(join(repo, 'scratch.txt'), 'wip\n');

      const summary = await summarizeWorktreesGit(repo, [{ worktreePath: repo, branch: 'hotsheet/worker-1' }]);
      expect(summary.get(repo)).toEqual({ ahead: 1, behind: 1, dirty: true });
    });

    it('reports a clean, in-sync worktree as 0/0/clean', async () => {
      const summary = await summarizeWorktreesGit(repo, [{ worktreePath: repo, branch: 'main' }]);
      expect(summary.get(repo)).toEqual({ ahead: 0, behind: 0, dirty: false });
    });

    it('a branch with no commits ahead reads 0/0 (listReadyBranches filter)', async () => {
      git(repo, ['branch', 'hotsheet/worker-2', 'main']); // even with main, no commits ahead
      const summary = await summarizeWorktreesGit(repo, [{ worktreePath: repo, branch: 'hotsheet/worker-2' }]);
      expect(summary.get(repo)).toMatchObject({ ahead: 0, behind: 0 });
    });

    it('is failure-open — an unreadable worktree path is reported clean, never throws', async () => {
      const summary = await summarizeWorktreesGit(repo, [{ worktreePath: join(repo, 'does-not-exist'), branch: null }]);
      expect(summary.get(join(repo, 'does-not-exist'))).toEqual({ ahead: 0, behind: 0, dirty: false });
    });

    it('returns an empty map for no worktrees', async () => {
      expect((await summarizeWorktreesGit(repo, [])).size).toBe(0);
    });
  });
});
