// HS-8863 — worker launcher tests (docs/90 §90.5/§90.7). Covers the launch
// command, the reuse-existing-worktree path, and the validation guards. The
// create-a-new-worktree path delegates to `createWorktree` (covered in
// `worktrees.test.ts`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
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
    // HS-9676 — the command now injects the canonical id (env + verbatim prompt).
    expect(spec.command).toContain('HOTSHEET_WORKER_ID=feature-x ');
    expect(spec.command).toContain('"/hotsheet-worker');
    expect(spec.command).toContain('canonical worker id is feature-x');
  });

  it('HS-9676: workerLaunchCommand injects the canonical worker id (env + verbatim prompt); omitting it keeps the bare command', () => {
    const dataDir = join(repoRoot, '.hotsheet');
    const cmd = workerLaunchCommand(dataDir, 'worker-1');
    expect(cmd.startsWith('HOTSHEET_WORKER_ID=worker-1 ')).toBe(true);
    expect(cmd).toContain('canonical worker id is worker-1');
    expect(cmd).toMatch(/Do NOT derive your id from the worktree folder/);
    // Older/manual callers that pass no id still get the unchanged bare command.
    expect(workerLaunchCommand(dataDir)).toBe(`${claudeWithChannelCommand(dataDir)} "/hotsheet-worker"`);
  });

  it('HS-9676: a reused worker whose worktree folder carries a numeric instance suffix still launches under the canonical lease id, NOT the folder name', async () => {
    // The pool reuses slot `worker-1`; its worktree folder is the generated
    // `hotsheet-worker-1-12` (the suffix increments on reuse). The pool passes the
    // canonical label, so the injected id must be `worker-1` — the id it registers
    // and dispatches tickets to — and must never be the folder basename.
    const suffixedDir = join(tmpdir(), `hotsheet-worker-1-12-${String(Date.now())}`);
    mkdirSync(suffixedDir);
    try {
      const git = gitWith([repoRoot, suffixedDir]);
      const spec = await prepareWorker(
        repoRoot, join(repoRoot, '.hotsheet'),
        { worktreePath: suffixedDir, label: 'worker-1' }, git,
      );
      expect(spec.worker).toBe('worker-1');
      expect(spec.command).toContain('HOTSHEET_WORKER_ID=worker-1 ');
      expect(spec.command).toContain('canonical worker id is worker-1');
      expect(spec.command).not.toContain(basename(suffixedDir)); // never the instance folder name
    } finally {
      rmSync(suffixedDir, { recursive: true, force: true });
    }
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

  it('refuses a tool with no worker capability, naming it and the remedy', () => {
    // HS-9601 — the refusal is now "this plugin declares no `worker`", not a
    // tool-id test, so it survives every tool that gains support later.
    setTool('opencode');
    expect(() => workerLaunchCommand(dataDir)).toThrow(WorkerLaunchUnsupportedError);
    try {
      workerLaunchCommand(dataDir);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toContain('opencode');              // which tool
      expect(msg).toMatch(/No workers were started/); // what happened
      expect(msg).toMatch(/Switch the project/);      // what to do about it
    }
  });

  it('refuses every tool that has not declared the capability', () => {
    for (const tool of ['antigravity', 'opencode', 'gemini', 'goose']) {
      setTool(tool);
      expect(() => workerLaunchCommand(dataDir), tool).toThrow(WorkerLaunchUnsupportedError);
    }
  });

  it('launches a CODEX worker, pointing it at the skill file rather than a slash command (HS-9601)', () => {
    // Maintainer decision (2026-08-05): option (a) — a PTY worker like Claude's.
    // Codex takes a positional prompt, but its slash-command syntax from one is
    // unverified, so the prompt names the skill FILE. Getting that wrong fails
    // visibly in the worker's terminal rather than silently doing nothing, which
    // is the HS-9594 failure mode this ticket exists to avoid.
    setTool('codex');
    const cmd = workerLaunchCommand(dataDir);
    expect(cmd.startsWith('codex ')).toBe(true);
    expect(cmd).toContain('.agents/skills/hotsheet-worker/SKILL.md');
    // No `claude`, and no channel flag: codex reaches the MCP tools through its
    // global cwd-resolving config, so there is nothing to put on the line.
    expect(cmd).not.toContain('claude');
  });

  it('prepareWorker gets past the capability check for codex and builds a spec', async () => {
    // The positive path HS-9601 asked for: a codex project must reach worktree
    // creation instead of being refused at the door.
    setTool('codex');
    let sawGit = false;
    const git: GitRunner = () => { sawGit = true; return Promise.resolve(''); };
    await prepareWorker(repoRoot, dataDir, { branch: 'hotsheet/worker-1' }, git).catch(() => { /* worktree wiring is not under test here */ });
    expect(sawGit).toBe(true);
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
    setTool('opencode');
    const git: GitRunner = () => { throw new Error('git must not be invoked for an unsupported tool'); };
    await expect(prepareWorker(repoRoot, dataDir, { branch: 'hotsheet/worker-1' }, git))
      .rejects.toThrow(WorkerLaunchUnsupportedError);
  });
});
