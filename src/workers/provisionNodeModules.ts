/**
 * HS-9087 (docs/105 §105.1-105.2) — provision a worker worktree's `node_modules`
 * efficiently, so a fresh worktree is ready to build in near-zero time instead of
 * paying a full `npm ci` per worker.
 *
 * One reusable helper with a degradation ladder, shared by BOTH call sites so the
 * install logic isn't duplicated:
 *   - `createWorktree` (HS-9088) — initial provisioning right after `git worktree add`.
 *   - the §99 `refreshWorktree` step 3 (HS-9074) — the post-rebase conditional reinstall.
 *
 * The ladder (per §105.1):
 *   1. **CoW clone** of the owner's `node_modules` — `cp -c` (macOS APFS) /
 *      `cp --reflink=auto` (Linux Btrfs/XFS). Near-instant, isolated per worktree.
 *   2. **symlink / junction** fallback when CoW isn't supported / fails.
 *   3. **`npm ci`** when the owner has no `node_modules` to clone.
 *   4. **lock-diff reconcile** — if the worktree's `package-lock.json` differs from
 *      the owner's (its branch changed deps), run `npm ci` so it never builds
 *      against the wrong deps. A symlink is replaced with a real install first
 *      (else `npm ci` would write into the owner's shared tree).
 *
 * CoW capability is detected by **trying the command and falling back on error**
 * (not by sniffing the filesystem), so the ladder is uniform across platforms.
 * The heavy external commands (`cp`, `npm`) go through an injectable `CmdRunner`
 * seam so tests drive the branches without real npm; the symlink + lock reads use
 * real `fs` (the tests run against real temp dirs, mirroring `worktrees.test.ts`).
 */
import { execFile } from 'child_process';
import { existsSync, readFileSync, rmSync, statSync, symlinkSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

import { getErrorMessage } from '../utils/errorMessage.js';

const execFileAsync = promisify(execFile);

const NODE_MODULES = 'node_modules';
const LOCK = 'package-lock.json';

/** Which ladder rung provisioned `node_modules`. `already-present` = the worktree
 *  already had a real `node_modules` (the refresh path); `skipped` = nothing to do
 *  (no owner deps and `npm ci` not attempted — shouldn't normally happen). */
export type ProvisionStrategy = 'cow' | 'symlink' | 'npm-ci' | 'already-present' | 'skipped';

export interface ProvisionResult {
  ok: boolean;
  /** The rung that ran (before any reconcile). */
  strategy: ProvisionStrategy;
  /** Whether a lock-diff `npm ci` reconcile ran afterward. */
  reconciled: boolean;
  /** Diagnostic on `ok: false` (e.g. the failed `npm ci` output). */
  detail?: string;
}

/** Injectable runner for the heavy external commands (`cp`, `npm`). Resolves
 *  `{ ok }` from the exit code; never rejects. */
export type CmdRunner = (cwd: string, command: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

export const defaultCmdRunner: CmdRunner = async (cwd, command, args) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd, timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, output: stdout + stderr };
  } catch (e) {
    return { ok: false, output: getErrorMessage(e) };
  }
};

export interface ProvisionOptions {
  /** Override the external-command runner (tests inject). */
  run?: CmdRunner;
  /** Override the platform (tests force the CoW branch per OS). */
  platform?: NodeJS.Platform;
}

/** The CoW copy command for this platform, or null where no portable CoW exists
 *  (Windows / unknown) — there the ladder falls through to symlink/junction. */
function cowCommand(platform: NodeJS.Platform, ownerNm: string, wtNm: string): { command: string; args: string[] } | null {
  if (platform === 'darwin') return { command: 'cp', args: ['-cR', ownerNm, wtNm] };
  if (platform === 'linux') return { command: 'cp', args: ['--reflink=auto', '-R', ownerNm, wtNm] };
  return null;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function readLock(root: string): string | null {
  try { return readFileSync(join(root, LOCK), 'utf-8'); } catch { return null; }
}

/** Does the worktree's lock differ from the owner's provisioned deps? When the
 *  worktree has no lock there's nothing to reconcile against (false). When the
 *  owner has none but the worktree does, the provisioned deps can't be trusted to
 *  match → reconcile (true). */
function lockDiffers(ownerRoot: string, worktreeRoot: string): boolean {
  const wt = readLock(worktreeRoot);
  if (wt === null) return false;
  const owner = readLock(ownerRoot);
  return owner !== wt;
}

/**
 * Provision (or reconcile) the worktree's `node_modules`. Best-effort + structured:
 * callers (createWorktree, refreshWorktree) treat a non-`ok` result as "fall back
 * to the worker's own `npm ci`", never as a hard failure.
 */
export async function provisionNodeModules(
  worktreeRoot: string, ownerRoot: string, opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const run = opts.run ?? defaultCmdRunner;
  const platform = opts.platform ?? process.platform;
  const ownerNm = join(ownerRoot, NODE_MODULES);
  const wtNm = join(worktreeRoot, NODE_MODULES);

  let strategy: ProvisionStrategy = 'skipped';

  // --- Step A: provision node_modules if the worktree doesn't have one yet. ---
  if (existsSync(wtNm)) {
    strategy = 'already-present';
  } else if (isDir(ownerNm)) {
    // 1) CoW clone — try the command, fall back on any error (don't sniff the FS).
    const cow = cowCommand(platform, ownerNm, wtNm);
    if (cow !== null && (await run(worktreeRoot, cow.command, cow.args)).ok && existsSync(wtNm)) {
      strategy = 'cow';
    } else {
      // 2) symlink / junction fallback (shares the owner's deps until a reconcile).
      try {
        symlinkSync(ownerNm, wtNm, platform === 'win32' ? 'junction' : 'dir');
        strategy = 'symlink';
      } catch { /* fall through to npm ci */ }
    }
  }
  if (strategy === 'skipped') {
    // 3) npm ci — owner had no node_modules to clone, or the symlink failed.
    const ci = await run(worktreeRoot, 'npm', ['ci']);
    if (!ci.ok) return { ok: false, strategy: 'npm-ci', reconciled: false, detail: ci.output };
    strategy = 'npm-ci';
  }

  // --- Step B: lock-diff reconcile (skip when we just did a fresh npm ci). ---
  if (strategy !== 'npm-ci' && lockDiffers(ownerRoot, worktreeRoot)) {
    // A symlink shares the owner's tree — drop it so `npm ci` writes into the
    // worktree, not the owner's node_modules.
    if (strategy === 'symlink') { try { rmSync(wtNm, { recursive: true, force: true }); } catch { /* best-effort */ } }
    const ci = await run(worktreeRoot, 'npm', ['ci']);
    if (!ci.ok) return { ok: false, strategy, reconciled: false, detail: ci.output };
    return { ok: true, strategy, reconciled: true };
  }

  return { ok: true, strategy, reconciled: false };
}
