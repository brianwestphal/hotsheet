/**
 * HS-9048 — programmatic owner-side branch integration (docs/89 §89.7). The
 * owner-as-integrator git workflow (HS-9044) was skill-prose only; this is the
 * mechanical, deterministic core the owner agent invokes so it isn't re-derived
 * each time:
 *   - detect the integration **target branch** robustly,
 *   - list the **ready** worker branches (`hotsheet/*` ahead of the target), and
 *   - perform a single **safe merge** of one branch into the target.
 *
 * Judgment stays with the agent (per HS-9044): it runs the project gates after a
 * merge and resolves / asks on the conflicts this helper reports. The helper only
 * does the deterministic git, with strong guards — it requires the owner worktree
 * to be clean + on the target, aborts cleanly on conflict, and **never pushes**.
 * Git is shelled via the injectable `GitRunner` shared with `worktrees.ts`, so
 * unit tests inject and the integration test drives a real temp repo.
 */
import { getErrorMessage } from '../utils/errorMessage.js';
import { defaultGit, type GitRunner } from '../worktrees.js';

/** Worker branch prefix the pool launches (`hotsheet/worker-N`). */
const WORKER_BRANCH_PREFIX = 'hotsheet/';
/** Local-branch fallbacks for the target when there's no remote default. */
const TARGET_CANDIDATES = ['main', 'master'];

export interface ReadyBranch {
  branch: string;
  /** Commits on the branch not yet on the target. */
  ahead: number;
  /** Commits on the target not yet on the branch (the branch should rebase). */
  behind: number;
}

export type IntegrateStatus =
  | 'merged'
  | 'conflict'
  | 'dirty-tree'
  | 'not-on-target'
  | 'nothing-to-integrate'
  | 'error';

export interface IntegrateResult {
  ok: boolean;
  status: IntegrateStatus;
  /** Conflicted file paths when `status === 'conflict'`. */
  conflicts?: string[];
  /** Human detail — the current branch on `not-on-target`, the error on `error`. */
  detail?: string;
}

/**
 * Detect the integration target branch: the remote default (`origin/HEAD`) if a
 * remote exists, else a local `main` / `master`, else the currently-checked-out
 * branch. Never throws — falls back to `main`.
 */
export async function detectTargetBranch(repoRoot: string, git: GitRunner = defaultGit): Promise<string> {
  try {
    const ref = (await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).trim();
    if (ref.startsWith('origin/')) return ref.slice('origin/'.length);
  } catch { /* no remote / no origin/HEAD set */ }
  for (const cand of TARGET_CANDIDATES) {
    try {
      await git(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${cand}`]);
      return cand;
    } catch { /* not present */ }
  }
  try {
    return (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'main';
  } catch {
    return 'main';
  }
}

/**
 * Worker branches (`hotsheet/*`) that have commits not yet on the target — i.e.
 * the ones with integratable work. Each carries ahead/behind counts so the owner
 * can see which still need a rebase. Excludes the target itself. Never throws.
 */
export async function listReadyBranches(repoRoot: string, target: string, git: GitRunner = defaultGit): Promise<ReadyBranch[]> {
  let names: string[];
  try {
    const out = await git(repoRoot, ['for-each-ref', '--format=%(refname:short)', `refs/heads/${WORKER_BRANCH_PREFIX}`]);
    names = out.split('\n').map(s => s.trim()).filter(s => s !== '');
  } catch {
    return [];
  }
  const ready: ReadyBranch[] = [];
  for (const branch of names) {
    if (branch === target) continue;
    try {
      // `A...B` left-right count = "<behind> <ahead>" (left = on target not branch).
      const counts = (await git(repoRoot, ['rev-list', '--left-right', '--count', `${target}...${branch}`])).trim();
      const [behindStr, aheadStr] = counts.split(/\s+/);
      const ahead = Number(aheadStr) || 0;
      const behind = Number(behindStr) || 0;
      if (ahead > 0) ready.push({ branch, ahead, behind });
    } catch { /* an unmergeable / dangling ref — skip it */ }
  }
  return ready;
}

/**
 * Perform one safe merge of `branch` into `target`. Guards:
 *   - the owner worktree must be **clean** (`dirty-tree` otherwise — never merge
 *     over uncommitted work),
 *   - it must currently be **on the target** (`not-on-target`; the owner process
 *     runs on the target, and only that worktree can write it), and
 *   - the branch must have something to merge (`nothing-to-integrate`).
 * On a merge conflict it captures the conflicted files, **aborts** (clean
 * rollback), and returns `conflict` for the agent to resolve / ask about. NEVER
 * pushes. The agent runs the project gates after a `merged` result.
 */
export async function integrateBranch(
  repoRoot: string, branch: string, target: string, git: GitRunner = defaultGit,
): Promise<IntegrateResult> {
  let porcelain: string;
  try {
    porcelain = await git(repoRoot, ['status', '--porcelain']);
  } catch (e) {
    return { ok: false, status: 'error', detail: getErrorMessage(e) };
  }
  if (porcelain.trim() !== '') return { ok: false, status: 'dirty-tree' };

  let current: string;
  try {
    current = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch (e) {
    return { ok: false, status: 'error', detail: getErrorMessage(e) };
  }
  if (current !== target) return { ok: false, status: 'not-on-target', detail: current };

  let ahead = 0;
  try {
    ahead = Number((await git(repoRoot, ['rev-list', '--count', `${target}..${branch}`])).trim()) || 0;
  } catch (e) {
    return { ok: false, status: 'error', detail: getErrorMessage(e) };
  }
  if (ahead === 0) return { ok: false, status: 'nothing-to-integrate' };

  try {
    await git(repoRoot, ['merge', '--no-ff', '--no-edit', branch]);
    return { ok: true, status: 'merged' };
  } catch {
    let conflicts: string[] = [];
    try {
      const out = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
      conflicts = out.split('\n').map(s => s.trim()).filter(s => s !== '');
    } catch { /* couldn't read conflicts — still abort below */ }
    try { await git(repoRoot, ['merge', '--abort']); } catch { /* best-effort rollback */ }
    return { ok: false, status: 'conflict', conflicts };
  }
}
