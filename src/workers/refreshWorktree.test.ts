// HS-9074 (docs/99 §99.5) — the worker-side refresh routine, against a real temp
// git repo (mirrors `integrate.test.ts`). The dependency reinstall is injected so
// no real `npm ci` runs; everything else drives actual `git`.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refreshWorktree, type ReinstallRunner } from './refreshWorktree.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

function commit(repo: string, file: string, content: string, message: string): void {
  writeFileSync(join(repo, file), content);
  git(repo, ['add', file]);
  git(repo, ['commit', '-q', '-m', message]);
}

/** A reinstall spy that records calls and reports success (no real npm). */
function reinstallSpy(ok = true): ReinstallRunner {
  return vi.fn<ReinstallRunner>(() => Promise.resolve({ ok }));
}

describe('refreshWorktree — real git (HS-9074)', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'hs-refresh-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    commit(repo, 'README.md', '# base\n', 'init');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  /** Branch off main as `hotsheet/worker-1` with one commit; leave HEAD on it. */
  function workerBranchAhead(): void {
    git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
    commit(repo, 'a.txt', 'a\n', 'work 1');
  }

  it('clean-tree guard — a dirty tree refuses with `dirty-tree`, no rebase', async () => {
    workerBranchAhead();
    writeFileSync(join(repo, 'wip.txt'), 'uncommitted\n'); // untracked ⇒ dirty
    const res = await refreshWorktree(repo, {}, undefined, reinstallSpy());
    expect(res).toMatchObject({ ok: false, status: 'dirty-tree', rebased: false });
    // The branch was NOT rebased — wip.txt is still there.
    expect(existsSync(join(repo, 'wip.txt'))).toBe(true);
  });

  it('clean rebase — target moved ahead ⇒ refreshed + rebased:true', async () => {
    workerBranchAhead();
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'b.txt', 'b\n', 'main moves');
    git(repo, ['checkout', '-q', 'hotsheet/worker-1']);

    const res = await refreshWorktree(repo, {}, undefined, reinstallSpy());
    expect(res).toMatchObject({ ok: true, status: 'refreshed', rebased: true, reinstalled: false });
    // The worker branch now contains main's commit (b.txt) after the rebase.
    expect(existsSync(join(repo, 'b.txt'))).toBe(true);
  });

  it('already up to date — nothing to rebase ⇒ refreshed + rebased:false', async () => {
    workerBranchAhead(); // ahead of main, but main never moved
    const res = await refreshWorktree(repo, {}, undefined, reinstallSpy());
    expect(res).toMatchObject({ ok: true, status: 'refreshed', rebased: false, reinstalled: false });
  });

  it('conflict — captures the conflicted files + aborts (tree left clean)', async () => {
    git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
    commit(repo, 'file.txt', 'worker change\n', 'worker edits file');
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'file.txt', 'main change\n', 'main edits file');
    git(repo, ['checkout', '-q', 'hotsheet/worker-1']);

    const res = await refreshWorktree(repo, {}, undefined, reinstallSpy());
    expect(res.ok).toBe(false);
    expect(res.status).toBe('conflict');
    expect(res.conflicts).toContain('file.txt');
    // Rebase was aborted cleanly — no mid-rebase state, tree clean.
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('');
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('hotsheet/worker-1');
  });

  it('lock change in the rebase ⇒ reinstall runs (reinstalled:true)', async () => {
    commit(repo, 'package-lock.json', '{"v":1}\n', 'add lockfile');
    git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
    commit(repo, 'a.txt', 'a\n', 'work 1');
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'package-lock.json', '{"v":2}\n', 'bump deps'); // the target changed deps
    git(repo, ['checkout', '-q', 'hotsheet/worker-1']);

    const spy = reinstallSpy();
    const res = await refreshWorktree(repo, {}, undefined, spy);
    expect(res).toMatchObject({ ok: true, status: 'refreshed', rebased: true, reinstalled: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('no dep change in the rebase ⇒ reinstall skipped (reinstalled:false)', async () => {
    commit(repo, 'package-lock.json', '{"v":1}\n', 'add lockfile');
    git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
    commit(repo, 'a.txt', 'a\n', 'work 1');
    git(repo, ['checkout', '-q', 'main']);
    commit(repo, 'src.txt', 'code\n', 'unrelated change'); // target moved, but not the lock
    git(repo, ['checkout', '-q', 'hotsheet/worker-1']);

    const spy = reinstallSpy();
    const res = await refreshWorktree(repo, {}, undefined, spy);
    expect(res).toMatchObject({ ok: true, status: 'refreshed', rebased: true, reinstalled: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('clearArtifacts removes dist/ + *.tsbuildinfo; default leaves them', async () => {
    // Ignore the artifacts so they don't trip the clean-tree guard.
    commit(repo, '.gitignore', 'dist/\n*.tsbuildinfo\n', 'ignore build artifacts');
    git(repo, ['checkout', '-q', '-b', 'hotsheet/worker-1']);
    const makeArtifacts = (): void => {
      mkdirSync(join(repo, 'dist'), { recursive: true });
      writeFileSync(join(repo, 'dist', 'out.js'), 'x');
      writeFileSync(join(repo, 'tsconfig.tsbuildinfo'), '{}');
    };

    // Default: artifacts left in place.
    makeArtifacts();
    const left = await refreshWorktree(repo, {}, undefined, reinstallSpy());
    expect(left.clearedArtifacts).toBe(false);
    expect(existsSync(join(repo, 'dist'))).toBe(true);
    expect(existsSync(join(repo, 'tsconfig.tsbuildinfo'))).toBe(true);

    // Opt-in: artifacts removed.
    const cleared = await refreshWorktree(repo, { clearArtifacts: true }, undefined, reinstallSpy());
    expect(cleared.clearedArtifacts).toBe(true);
    expect(existsSync(join(repo, 'dist'))).toBe(false);
    expect(existsSync(join(repo, 'tsconfig.tsbuildinfo'))).toBe(false);
  });
});
