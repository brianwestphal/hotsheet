/**
 * HS-9688 — adopt a git worktree as a FOLLOWER of an owner project's Hot Sheet.
 *
 * Background: the worker-pool retirement (HS-9681) removed the in-app path that used
 * to CREATE worktrees and wire them as followers (`createWorktree`). What's KEPT is the
 * runtime redirect — a worktree whose `.hotsheet/settings.json` carries an
 * `authoritativeDataDir` pointer resolves all project data to the owner
 * (`resolveAuthoritativeDataDir`), so an agent in any worktree claims from the owner's
 * one ticket DB / running instance. But now that Claude/Codex create worktrees
 * natively, there was no built-in way to WRITE that pointer on a hand-made worktree.
 *
 * `makeFollower` is that missing primitive (the recipe deferred in HS-9682): it points
 * a worktree at an owner's `.hotsheet` and wires the follower's channel MCP config,
 * generated skills, and Claude allow-rules against the OWNER — none of which depend on
 * the deleted `src/workers` / `worktrees.ts`. Exposed via the `--follow` CLI flag
 * (docs/89). Pure orchestration over existing helpers; idempotent (safe to re-run on
 * an already-adopted worktree).
 */
import { existsSync, mkdirSync } from 'fs';
import { basename, join, resolve } from 'path';

import { registerChannelAt } from './channel-config.js';
import { writeWorktreeApprovals } from './claude-allow-rule.js';
import { readFileSettings, writeFileSettings } from './file-settings.js';
import { type GitRunner, listWorktreePaths } from './git/runner.js';
import { ensureGitignore } from './gitignore.js';
import { ensureSkillsForDir, generatedClaudeSkillNames } from './skills.js';

/**
 * Resolve a user-supplied owner path to its `.hotsheet` directory. Accepts either the
 * owner's project ROOT (the natural thing to pass) or its `.hotsheet` dir directly.
 */
export function resolveOwnerDataDir(ownerPath: string): string {
  const abs = resolve(ownerPath);
  return basename(abs) === '.hotsheet' ? abs : join(abs, '.hotsheet');
}

/**
 * HS-9697 — auto-detect the owner `.hotsheet` for `hotsheet --follow` (no arg) run
 * inside a linked worktree. `git worktree list` reports the MAIN worktree first, so its
 * `.hotsheet` is the owner. Returns null when there's nothing to follow: the cwd IS the
 * main worktree (you're the owner), the main has no `.hotsheet` (not a Hot Sheet owner),
 * or git isn't available / this isn't a worktree. Async (shells git); the caller falls
 * back to asking for an explicit path on null.
 */
export async function detectOwnerDataDir(worktreeRoot: string, git?: GitRunner): Promise<string | null> {
  const root = resolve(worktreeRoot);
  let paths: { path: string }[];
  try {
    paths = await listWorktreePaths(root, git);
  } catch {
    return null; // not a git repo / git unavailable
  }
  if (paths.length === 0) return null;
  const main = resolve(paths[0].path); // `git worktree list` reports the main worktree first
  if (main === root) return null; // cwd is the main worktree → nothing to follow
  const owner = join(main, '.hotsheet');
  return existsSync(owner) ? owner : null;
}

/**
 * Wire `worktreeRoot` as a follower of `ownerDataDir` (an owner's `.hotsheet` dir).
 * Throws with an actionable message on invalid input — the owner must exist, must not
 * itself be a follower (chains are disallowed, matching `resolveAuthoritativeDataDir`),
 * and must not be the worktree's own `.hotsheet` (self-reference).
 */
export function makeFollower(worktreeRoot: string, ownerDataDir: string): void {
  const root = resolve(worktreeRoot);
  const owner = resolve(ownerDataDir);
  const followerDataDir = join(root, '.hotsheet');

  if (!existsSync(owner)) {
    throw new Error(`Owner .hotsheet does not exist: ${owner}. Pass the owner project's root (or its .hotsheet dir).`);
  }
  if (owner === followerDataDir) {
    throw new Error(`Refusing to make ${root} follow itself (owner === this worktree's .hotsheet).`);
  }
  // No chains: a follower cannot point at another follower (mirrors the read-time
  // guard in resolveAuthoritativeDataDir, but fail fast at adopt time with a clearer
  // message than the runtime redirect would give later).
  const ownerPointer = readFileSettings(owner).authoritativeDataDir;
  if (typeof ownerPointer === 'string' && ownerPointer.trim() !== '') {
    throw new Error(`Owner ${owner} is itself a follower (authoritativeDataDir → ${ownerPointer.trim()}); chains are not allowed. Follow the ultimate owner instead.`);
  }

  // 1. The pointer — this is what makes the worktree a follower at runtime.
  mkdirSync(followerDataDir, { recursive: true });
  writeFileSettings(followerDataDir, { authoritativeDataDir: owner });
  // 2. Keep the worktree's own `.hotsheet/` out of git (the owner's is the SoT).
  ensureGitignore(root);
  // 3. Channel MCP config rooted at the worktree but pointing tools at the OWNER,
  //    so an agent here drives the one shared instance.
  registerChannelAt(root, owner);
  // 4. Generated skills for the worktree, resolved against the owner's categories.
  //    Must run BEFORE writeWorktreeApprovals (which gates on `.claude/` existing).
  ensureSkillsForDir(root, undefined, owner);
  // 5. Pre-approve the owner's channel MCP server + generated skills so the agent
  //    isn't prompted (reads the owner's opt-out; no-op if the owner disabled it).
  writeWorktreeApprovals(root, owner, generatedClaudeSkillNames());
}
