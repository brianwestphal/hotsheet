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

import { AI_TOOL_AUTO, getPlugin, normalizeAiToolId } from '../aiTools/registry.js';
import type { AiToolPlugin } from '../aiTools/types.js';
import { readFileSettings } from '../file-settings.js';
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
/** HS-9601 — the executable the project's worker launch line starts, so the
 *  pool can verify it exists before registering a slot. Throws the same typed
 *  refusal as `workerLaunchCommand` for an unsupported tool. */
export function workerBinary(ownerDataDir: string): string {
  return workerCapabilityFor(ownerDataDir).binary;
}

/** The worker launch line. HS-9676 — pass the canonical `workerId` (e.g.
 *  `worker-1`) so the plugin injects it (env + prompt) and the agent claims under
 *  the right identity instead of the generated worktree folder name. */
export function workerLaunchCommand(ownerDataDir: string, workerId?: string): string {
  return workerCapabilityFor(ownerDataDir).launchCommand(ownerDataDir, workerId);
}

/**
 * HS-9601 — the project's worker capability, or a typed refusal.
 *
 * §132's rule is that a tool is defined in ONE place, so this asks the registry
 * "does your plugin declare `worker`?" rather than testing ids. Adding an agent
 * is now one capability object in `src/aiTools/plugins/<id>.ts` — this file does
 * not change.
 */
function workerCapabilityFor(ownerDataDir: string): NonNullable<AiToolPlugin['worker']> {
  const raw: unknown = readFileSettings(ownerDataDir).ai_tool;
  const tool = normalizeAiToolId(typeof raw === 'string' ? raw : undefined);
  // `auto` (unset — the overwhelmingly common case) resolves to Claude, matching
  // every other `{{aiCommand}}` consumer, so a project that never picked a tool
  // is unaffected.
  const id = tool === AI_TOOL_AUTO ? 'claude' : tool;
  const capability = getPlugin(id)?.worker;
  if (capability === undefined) throw new WorkerLaunchUnsupportedError(tool);
  return capability;
}

/**
 * HS-9594 — the worker pool is **Claude-only**, and must say so instead of
 * launching Claude at a project configured for another agent.
 *
 * The reported failure (Rockwell Club, `ai_tool=codex`): `hotsheet_set_worker_target`
 * reported workers spawned and live, dispatch accepted assignments, every worker
 * terminal stayed empty, and each slot later went dead with `ahead=0` and no
 * commit. Nothing threw, because the launch line is built unconditionally — a
 * codex project got `claude --dangerously-load-development-channels … "/hotsheet-worker"`,
 * which on a machine without `claude` is a command-not-found in a fresh shell,
 * and with `claude` installed is the wrong agent running a skill the project
 * does not use. Either way the PTY exists, so the slot registers and counts as
 * live: **the pool reported success for a worker that never started.**
 *
 * Throwing here is what makes that impossible. `reconcilePool` catches it,
 * spawns nothing, and reports the reason (see `ReconcileResult.errors`), so an
 * agent asking for four workers is told why it got none rather than being handed
 * four hollow slots to dispatch into.
 *
 * Supporting a non-Claude worker is a real feature, not a missing branch — it
 * needs that agent's own channel/launch line and its own copy of the worker
 * loop skill (Claude's lives in `.claude/skills`; the AGENTS-family tools read
 * `.agents/skills`, docs/118). Tracked separately; this only stops the silent
 * failure.
 */
export function assertWorkerLaunchSupported(ownerDataDir: string): void {
  workerCapabilityFor(ownerDataDir);
}

/** Thrown when the project's `ai_tool` has no worker-launch support. Typed so
 *  callers can report it as a configuration answer rather than a crash. */
export class WorkerLaunchUnsupportedError extends Error {
  constructor(public readonly aiTool: string) {
    super(
      `The worker pool has no support for this project's AI tool ("${aiTool}"). `
      + 'No workers were started. Switch the project to an AI tool that supports workers '
      + '(Claude or Codex), or run the tickets on the main project instead.',
    );
    this.name = 'WorkerLaunchUnsupportedError';
  }
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
  // HS-9594 — refuse FIRST. `workerLaunchCommand` also asserts, but it runs at
  // the very end, so an unsupported project would have created a worktree and a
  // branch before being told no — littering the repo on every reconcile pass.
  assertWorkerLaunchSupported(ownerDataDir);

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
    // HS-9203 — `createWorktree` may have deduped the branch (e.g. `hotsheet/worker-1`
    // already existed → `hotsheet/worker-1-2`); use the ACTUAL branch for the label.
    derivedName = info.branch ?? opts.branch;
  }

  const label = opts.label ?? derivedName;
  const worker = opts.worker ?? slugify(label);
  // HS-9036 — the channel flag is keyed to the OWNER data dir (the channel
  // server the worker registers under + the maintainer is watching).
  // HS-9676 — inject `worker` (the canonical lease id, e.g. `worker-1`) into the
  // command so the agent doesn't derive its id from the generated worktree folder
  // (`hotsheet-worker-1-12`); `worker` is the SAME id `registerWorker` records, so
  // the launched agent's claims match the pool's dispatched tickets.
  return { worker, label, cwd, command: workerLaunchCommand(ownerDataDir, worker), worktreeCreated };
}
