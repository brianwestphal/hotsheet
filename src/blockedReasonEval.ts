// HS-9337 (docs/116 §116.5) — re-evaluate a ticket's free-text `blocked_reason`
// (HS-9336) against the current state of the tickets it references.
//
// Maintainer decision (2026-07-06): option (a) — **worklist-hint, suggest-only**. This
// module NEVER auto-clears a `blocked_reason`. It parses `HS-NNNN` ticket refs out of
// the free text, checks each referenced ticket's status via an INJECTED resolver, and —
// when every referenced ticket is done — produces a passive "possibly unblocked" hint
// that the worklist markdown surfaces (`sync/markdown.ts`). The agent processing the
// worklist re-reads the reason and clears it with judgment; that human/agent decision
// is the "clear signal" (the ticket's design note: don't auto-clear without one).
//
// Pure (no DB/IO) so it's unit-testable in isolation; the caller injects `statusOf`.

/** A ticket status is "resolved" (its blocking is likely lifted) when done. */
export type BlockedRefStatus = string;

function isCompleteStatus(status: string): boolean {
  return status === 'completed' || status === 'verified';
}

/**
 * Extract ticket-number refs (e.g. `HS-1234`) from a free-text string. Matches an
 * UPPERCASE prefix + `-` + digits (`HS-1234`, `ABC-42`); a lowercase token like
 * `utf-8` is deliberately NOT matched. Deduplicated, order-preserving, uppercased.
 * A stray uppercase token that isn't a real ticket simply resolves to `null` via the
 * caller's `statusOf` and is ignored by `analyzeBlockedReason`.
 */
export function extractTicketRefs(reason: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\b[A-Z][A-Z0-9]*-\d+\b/g;
  for (const m of reason.matchAll(re)) {
    const ref = m[0].toUpperCase();
    if (!seen.has(ref)) { seen.add(ref); out.push(ref); }
  }
  return out;
}

export interface BlockedReasonAnalysis {
  /** All ticket-number refs parsed from the reason (uppercased, deduped). */
  refs: string[];
  /** Refs that resolve to a KNOWN ticket (statusOf returned non-null). */
  knownRefs: string[];
  /** Known refs whose ticket is completed/verified. */
  completeRefs: string[];
  /** Known refs whose ticket is still open. */
  incompleteRefs: string[];
  /** True when there is ≥1 known ref AND every known ref is complete/verified. Stray
   *  non-ticket tokens (unknown) are ignored — the hint is about the tickets that were
   *  actually referenced, and it's suggest-only, so the agent applies final judgment. */
  allKnownComplete: boolean;
}

/**
 * Analyze a `blocked_reason` string against current ticket statuses. `statusOf(ref)`
 * returns the referenced ticket's status, or `null` when the ref isn't a real ticket.
 * Never mutates anything — returns a report the caller renders.
 */
export function analyzeBlockedReason(
  reason: string,
  statusOf: (ref: string) => BlockedRefStatus | null,
): BlockedReasonAnalysis {
  const refs = extractTicketRefs(reason);
  const knownRefs: string[] = [];
  const completeRefs: string[] = [];
  const incompleteRefs: string[] = [];
  for (const ref of refs) {
    const status = statusOf(ref);
    if (status === null) continue; // stray non-ticket token — ignore
    knownRefs.push(ref);
    if (isCompleteStatus(status)) completeRefs.push(ref);
    else incompleteRefs.push(ref);
  }
  return {
    refs,
    knownRefs,
    completeRefs,
    incompleteRefs,
    allKnownComplete: knownRefs.length > 0 && incompleteRefs.length === 0,
  };
}

/**
 * The passive worklist hint for a blocked reason, or `null` when nothing to suggest
 * (no known refs, or some are still open). Suggest-only — it asks the agent to
 * re-evaluate + clear if appropriate, never asserts the ticket IS unblocked.
 */
export function formatUnblockHint(analysis: BlockedReasonAnalysis): string | null {
  if (!analysis.allKnownComplete) return null;
  const done = analysis.completeRefs.join(', ');
  return `⚠ Possibly unblocked: ${done} now completed/verified. Re-evaluate the blocked reason and clear it (set \`blocked_reason\` to null via hotsheet_update_ticket) if the ticket can now proceed.`;
}
