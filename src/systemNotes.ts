/**
 * HS-9289 — auto-generated "system status" notes: notes Hot Sheet appends itself
 * (not human/agent content). The only one today is the claim-lease-reclaim note
 * (`src/db/claims.ts`). These must be treated specially:
 *
 *  - They must NOT mask a preceding `FEEDBACK NEEDED` note. The feedback-state
 *    readers (client `getTicketFeedbackState`, server `notesEndWithFeedback`, the
 *    Announcer's last-note check) all key on the MOST RECENT note; a claim-reclaim
 *    appended after a feedback question would otherwise make the ticket look like
 *    it's no longer waiting. Those readers skip trailing system notes.
 *  - The UI dims them (they're status churn, not content).
 *
 * Dependency-free so the note PRODUCER (server) + every reader (client + server +
 * announcer) share ONE definition of the exact text and can't drift — the same
 * pattern as `src/ticketNumber.ts`.
 */

/** The fixed prefix of the claim-lease-reclaim note built by `buildClaimReclaimNote`.
 *  (The em dash is intentional — it's the exact character the note carries.) */
export const CLAIM_RECLAIM_NOTE_PREFIX = 'Claim lease expired — reclaimed from ';

/** What the note says when the lapsed claim had no recorded holder. HS-9525 — this
 *  used to interpolate a literal `null`, which told the reader nothing: "reclaimed
 *  from `null`" reads like a bug rather than the ordinary case it is (a lease that
 *  expired with no `claimed_by`/`worker_label` recorded on the row). */
export const UNNAMED_CLAIMANT = 'an unnamed worker';

/**
 * Build the claim-reclaim status note for `who` — the prior claimant, or
 * `UNNAMED_CLAIMANT` when the lapsed claim had no recorded holder.
 *
 * Accepts null/undefined/blank deliberately: `claimed_by` IS nullable, and the old
 * `string`-typed parameter let a null through to be stringified by the template.
 *
 * **The prefix is invariant.** `isSystemStatusNote` recognises this note by
 * `startsWith(CLAIM_RECLAIM_NOTE_PREFIX)`, so a wording change that moved or altered
 * the prefix would stop it being treated as a system note — silently resurrecting the
 * HS-9526 bug where a claim note masks a preceding FEEDBACK NEEDED one.
 */
export function buildClaimReclaimNote(who: string | null | undefined): string {
  const label = typeof who === 'string' && who.trim() !== '' ? `\`${who}\`` : UNNAMED_CLAIMANT;
  return `${CLAIM_RECLAIM_NOTE_PREFIX}${label}.`;
}

/**
 * True when `text` is an auto-generated system/status note (currently: the
 * claim-lease-reclaim note). Extend this predicate — not the call sites — if more
 * system notes are added later.
 */
export function isSystemStatusNote(text: string): boolean {
  return text.startsWith(CLAIM_RECLAIM_NOTE_PREFIX);
}

/**
 * The index of the last note whose text is NOT a system/status note, or -1 when
 * every note is a system note (or the list is empty). The feedback-state readers
 * use this so a trailing claim-reclaim note doesn't hide the real last note.
 */
export function lastMeaningfulNoteIndex(texts: readonly string[]): number {
  for (let i = texts.length - 1; i >= 0; i--) {
    if (!isSystemStatusNote(texts[i])) return i;
  }
  return -1;
}
