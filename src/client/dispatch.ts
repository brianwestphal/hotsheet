// HS-8964 — coordinator-dispatch (docs/92). The "push" half of §90.5: the owner
// assigns chosen tickets to a chosen worker by claiming each on that worker's
// behalf (claim-by-id, HS-8862). The dispatched tickets become that worker's
// personal queue — `claimNext` serves a worker's own-claimed tickets first
// (docs/92 §92.5), so its existing self-claim loop picks them up before pulling
// from the shared pool, with no worker-side change. Shared by both entry points
// (drag-to-tile in the worker-pool panel + the "Dispatch to worker…" menu).
import { claimTicket } from '../api/index.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { confirmDialog } from './confirm.js';
import { showToast } from './toast.js';

export interface DispatchResult {
  /** Tickets successfully claimed for the worker. */
  dispatched: number;
  /** Ticket ids that couldn't be claimed (e.g. a live foreign lease). */
  failed: number[];
  /** Per-ticket failure messages (e.g. "already claimed by worker-2"). */
  failures: string[];
}

/** Claim each ticket in `ids` for the target worker. A live foreign lease (409)
 *  or an unclaimable ticket (404) is collected as a failure rather than aborting
 *  the batch. With `force`, an existing foreign lease is overwritten (reassign,
 *  HS-8974). Pure data — no UI; callers toast via `dispatchAndReport`. */
export async function dispatchTicketsToWorker(
  worker: string, label: string, ids: readonly number[], opts: { force?: boolean } = {},
): Promise<DispatchResult> {
  let dispatched = 0;
  const failed: number[] = [];
  const failures: string[] = [];
  for (const id of ids) {
    try {
      await claimTicket(id, opts.force === true ? { worker, label, force: true } : { worker, label });
      dispatched++;
    } catch (e) {
      failed.push(id);
      failures.push(getErrorMessage(e));
    }
  }
  return { dispatched, failed, failures };
}

/** Build the user-facing summary for a dispatch result. Exported for tests. */
export function dispatchSummary(result: { dispatched: number; failures: string[] }, label: string): string {
  const parts: string[] = [];
  if (result.dispatched > 0) parts.push(`Dispatched ${String(result.dispatched)} ticket${result.dispatched === 1 ? '' : 's'} to ${label}`);
  if (result.failures.length > 0) {
    // De-dup identical messages ("already claimed by worker-2" ×3 → one line).
    const unique = [...new Set(result.failures)];
    parts.push(`${String(result.failures.length)} not dispatched (${unique.join('; ')})`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Nothing to dispatch';
}

/** Dispatch + toast the outcome — the common entry-point wrapper. When some
 *  tickets are already claimed by another worker (HS-8974 §92.7), offer to
 *  **reassign** them (force-claim, abandoning the other worker's hold); on
 *  confirm, the failed ids are re-dispatched with `force`. */
export async function dispatchAndReport(worker: string, label: string, ids: readonly number[]): Promise<DispatchResult> {
  const first = await dispatchTicketsToWorker(worker, label, ids);
  if (first.failed.length === 0) {
    showToast(dispatchSummary(first, label));
    return first;
  }
  const reassign = await confirmDialog({
    title: 'Reassign tickets?',
    message: `${String(first.failed.length)} ticket${first.failed.length === 1 ? '' : 's'} couldn't be dispatched (${[...new Set(first.failures)].join('; ')}).\n\nReassign to ${label} anyway? This takes ${first.failed.length === 1 ? 'it' : 'them'} from the current worker and abandons any in-progress work.`,
    confirmLabel: 'Reassign',
    danger: true,
  });
  if (!reassign) {
    showToast(dispatchSummary(first, label));
    return first;
  }
  const forced = await dispatchTicketsToWorker(worker, label, first.failed, { force: true });
  const merged: DispatchResult = {
    dispatched: first.dispatched + forced.dispatched,
    failed: forced.failed,
    failures: forced.failures,
  };
  showToast(dispatchSummary(merged, label));
  return merged;
}
