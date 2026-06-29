// HS-8863 — worker launcher (docs/90 §90.5 / §90.7). The "server launcher" half of
// the worker-loop form factor: prepare an isolated worktree slot and return the
// command that starts a Claude worker in it. The returned `command` runs the
// generated `hotsheet-worker` skill (see `src/skills.ts`), which drives the
// claim → work → complete + release → repeat loop through the `hotsheet_*` MCP
// tools (the prose mirror of `workerLoop.ts`). The actual terminal is opened by
// the caller via the existing Phase C terminal infrastructure
// (`openTerminalRunningCommand(command, label, cwd)`), exactly as the worktrees
// panel opens an interactive Claude terminal today; the durable pool that spins up
// N of these + the scale controls is HS-8962.
import { basename } from 'path';

import { claudeWithChannelCommand } from '../terminals/resolveCommand.js';
import type { GitRunner } from '../worktrees.js';
import { canonicalizePath, createWorktree, defaultGit, listWorktrees } from '../worktrees.js';

/** The fully-prepared spec to launch one worker terminal. */
export interface WorkerLaunchSpec {
  /** Stable worker identity used for `claimed_by` (the claim attribution). */
  worker: string;
  /** Human-friendly label shown in the UI (`worker_label`). */
  label: string;
  /** Working directory — the worktree root the worker runs in. */
  cwd: string;
  /** The shell command to run in a fresh terminal (starts Claude + the worker skill). */
  command: string;
  /** True when a new worktree was created for this worker (vs reusing one). */
  worktreeCreated: boolean;
}

export interface PrepareWorkerOpts {
  /** Reuse this EXISTING worktree (its root path) instead of creating a new one. */
  worktreePath?: string;
  /** Branch for a NEW worktree (created with `-b`). Required when `worktreePath` is omitted. */
  branch?: string;
  /** Human-friendly worker label (defaults to the branch / worktree dir name). */
  label?: string;
  /** Worker identity for `claimed_by` (defaults to a slug of the label). */
  worker?: string;
}

/** Turn a label into a filesystem/identity-safe slug. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worker';
}

/**
 * The terminal command that boots a Claude worker. It starts `claude` with the
 * **development-channel flag** (`claudeWithChannelCommand`, keyed to the OWNER's
 * data dir — the worker registers its channel server there, HS-8936) PLUS an
 * initial prompt that invokes the `/hotsheet-worker` skill.
 *
 * HS-9036 — the channel flag is what routes the worker's **permission prompts**
 * (and channel events) to its channel server so they surface in the Hot Sheet UI,
 * exactly like the main project's Claude command. Pre-fix the worker launched as a
 * bare `claude "/hotsheet-worker"` — it connected to the channel MCP (tools worked)
 * but Claude never sent `permission_request` to it, so EVERY worker permission
 * fell back to the terminal and never popped up in Hot Sheet.
 */
export function workerLaunchCommand(ownerDataDir: string): string {
  return `${claudeWithChannelCommand(ownerDataDir)} "/hotsheet-worker"`;
}

/**
 * Prepare a worker: ensure an isolated worktree slot (create one for `branch`, or
 * reuse `worktreePath`) and return the launch spec. `createWorktree` already wires
 * the worktree as a follower of the owner `.hotsheet` (the shared instance) plus
 * the `.mcp.json` + worker skill, so the launched Claude talks to the same server
 * the maintainer is watching.
 */
export async function prepareWorker(
  repoRoot: string,
  ownerDataDir: string,
  opts: PrepareWorkerOpts,
  git: GitRunner = defaultGit,
): Promise<WorkerLaunchSpec> {
  let cwd: string;
  let worktreeCreated = false;
  let derivedName: string;

  if (opts.worktreePath !== undefined && opts.worktreePath !== '') {
    const target = canonicalizePath(opts.worktreePath);
    const existing = (await listWorktrees(repoRoot, git)).find(w => canonicalizePath(w.path) === target);
    if (existing === undefined) throw new Error(`No such worktree: ${opts.worktreePath}`);
    if (existing.isMain) throw new Error('Refusing to run a worker in the main worktree — use an isolated worktree');
    cwd = existing.path;
    derivedName = existing.branch ?? basename(existing.path);
  } else {
    if (opts.branch === undefined || opts.branch === '') {
      throw new Error('prepareWorker requires either `worktreePath` or `branch`');
    }
    const info = await createWorktree(repoRoot, ownerDataDir, { branch: opts.branch, newBranch: true }, git);
    cwd = info.path;
    worktreeCreated = true;
    derivedName = opts.branch;
  }

  const label = opts.label ?? derivedName;
  const worker = opts.worker ?? slugify(label);
  // HS-9036 — the channel flag is keyed to the OWNER data dir (the channel
  // server the worker registers under + the maintainer is watching).
  return { worker, label, cwd, command: workerLaunchCommand(ownerDataDir), worktreeCreated };
}
