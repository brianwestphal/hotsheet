// HS-8863 — worker launcher tests (docs/90 §90.5/§90.7). Covers the launch
// command, the reuse-existing-worktree path, and the validation guards. The
// create-a-new-worktree path delegates to `createWorktree` (covered in
// `worktrees.test.ts`).
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetSettingsCacheForTests } from '../file-settings.js';
import { claudeWithChannelCommand } from '../terminals/resolveCommand.js';
import type { GitRunner } from '../worktrees.js';
import { prepareWorker, workerLaunchCommand, WorkerLaunchUnsupportedError } from './launchWorker.js';

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
  it('HS-9036: workerLaunchCommand boots Claude into the worker skill WITH the development-channel flag', () => {
    const dataDir = join(repoRoot, '.hotsheet');
    const cmd = workerLaunchCommand(dataDir);
    // The channel flag is what routes the worker's permission prompts (and events)
    // to its channel server so they surface in the Hot Sheet UI — same as main.
    expect(cmd).toBe(`${claudeWithChannelCommand(dataDir)} "/hotsheet-worker"`);
    expect(cmd).toContain('--dangerously-load-development-channels server:hotsheet-channel-');
    expect(cmd).toContain('"/hotsheet-worker"');
  });

  it('reuses an existing worktree and derives label + worker id from its branch', async () => {
    const git = gitWith([repoRoot, wtPath]);
    const spec = await prepareWorker(repoRoot, join(repoRoot, '.hotsheet'), { worktreePath: wtPath }, git);
    expect(spec.cwd).toBe(wtPath);
    expect(spec.worktreeCreated).toBe(false);
    expect(spec.label).toBe('feature-x');
    expect(spec.worker).toBe('feature-x');           // slug of the label
    expect(spec.command).toBe(`${claudeWithChannelCommand(join(repoRoot, '.hotsheet'))} "/hotsheet-worker"`);
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

/**
 * HS-9594 — the pool is Claude-only and must refuse, loudly, for any other tool.
 *
 * The reported failure was silence: a `codex` project got a `claude …` launch
 * line, the PTY opened, the slot registered, and the pool reported spawned/live
 * workers whose terminals were empty. Nothing threw, so nothing could report it.
 */
describe('worker launch is gated on the project AI tool (HS-9594)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hs-worker-tool-'));
    _resetSettingsCacheForTests();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    _resetSettingsCacheForTests();
  });

  const setTool = (aiTool: string): void => {
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: aiTool }));
    _resetSettingsCacheForTests();
  };

  it('refuses an explicitly non-Claude project, naming the tool and the remedy', () => {
    setTool('codex');
    expect(() => workerLaunchCommand(dataDir)).toThrow(WorkerLaunchUnsupportedError);
    try {
      workerLaunchCommand(dataDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('codex');            // which tool
      expect(msg).toMatch(/Claude only/);        // why
      expect(msg).toMatch(/No workers were started/); // what happened
      expect(msg).toMatch(/Set the project/);    // what to do about it
    }
  });

  it('refuses every other registered non-Claude tool too, not just codex', () => {
    for (const tool of ['antigravity', 'opencode', 'gemini', 'goose']) {
      setTool(tool);
      expect(() => workerLaunchCommand(dataDir), tool).toThrow(WorkerLaunchUnsupportedError);
    }
  });

  it('allows an explicit claude project', () => {
    setTool('claude');
    expect(workerLaunchCommand(dataDir)).toContain('/hotsheet-worker');
  });

  it('allows `auto` and an unset tool — the overwhelmingly common case', () => {
    // Getting this wrong would break the pool for every project that never
    // picked a tool, which is most of them.
    setTool('auto');
    expect(workerLaunchCommand(dataDir)).toContain('/hotsheet-worker');
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({}));
    _resetSettingsCacheForTests();
    expect(workerLaunchCommand(dataDir)).toContain('/hotsheet-worker');
  });

  it('prepareWorker refuses before creating a worktree', async () => {
    // The refusal has to happen BEFORE any side effect — otherwise a refused
    // scale-up still litters worktrees and branches.
    setTool('codex');
    const git: GitRunner = () => { throw new Error('git must not be invoked for an unsupported tool'); };
    await expect(prepareWorker(repoRoot, dataDir, { branch: 'hotsheet/worker-1' }, git))
      .rejects.toThrow(WorkerLaunchUnsupportedError);
  });
});
