/**
 * HS-9111 — real-temp-repo guard for the foreground working-tree poll
 * (docs/48 §48.3.3). Unlike `watcher.test.ts` (which mocks `fs` + `getGitStatus`
 * to pin the state machine), this stands up a REAL git repo and runs the REAL
 * `git status`, proving that a working-tree-only mutation — a tracked file
 * edited with no `git add`, or a brand-new untracked file — bumps the change
 * version through the whole stack, while a `.gitignore`d file (the
 * node_modules / dist churn concern) does NOT.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetActiveProjectsForTests } from '../activeProjects.js';
import {
  _resetGitStatusCacheForTests,
  _setRecursiveWatchForTests,
  disposeAllGitWatchers,
  dropGitStatusCache,
  ensureGitWatcher,
  getGitChangeVersion,
  pollWorkingTreesOnce,
} from './watcher.js';

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf-8' });
}

describe('working-tree poll — real git repo (HS-9111)', () => {
  let repo: string;

  beforeEach(() => {
    _resetGitStatusCacheForTests();
    _resetActiveProjectsForTests(); // empty ⇒ isProjectActive defaults true (project is "foreground")
    // HS-9224 — this suite drives the deterministic POLL path; pin the recursive
    // working-tree watch OFF (its real-FSEvents timing is too flaky to assert on,
    // and the mocked `watcher.test.ts` suite covers its logic).
    _setRecursiveWatchForTests(false);
    disposeAllGitWatchers();
    repo = mkdtempSync(join(tmpdir(), 'hs-wtpoll-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 't@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'tracked.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  afterEach(() => {
    disposeAllGitWatchers();
    _setRecursiveWatchForTests(null); // HS-9224 — restore platform detection
    rmSync(repo, { recursive: true, force: true });
  });

  it('a tracked-file edit with NO `git add` bumps the version', async () => {
    ensureGitWatcher(repo);
    await pollWorkingTreesOnce(); // baseline (clean tree)
    expect(getGitChangeVersion(repo)).toBe(0);

    writeFileSync(join(repo, 'tracked.txt'), 'one\ntwo\n'); // modify only — no `git add`
    dropGitStatusCache(repo); // mimic the >4s gap between real polls (skip the 500ms cache)
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion(repo)).toBe(1);
  });

  it('a brand-new untracked file bumps the version', async () => {
    ensureGitWatcher(repo);
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion(repo)).toBe(0);

    writeFileSync(join(repo, 'new-untracked.txt'), 'hello\n');
    dropGitStatusCache(repo);
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion(repo)).toBe(1);
  });

  it('a .gitignored file does NOT bump the version (git status excludes it)', async () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-q', '-m', 'add gitignore']);

    ensureGitWatcher(repo);
    await pollWorkingTreesOnce(); // baseline (clean)
    const base = getGitChangeVersion(repo);

    // Churn under an ignored directory — the node_modules / dist case.
    mkdirSync(join(repo, 'ignored'));
    writeFileSync(join(repo, 'ignored', 'junk.txt'), 'noise\n');
    dropGitStatusCache(repo);
    await pollWorkingTreesOnce();
    expect(getGitChangeVersion(repo)).toBe(base); // unchanged — ignored churn never registers
  });
});
