// HS-9107 (docs/102 §102.2) — the "merge pending" badge's Review affordance.
//
// HS-9045 shows a passive "merge pending" badge on a completed-but-unintegrated
// ticket. HS-9107 makes it actionable: when the worker recorded which branch its
// work landed on (`integration_branch`), the badge becomes clickable and opens
// Glassbox on `target..<branch>` — "show me what this finished ticket added,
// before I integrate it" — mirroring the pool-tile Review button (HS-9082).
import { getWorkerPool, reviewInGlassbox } from '../api/index.js';
import { toElement } from './dom.js';
import type { Ticket } from './state.js';
import { showToast } from './toast.js';

/**
 * Open Glassbox on the diff of `branch` vs the integration target ("what this
 * ticket's branch adds"). Resolves the target from the live worker pool
 * (`PoolState.target`, the server-detected target branch). Toasts on any missing
 * piece / failure rather than throwing. Exported for tests.
 */
export async function reviewIntegrationBranch(branch: string | null | undefined): Promise<void> {
  if (branch == null || branch === '') {
    showToast('No worker branch recorded for this ticket.', { variant: 'warning' });
    return;
  }
  let target: string | null | undefined;
  try {
    target = (await getWorkerPool()).target;
  } catch {
    showToast('Could not load the worker pool to find the target branch.', { variant: 'warning' });
    return;
  }
  if (target == null || target === '') {
    showToast('Could not determine the target branch to diff against.', { variant: 'warning' });
    return;
  }
  try {
    await reviewInGlassbox({ mode: 'range', from: target, to: branch });
  } catch {
    showToast('Could not open Glassbox. Make sure the Glassbox CLI is installed.', { variant: 'warning' });
  }
}

/**
 * The "merge pending" badge (HS-9045). When the ticket records an
 * `integration_branch` (HS-9107), the badge is a clickable Review affordance
 * (`.ticket-pending-merge-reviewable`) that opens the target..branch diff;
 * otherwise it's the passive badge. Shared by the list row + the column card so
 * the action lives in one place.
 */
export function renderMergePendingBadge(ticket: Ticket): HTMLElement {
  const branch = ticket.integration_branch;
  const reviewable = typeof branch === 'string' && branch !== '';
  const title = reviewable
    ? `Completed by a worker on ${branch} — not yet merged. Click to review what it added in Glassbox.`
    : 'Completed by a worker — not yet merged into the target branch (docs/89 §89.7)';
  const badge = toElement(
    <span className={`ticket-pending-merge${reviewable ? ' ticket-pending-merge-reviewable' : ''}`} title={title}>merge pending</span>,
  );
  if (reviewable) {
    badge.addEventListener('click', (e) => {
      e.stopPropagation(); // review, don't also select the row/card
      void reviewIntegrationBranch(branch);
    });
  }
  return badge;
}
