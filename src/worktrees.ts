/**
 * HS-8935 — git worktree management (docs/89-git-worktrees.md §89.2 Phase B).
 *
 * Create / list / remove git worktrees for a project. A created worktree is made
 * a **follower** of the owner project: a `.hotsheet/settings.json` with an
 * `authoritativeDataDir` pointer (HS-8934 Phase A) so Hot Sheet launched there
 * shares the owner's one ticket DB / instance.
 *
 * The per-worktree AI-agent wiring (`.mcp.json` + skills + making the owner's
 * worklist reachable) lives in Phase C (HS-8936), where the terminal that
 * consumes it is opened — that artifact set has its own design subtleties (the
 * follower has no worklist of its own), so it's intentionally not written here.
 *
 * Pure-ish module: git is shelled out asynchronously (mirrors `src/git/status.ts`)
 * so a slow/contended `git` never blocks the event loop. The `git` invoker is
 * injectable for unit tests; the integration test drives a real temp repo.
 */
import { execFile } from 'child_process';
import { mkdirSync, realpathSync } from 'fs';
import { basename, join, resolve } from 'path';
import { promisify } from 'util';

import { registerChannelAt } from './channel-config.js';
import { readFileSettings, writeFileSettings } from './file-settings.js';
import { ensureGitignore } from './gitignore.js';
import { ensureSkillsForDir } from './skills.js';

const execFileAsync = promisify(execFile);

export interface WorktreeInfo {
  /** Absolute worktree root. */
  path: string;
  /** Branch name (no `refs/heads/`), or null when detached. */
  branch: string | null;
  /** Current commit sha (may be empty for a brand-new/bare entry). */
  head: string;
  /** The repo's primary (main) worktree — `git worktree list` reports it first. */
  isMain: boolean;
  /** This worktree's `.hotsheet/` follows another project's data dir (and which). */
  authoritativeDataDir: string | null;
}

/** Injectable git runner so unit tests don't shell out. */
export type GitRunner = (repoRoot: string, args: string[]) => Promise<string>;

const defaultGit: GitRunner = async (repoRoot, args) => {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
};

/** Canonicalize a path for comparison — resolves symlinks (e.g. macOS
 *  `/var` → `/private/var`) so paths from `git`'s output match ours. Falls back
 *  to `resolve()` when the path doesn't exist (e.g. just removed). */
function canonical(p: string): string {
  try { return realpathSync.native(p); } catch { return resolve(p); }
}

/** Default location for a new worktree: a sibling `../<repo>-worktrees/<branch>`. */
export function defaultWorktreePath(repoRoot: string, branch: string): string {
  const safeBranch = branch.replace(/[/\\]/g, '-');
  return resolve(repoRoot, '..', `${basename(repoRoot)}-worktrees`, safeBranch);
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreeList(porcelain: string): Omit<WorktreeInfo, 'isMain' | 'authoritativeDataDir'>[] {
  const out: Omit<WorktreeInfo, 'isMain' | 'authoritativeDataDir'>[] = [];
  let cur: { path?: string; branch: string | null; head: string } | null = null;
  const flush = (): void => {
    if (cur?.path !== undefined && cur.path !== '') out.push({ path: cur.path, branch: cur.branch, head: cur.head });
    cur = null;
  };
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      cur = { path: line.slice('worktree '.length).trim(), branch: null, head: '' };
    } else if (cur === null) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.branch = null;
    }
  }
  flush();
  return out;
}

/** List the project's git worktrees. The first entry is the main worktree; each
 *  entry is annotated with its follower pointer (if any). */
export async function listWorktrees(repoRoot: string, git: GitRunner = defaultGit): Promise<WorktreeInfo[]> {
  const parsed = parseWorktreeList(await git(repoRoot, ['worktree', 'list', '--porcelain']));
  return parsed.map((e, i) => ({
    ...e,
    isMain: i === 0,
    authoritativeDataDir: readFollowerPointer(e.path),
  }));
}

function readFollowerPointer(worktreePath: string): string | null {
  const ptr = readFileSettings(join(worktreePath, '.hotsheet')).authoritativeDataDir;
  return typeof ptr === 'string' && ptr.trim() !== '' ? resolve(ptr.trim()) : null;
}

export interface CreateWorktreeOpts {
  /** Branch to check out (existing) or create (when `newBranch`). */
  branch: string;
  /** Worktree location; defaults to `defaultWorktreePath(repoRoot, branch)`. */
  path?: string;
  /** Create a new branch (`git worktree add -b`) instead of checking out an existing one. */
  newBranch?: boolean;
  /** Base ref for a new branch (default `HEAD`). */
  baseRef?: string;
}

/**
 * Create a git worktree and mark it a follower of `ownerDataDir` (the owner
 * project's `.hotsheet`). Returns the new worktree's info.
 */
export async function createWorktree(
  repoRoot: string,
  ownerDataDir: string,
  opts: CreateWorktreeOpts,
  git: GitRunner = defaultGit,
): Promise<WorktreeInfo> {
  const path = resolve(opts.path ?? defaultWorktreePath(repoRoot, opts.branch));
  const owner = resolve(ownerDataDir);

  const args = ['worktree', 'add'];
  if (opts.newBranch === true) args.push('-b', opts.branch, path, opts.baseRef ?? 'HEAD');
  else args.push(path, opts.branch);
  await git(repoRoot, args);

  // Make it a follower: write the .hotsheet/settings.json pointer to the owner.
  const followerDataDir = join(path, '.hotsheet');
  mkdirSync(followerDataDir, { recursive: true });
  writeFileSettings(followerDataDir, { authoritativeDataDir: owner });

  // Defensive: ensure the worktree's `.hotsheet/` is gitignored (no-op when the
  // repo already ignores it repo-wide, which is the normal case).
  ensureGitignore(path);

  // HS-8936 (Phase C wiring) — make the worktree's AI agent talk to the OWNER's
  // Hot Sheet: write the channel `.mcp.json` (owner-direct) at the worktree root
  // + the skills whose `/hotsheet` worklist + curl port/secret point at the
  // owner. Best-effort: a wiring hiccup must never fail worktree creation.
  try { registerChannelAt(path, owner); } catch { /* best-effort agent wiring */ }
  try { ensureSkillsForDir(path, undefined, owner); } catch { /* best-effort agent wiring */ }

  const list = await listWorktrees(repoRoot, git);
  return list.find(w => canonical(w.path) === canonical(path))
    ?? { path, branch: opts.branch, head: '', isMain: false, authoritativeDataDir: owner };
}

/**
 * Remove a git worktree (`git worktree remove`). Optionally `--force` (e.g. the
 * worktree has untracked `.hotsheet/` contents) and/or delete its branch.
 */
export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  opts: { force?: boolean; deleteBranch?: boolean } = {},
  git: GitRunner = defaultGit,
): Promise<void> {
  const path = resolve(worktreePath);
  // Capture the branch before removal if we may need to delete it.
  let branch: string | null = null;
  if (opts.deleteBranch === true) {
    const entry = (await listWorktrees(repoRoot, git)).find(w => canonical(w.path) === canonical(path));
    branch = entry?.branch ?? null;
  }

  const args = ['worktree', 'remove'];
  if (opts.force === true) args.push('--force');
  args.push(path);
  await git(repoRoot, args);

  if (opts.deleteBranch === true && branch !== null && branch !== '') {
    await git(repoRoot, ['branch', '-D', branch]);
  }
}

/** Whether `dir` is itself a follower worktree (has a pointer). Convenience for callers. */
export function isFollowerWorktree(worktreeRoot: string): boolean {
  return readFollowerPointer(worktreeRoot) !== null;
}
