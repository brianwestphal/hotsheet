/**
 * HS-9074 (docs/99) — the worker-side "stay fresh" routine: the deterministic
 * counterpart to the owner-side `integrate.ts` (HS-9048). A worker calls this at
 * a **batch boundary, with a clean tree** (never mid-ticket) to bring its branch
 * current with the target and reconcile deps so the gates don't run against the
 * wrong `node_modules`.
 *
 * The key coupling it closes: a rebase that pulls dependency changes leaves
 * `node_modules` stale, so tsc/lint/tests would run against the WRONG deps —
 * silently green-but-wrong. This ties the rebase and the conditional reinstall
 * together so they can't drift apart.
 *
 * Deterministic git + install only — no gate-running, no conflict resolution, no
 * pushing (same division of labor as `integrate.ts`; judgment stays with the
 * agent). Git runs through the injectable `GitRunner` shared with `worktrees.ts`,
 * and the post-rebase reinstall reuses the §105 `provisionNodeModules` helper, so
 * it's unit-testable against a real temp repo with no real `npm`.
 */
import { existsSync, readdirSync, rmSync } from 'fs';
import { join, resolve } from 'path';

import { readFileSettings } from '../file-settings.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { defaultGit, type GitRunner } from '../worktrees.js';
import { detectTargetBranch } from './integrate.js';
import { provisionNodeModules } from './provisionNodeModules.js';

export type RefreshStatus =
  | 'refreshed'   // rebased (or already up to date); deps reconciled if needed
  | 'dirty-tree'  // refused: uncommitted changes present
  | 'conflict'    // rebase hit a conflict; aborted cleanly
  | 'error';

export interface RefreshResult {
  ok: boolean;
  status: RefreshStatus;
  /** Did the rebase move HEAD? */
  rebased: boolean;
  /** Did we reinstall deps (the rebase changed `package-lock.json`/`package.json`)? */
  reinstalled: boolean;
  /** Did we drop `dist/` / `*.tsbuildinfo` (only when `opts.clearArtifacts`)? */
  clearedArtifacts: boolean;
  /** Conflicted file paths when `status === 'conflict'`. */
  conflicts?: string[];
  detail?: string;
}

/** The post-rebase dependency reinstall, injectable so tests don't run a real
 *  `npm ci`. The default reuses the §105 provisioning helper (forced reconcile,
 *  since the rebase moved the lock even though it now equals the target's). */
export type ReinstallRunner = (worktreeRoot: string) => Promise<{ ok: boolean; detail?: string }>;

/** Files whose change across the rebase means deps must be reinstalled. */
const DEP_FILES = ['package-lock.json', 'package.json'];

/** Resolve the owner project root from a follower worktree's pointer (for the
 *  shared provisioning helper). Falls back to the worktree itself when there's no
 *  pointer — harmless, since the forced-reconcile + already-present path doesn't
 *  read the owner root anyway. */
function ownerRootFor(worktreeRoot: string): string {
  const ptr = readFileSettings(join(worktreeRoot, '.hotsheet')).authoritativeDataDir;
  if (typeof ptr === 'string' && ptr.trim() !== '') {
    return resolve(ptr.trim()).replace(/[\\/]\.hotsheet[\\/]?$/, '');
  }
  return worktreeRoot;
}

const defaultReinstall: ReinstallRunner = async (worktreeRoot) => {
  const r = await provisionNodeModules(worktreeRoot, ownerRootFor(worktreeRoot), { forceReconcile: true });
  return { ok: r.ok, detail: r.detail };
};

function err(detail: string): RefreshResult {
  return { ok: false, status: 'error', rebased: false, reinstalled: false, clearedArtifacts: false, detail };
}

/** Drop stale build artifacts (`dist/` + top-level `*.tsbuildinfo`) that a rebase
 *  can leave inconsistent. Best-effort; returns whether anything was removed. */
function clearBuildArtifacts(worktreeRoot: string): boolean {
  let cleared = false;
  try {
    const dist = join(worktreeRoot, 'dist');
    if (existsSync(dist)) { rmSync(dist, { recursive: true, force: true }); cleared = true; }
  } catch { /* best-effort */ }
  try {
    for (const name of readdirSync(worktreeRoot)) {
      if (!name.endsWith('.tsbuildinfo')) continue;
      try { rmSync(join(worktreeRoot, name), { force: true }); cleared = true; } catch { /* best-effort */ }
    }
  } catch { /* best-effort */ }
  return cleared;
}

/**
 * Refresh a worker worktree: clean-tree guard → fetch + rebase onto the target →
 * conditional dependency reinstall → optional artifact clear. See the module
 * header for the contract. Returns a structured `RefreshResult`; never throws.
 */
export async function refreshWorktree(
  worktreeRoot: string,
  opts: { clearArtifacts?: boolean } = {},
  git: GitRunner = defaultGit,
  reinstall: ReinstallRunner = defaultReinstall,
): Promise<RefreshResult> {
  // 1) Clean-tree guard — the safe rebase point is between committed units of
  //    work, never over uncommitted edits (mirrors `integrateBranch`).
  let porcelain: string;
  try {
    porcelain = await git(worktreeRoot, ['status', '--porcelain']);
  } catch (e) {
    return err(getErrorMessage(e));
  }
  if (porcelain.trim() !== '') {
    return { ok: false, status: 'dirty-tree', rebased: false, reinstalled: false, clearedArtifacts: false };
  }

  // 2) Fetch + rebase onto the target.
  let preHead: string;
  let target: string;
  try {
    preHead = (await git(worktreeRoot, ['rev-parse', 'HEAD'])).trim();
    target = await detectTargetBranch(worktreeRoot, git);
  } catch (e) {
    return err(getErrorMessage(e));
  }
  // Fetch only when the repo has a remote (best-effort — an offline fetch failure
  // must not abort the refresh; the local target may still be ahead).
  try {
    if ((await git(worktreeRoot, ['remote'])).trim() !== '') {
      try { await git(worktreeRoot, ['fetch']); } catch { /* offline / no upstream — rebase onto local target */ }
    }
  } catch { /* `git remote` failed — skip fetch */ }

  try {
    await git(worktreeRoot, ['rebase', target]);
  } catch {
    let conflicts: string[] = [];
    try {
      const out = await git(worktreeRoot, ['diff', '--name-only', '--diff-filter=U']);
      conflicts = out.split('\n').map(s => s.trim()).filter(s => s !== '');
    } catch { /* couldn't read conflicts — still abort below */ }
    try { await git(worktreeRoot, ['rebase', '--abort']); } catch { /* best-effort rollback */ }
    return { ok: false, status: 'conflict', rebased: false, reinstalled: false, clearedArtifacts: false, conflicts };
  }

  let postHead = preHead;
  try { postHead = (await git(worktreeRoot, ['rev-parse', 'HEAD'])).trim(); } catch { /* keep preHead */ }
  const rebased = postHead !== preHead;

  // 3) Conditional dependency reinstall — the key coupling: only when the rebase
  //    actually changed the lock / manifest, reinstall so the gates run against
  //    the right deps.
  let reinstalled = false;
  if (rebased) {
    let depsChanged = false;
    try {
      const changed = (await git(worktreeRoot, ['diff', '--name-only', preHead, postHead, '--', ...DEP_FILES])).trim();
      depsChanged = changed !== '';
    } catch { /* couldn't diff — conservatively skip (don't block on a reinstall we can't justify) */ }
    if (depsChanged) {
      const r = await reinstall(worktreeRoot);
      if (!r.ok) {
        return { ok: false, status: 'error', rebased, reinstalled: false, clearedArtifacts: false, detail: r.detail ?? 'dependency reinstall failed' };
      }
      reinstalled = true;
    }
  }

  // 4) Optional stale-artifact clear (agent judgment).
  const clearedArtifacts = opts.clearArtifacts === true ? clearBuildArtifacts(worktreeRoot) : false;

  return { ok: true, status: 'refreshed', rebased, reinstalled, clearedArtifacts };
}
