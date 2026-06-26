// HS-9089 (docs/105 §105.6) — the per-project worktree-setup hook against real
// temp dirs. The owner settings + the worktree-setup.sh convention are real files;
// the shell runner is injected so no real command executes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeFileSettings } from '../file-settings.js';
import { runWorktreeSetup,type SetupRunner } from './worktreeSetup.js';

describe('runWorktreeSetup — real temp dirs (HS-9089)', () => {
  let base: string;
  let owner: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hs-wt-setup-'));
    owner = join(base, 'owner', '.hotsheet');
    worktree = join(base, 'wt');
    mkdirSync(owner, { recursive: true });
    mkdirSync(worktree, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** A runner that records (cwd, command) calls; `fail` commands resolve ok:false. */
  function runner(fail = false): { run: SetupRunner; calls: Array<{ cwd: string; command: string }> } {
    const calls: Array<{ cwd: string; command: string }> = [];
    const run: SetupRunner = (cwd, command) => { calls.push({ cwd, command }); return Promise.resolve({ ok: !fail, output: fail ? 'boom' : 'ok' }); };
    return { run, calls };
  }

  it('does nothing when neither the setting nor the script is present', async () => {
    const { run, calls } = runner();
    const res = await runWorktreeSetup(worktree, owner, { run });
    expect(res).toEqual({ ran: [], ok: true });
    expect(calls).toEqual([]);
  });

  it('runs the worktreeSetup setting command in the worktree dir', async () => {
    writeFileSettings(owner, { worktreeSetup: 'cp .env.example .env' });
    const { run, calls } = runner();
    const res = await runWorktreeSetup(worktree, owner, { run });
    expect(res).toEqual({ ran: ['setting'], ok: true });
    expect(calls).toEqual([{ cwd: worktree, command: 'cp .env.example .env' }]);
  });

  it('runs the worktree-setup.sh convention via sh when present', async () => {
    writeFileSync(join(owner, 'worktree-setup.sh'), '#!/bin/sh\necho hi\n');
    const { run, calls } = runner();
    const res = await runWorktreeSetup(worktree, owner, { run });
    expect(res.ran).toEqual(['script']);
    expect(calls).toHaveLength(1);
    expect(calls[0].cwd).toBe(worktree);
    expect(calls[0].command).toContain('sh ');
    expect(calls[0].command).toContain('worktree-setup.sh');
  });

  it('runs both (setting before script) when both are configured', async () => {
    writeFileSettings(owner, { worktreeSetup: 'make setup' });
    writeFileSync(join(owner, 'worktree-setup.sh'), 'echo hi\n');
    const { run, calls } = runner();
    const res = await runWorktreeSetup(worktree, owner, { run });
    expect(res.ran).toEqual(['setting', 'script']);
    expect(calls.map(c => c.command)[0]).toBe('make setup');
    expect(calls.map(c => c.command)[1]).toContain('worktree-setup.sh');
  });

  it('a blank/whitespace setting is ignored', async () => {
    writeFileSettings(owner, { worktreeSetup: '   ' });
    const { run, calls } = runner();
    const res = await runWorktreeSetup(worktree, owner, { run });
    expect(res.ran).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('a failing hook is logged + folds into ok:false, never throws', async () => {
    writeFileSettings(owner, { worktreeSetup: 'exit 1' });
    const { run } = runner(true);
    const log = vi.fn();
    const res = await runWorktreeSetup(worktree, owner, { run, log });
    expect(res).toEqual({ ran: ['setting'], ok: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('worktreeSetup command failed'));
  });
});
