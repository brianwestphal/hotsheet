// HS-9112 (docs/101 §101.7) — the per-project pending agent-partition-proposal
// slot. When the main agent calls `hotsheet_propose_partition` (instead of
// dispatching directly, gated on the `alwaysPreviewAgentPlans` setting), the
// proposal is stored here and a `worker-partition-proposed` §93 event is pushed.
// A live client opens the partition editor off the event; a client that wasn't
// connected reads this slot on panel-open. Cleared once consumed (the editor
// opened) so it doesn't re-open.
//
// Keyed by project secret (matching the §93 event bus key). Pure in-memory,
// mirroring the `poolManager` per-project map — no persistence (a proposal is
// ephemeral; if the process restarts the agent can re-propose).

import type { PartitionAssignment } from '../api/workers.js';

export interface PartitionProposal {
  assignments: PartitionAssignment[];
}

const proposals = new Map<string, PartitionProposal>();

/** Store (replacing any prior) the pending proposal for `secret`. */
export function setProposal(secret: string, assignments: PartitionAssignment[]): void {
  proposals.set(secret, { assignments });
}

/** The pending proposal for `secret`, or null when none. */
export function getProposal(secret: string): PartitionProposal | null {
  return proposals.get(secret) ?? null;
}

/** Drop the pending proposal for `secret` (no-op when none). */
export function clearProposal(secret: string): void {
  proposals.delete(secret);
}

/** TEST hook — drop every stored proposal. */
export function _resetProposalsForTesting(): void {
  proposals.clear();
}
