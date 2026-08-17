/**
 * Generic async git runner + read-only worktree listing.
 *
 * Extracted from the retired `src/worktrees.ts` (worker-pool removal, HS-9686):
 * these two helpers are NOT worktree *management* — `defaultGit` is a plain
 * shell-git invoker (shared by any code that shells `git`), and
 * `listWorktreePaths` is a read-only listing used to validate a review cwd. Both
 * outlive the worker pool.
 */
import { resolve } from 'path';

import { execFileAsync } from '../utils/execAsync.js';

/** Injectable git runner so unit tests don't shell out. */
export type GitRunner = (repoRoot: string, args: string[]) => Promise<string>;

/** Default runner: shell `git` in `repoRoot` with a timeout + generous buffer. */
export const defaultGit: GitRunner = async (repoRoot, args) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
};

/**
 * Paths of this repo's git worktrees (`git worktree list --porcelain`, parsed to
 * paths only). A read-only listing — NOT worktree management — used to validate a
 * path is a real worktree of this repo before, e.g., spawning a review there.
 */
export async function listWorktreePaths(
  repoRoot: string,
  git: GitRunner = defaultGit,
): Promise<{ path: string }[]> {
  const porcelain = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const paths: { path: string }[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim();
      if (p !== '') paths.push({ path: resolve(p) });
    }
  }
  return paths;
}
