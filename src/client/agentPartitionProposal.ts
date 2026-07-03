// HS-9112 (docs/101 §101.7) — client side of the agent-in-the-loop plan preview.
// When the main agent calls `hotsheet_propose_partition` (instead of dispatching,
// gated on the `alwaysPreviewAgentPlans` setting), the server pushes a
// `worker-partition-proposed` §93 event; this opens the SAME partition editor the
// "Parallelize tag…" quick action uses (HS-9080), and on accept the CLIENT
// dispatches each chunk (so the human commits the work, not the agent). On cancel
// nothing dispatches. A client that wasn't connected when the event fired picks
// the proposal up via `checkPendingPartitionProposal()` on worker-pool-panel open.

import { clearPartitionProposal, getPendingPartitionProposal, type PartitionAssignment } from '../api/workers.js';
import { dispatchAndReport } from './dispatch.js';
import { openPartitionEditor } from './partitionEditor.js';

/**
 * Open the partition editor for an agent-proposed plan. Accept → dispatch each
 * chunk via `dispatchAndReport` (claim-by-id, the human commits the work); cancel
 * → nothing dispatches. The server slot is cleared the moment we open the editor
 * (the proposal is consumed) so it doesn't re-open on a later panel-open; the §93
 * seq-dedup already prevents the live event from re-firing on reconnect.
 */
export function onWorkerPartitionProposed(assignments: readonly PartitionAssignment[]): void {
  if (!assignments.some(a => a.ticketIds.length > 0)) return; // nothing to dispatch
  void clearPartitionProposal().catch(() => { /* best-effort — the editor still opens */ });
  openPartitionEditor(assignments, async (chunks) => {
    for (const chunk of chunks) {
      if (chunk.ticketIds.length === 0) continue;
      await dispatchAndReport(chunk.worker, chunk.label, chunk.ticketIds);
    }
  });
}

/**
 * Read the pending agent proposal (if any) and open the editor for it. Covers a
 * client that opened the worker-pool panel AFTER the agent proposed, or that was
 * on the long-poll fallback (which doesn't carry bus events) when it fired.
 */
export async function checkPendingPartitionProposal(): Promise<void> {
  let assignments: PartitionAssignment[] | null;
  try { assignments = await getPendingPartitionProposal(); } catch { return; }
  if (assignments !== null) onWorkerPartitionProposed(assignments);
}
