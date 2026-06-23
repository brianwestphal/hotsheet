// HS-8863 — worker launcher tests (docs/90 §90.5/§90.7). Covers the launch
// command, the reuse-existing-worktree path, and the validation guards. The
// create-a-new-worktree path delegates to `createWorktree` (covered in
// `worktrees.test.ts`).
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { GitRunner } from '../worktrees.js';
import { prepareWorker, workerLaunchCommand } from './launchWorker.js';

let repoRoot: string;
let wtPath: string;
beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'hs-wt-main-'));
  wtPath = mkdtempSync(join(tmpdir(), 'hs-wt-feature-'));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(wtPath, { recursive: true, force: true });
});

/** A git stub that reports `repoRoot` (main) + `wtPath` (a feature worktree). */
const gitWith = (worktrees: string[]): GitRunner => () =>
  Promise.resolve(worktrees.map(p => `worktree ${p}\nHEAD abc123\nbranch refs/heads/${p === repoRoot ? 'main' : 'feature-x'}\n`).join('\n'));

describe('worker launcher (HS-8863)', () => {
  it('workerLaunchCommand boots Claude into the worker skill', () => {
    expect(workerLaunchCommand()).toBe('claude "/hotsheet-worker"');
  });

  it('reuses an existing worktree and derives label + worker id from its branch', async () => {
    const git = gitWith([repoRoot, wtPath]);
    const spec = await prepareWorker(repoRoot, join(repoRoot, '.hotsheet'), { worktreePath: wtPath }, git);
    expect(spec.cwd).toBe(wtPath);
    expect(spec.worktreeCreated).toBe(false);
    expect(spec.label).toBe('feature-x');
    expect(spec.worker).toBe('feature-x');           // slug of the label
    expect(spec.command).toBe('claude "/hotsheet-worker"');
  });

  it('honors an explicit label/worker over the derived defaults', async () => {
    const git = gitWith([repoRoot, wtPath]);
    const spec = await prepareWorker(
      repoRoot, join(repoRoot, '.hotsheet'),
      { worktreePath: wtPath, label: 'Worker 2', worker: 'w2' }, git,
    );
    expect(spec.label).toBe('Worker 2');
    expect(spec.worker).toBe('w2');
  });

  it('refuses to run a worker in the main worktree', async () => {
    const git = gitWith([repoRoot, wtPath]);
    await expect(
      prepareWorker(repoRoot, join(repoRoot, '.hotsheet'), { worktreePath: repoRoot }, git),
    ).rejects.toThrow(/main worktree/);
  });

  it('rejects an unknown worktree path', async () => {
    const git = gitWith([repoRoot, wtPath]);
    await expect(
      prepareWorker(repoRoot, join(repoRoot, '.hotsheet'), { worktreePath: '/nope/not/here' }, git),
    ).rejects.toThrow(/No such worktree/);
  });

  it('requires either a worktreePath or a branch', async () => {
    const git = gitWith([repoRoot, wtPath]);
    await expect(
      prepareWorker(repoRoot, join(repoRoot, '.hotsheet'), {}, git),
    ).rejects.toThrow(/requires either/);
  });
});
