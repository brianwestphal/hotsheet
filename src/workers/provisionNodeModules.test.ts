// HS-9087 (docs/105 §105.6) — provisionNodeModules against real temp dirs (mirrors
// worktrees.test.ts). The CoW / npm-ci external commands go through an injected
// CmdRunner so no real `cp`/`npm` runs; the runner SIMULATES success by creating
// the directory it would have (so the helper's `existsSync` verification is
// honest). The symlink rung + lock reads use real fs.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CmdRunner, provisionNodeModules } from './provisionNodeModules.js';

describe('provisionNodeModules — real temp dirs (HS-9087)', () => {
  let base: string;
  let owner: string;
  let worktree: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'hs-provision-'));
    owner = join(base, 'owner');
    worktree = join(base, 'wt');
    mkdirSync(owner, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    // The worktree is a Node project (provisioning is a no-op otherwise).
    writeFileSync(join(worktree, 'package.json'), '{"name":"wt"}');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Give the owner a `node_modules` (a marker file inside it) + a lock. */
  function ownerHasDeps(lock = '{"v":1}'): void {
    mkdirSync(join(owner, 'node_modules'), { recursive: true });
    writeFileSync(join(owner, 'node_modules', '.marker'), 'owner');
    writeFileSync(join(owner, 'package-lock.json'), lock);
  }
  function worktreeLock(lock: string): void {
    writeFileSync(join(worktree, 'package-lock.json'), lock);
  }

  /** A runner that records calls and, for a "copy"/"ci" it deems successful,
   *  materializes the worktree node_modules so the helper's existsSync passes. */
  function runner(opts: { cowOk?: boolean; ciOk?: boolean } = {}): { run: CmdRunner; calls: string[][] } {
    const calls: string[][] = [];
    const run: CmdRunner = (cwd, command, args) => {
      calls.push([command, ...args]);
      const ok = command === 'cp' ? opts.cowOk !== false : opts.ciOk !== false;
      if (ok) { mkdirSync(join(worktree, 'node_modules'), { recursive: true }); writeFileSync(join(worktree, 'node_modules', '.marker'), command); }
      return Promise.resolve({ ok, output: '' });
    };
    return { run, calls };
  }

  it('CoW clone wins when the owner has node_modules and cp succeeds', async () => {
    ownerHasDeps();
    worktreeLock('{"v":1}'); // same lock → no reconcile
    const { run, calls } = runner({ cowOk: true });
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res).toEqual({ ok: true, strategy: 'cow', reconciled: false });
    expect(calls[0][0]).toBe('cp');
    expect(calls.some(c => c[0] === 'npm')).toBe(false);
    expect(existsSync(join(worktree, 'node_modules'))).toBe(true);
  });

  it('falls back to a real symlink when CoW fails', async () => {
    ownerHasDeps();
    worktreeLock('{"v":1}');
    const { run, calls } = runner({ cowOk: false });
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res.strategy).toBe('symlink');
    expect(res.reconciled).toBe(false);
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(calls.some(c => c[0] === 'npm')).toBe(false);
  });

  it('Windows skips CoW and goes straight to the junction/symlink rung', async () => {
    ownerHasDeps();
    worktreeLock('{"v":1}');
    const { run, calls } = runner();
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'win32' });
    expect(res.strategy).toBe('symlink');
    expect(calls.some(c => c[0] === 'cp')).toBe(false); // no cp attempted on Windows
  });

  it('npm ci when the owner has no node_modules to clone', async () => {
    // No ownerHasDeps() — owner has nothing to clone.
    const { run, calls } = runner({ ciOk: true });
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res.strategy).toBe('npm-ci');
    expect(res.reconciled).toBe(false);
    expect(calls).toEqual([['npm', 'ci']]);
  });

  it('lock-diff reconcile: a differing worktree lock triggers npm ci (symlink replaced first)', async () => {
    ownerHasDeps('{"deps":"owner"}');
    worktreeLock('{"deps":"branch-changed"}'); // differs → reconcile
    const { run, calls } = runner({ cowOk: false }); // force symlink, then reconcile
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res.strategy).toBe('symlink');
    expect(res.reconciled).toBe(true);
    // The symlink was replaced by a real (runner-materialized) node_modules.
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false);
    expect(calls).toContainEqual(['npm', 'ci']);
  });

  it('identical lock skips the reconcile', async () => {
    ownerHasDeps('{"deps":"same"}');
    worktreeLock('{"deps":"same"}');
    const { run, calls } = runner({ cowOk: true });
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'darwin' });
    expect(res).toEqual({ ok: true, strategy: 'cow', reconciled: false });
    expect(calls.some(c => c[0] === 'npm')).toBe(false);
  });

  it('a worktree that already has node_modules is reconcile-only (refresh path)', async () => {
    ownerHasDeps('{"deps":"owner"}');
    mkdirSync(join(worktree, 'node_modules'), { recursive: true }); // already provisioned
    worktreeLock('{"deps":"changed"}'); // a rebase changed the lock
    const { run, calls } = runner({ ciOk: true });
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res.strategy).toBe('already-present');
    expect(res.reconciled).toBe(true);
    expect(calls).toEqual([['npm', 'ci']]);
  });

  it('already-present + matching lock is a no-op', async () => {
    ownerHasDeps('{"deps":"same"}');
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    worktreeLock('{"deps":"same"}');
    const { run, calls } = runner();
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res).toEqual({ ok: true, strategy: 'already-present', reconciled: false });
    expect(calls).toEqual([]);
  });

  it('a failing npm ci surfaces ok:false with the output', async () => {
    const run = vi.fn<CmdRunner>().mockResolvedValue({ ok: false, output: 'npm exploded' });
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res).toMatchObject({ ok: false, strategy: 'npm-ci', detail: 'npm exploded' });
  });

  it('a worktree with no package.json is a no-op (non-Node project)', async () => {
    rmSync(join(worktree, 'package.json'));
    const run = vi.fn<CmdRunner>();
    const res = await provisionNodeModules(worktree, owner, { run, platform: 'linux' });
    expect(res).toEqual({ ok: true, strategy: 'skipped', reconciled: false });
    expect(run).not.toHaveBeenCalled();
  });
});
