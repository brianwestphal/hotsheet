/**
 * HS-9084 (docs/103 §103.2 / §103.4) — the busy-worker warn gate.
 *
 * Routing a command-button trigger to a worker that is mid claim/lease loop
 * (pool state `working`) interleaves the command with the work the worker is
 * already doing. So before dispatching a `worker` / `all-workers` trigger, the
 * UI (the HS-9083 target picker) calls this pure helper to decide whether to
 * confirm first. Worker targets are meant for idempotent / maintenance commands;
 * a command explicitly marked **worker-safe** suppresses the warning entirely.
 *
 * Pure + DOM-free so it unit-tests in isolation and is shared by the picker UI.
 */
import type { ChannelTriggerTarget } from '../api/channel.js';

/** A live pool worker as the gate needs it — a subset of `WorkerSlotView`
 *  (`src/api/workers.ts`). */
export interface WorkerTargetSlot {
  /** Worktree root — matches a `worker` target's `worktree`. */
  worktreePath: string;
  /** `idle` | `working` | `draining` | `stopped` | `dead`. */
  state: string;
  /** Display label (e.g. `worker-1`), used in the warning text. */
  label?: string;
}

export interface WorkerTargetWarning {
  /** True when the caller should confirm before triggering. */
  warn: boolean;
  /** Human-readable reason (empty when `warn` is false). */
  reason: string;
}

const NO_WARNING: WorkerTargetWarning = { warn: false, reason: '' };

/** A worker holds a live claim/lease only in the `working` state; the others
 *  (`idle` / `draining` / `stopped` / `dead`) are safe to command. */
function isBusy(state: string): boolean {
  return state === 'working';
}

/**
 * Decide whether triggering `target` against the live `workers` pool needs a
 * busy-worker confirmation.
 *
 * - `main` — never warns (the normal play-button path).
 * - `worker` — warns when the matched slot is `working` (and isn't worker-safe);
 *   no warning when the target isn't in the live pool (nothing to interleave).
 * - `all-workers` — warns when ANY live worker is `working`.
 *
 * `opts.workerSafe` (a future per-command flag) suppresses the warning for
 * commands declared idempotent / safe to fan out mid-task.
 */
export function workerTargetWarning(
  target: ChannelTriggerTarget,
  workers: WorkerTargetSlot[],
  opts: { workerSafe?: boolean } = {},
): WorkerTargetWarning {
  if (target.kind === 'main') return NO_WARNING;
  if (opts.workerSafe === true) return NO_WARNING;

  if (target.kind === 'all-workers') {
    const busy = workers.filter(w => isBusy(w.state));
    if (busy.length === 0) return NO_WARNING;
    const names = busy.map(w => w.label ?? w.worktreePath).join(', ');
    return {
      warn: true,
      reason: `${String(busy.length)} worker(s) are mid-task (${names}). Triggering them now interleaves with their claimed work.`,
    };
  }

  // kind === 'worker' — only warn when this specific worker is busy.
  const slot = workers.find(w => w.worktreePath === target.worktree);
  if (slot === undefined || !isBusy(slot.state)) return NO_WARNING;
  return {
    warn: true,
    reason: `${slot.label ?? 'This worker'} is mid-task. Triggering it now interleaves with its claimed work.`,
  };
}
