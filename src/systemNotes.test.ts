import { describe, expect, it } from 'vitest';

import { buildClaimReclaimNote, CLAIM_RECLAIM_NOTE_PREFIX, isSystemStatusNote, lastMeaningfulNoteIndex, UNNAMED_CLAIMANT } from './systemNotes.js';

describe('systemNotes (HS-9289)', () => {
  it('buildClaimReclaimNote is recognized by isSystemStatusNote', () => {
    for (const who of ['owner', 'worker-1', 'null']) {
      const note = buildClaimReclaimNote(who);
      expect(note.startsWith(CLAIM_RECLAIM_NOTE_PREFIX)).toBe(true);
      expect(isSystemStatusNote(note)).toBe(true);
      expect(note).toContain(`\`${who}\``);
    }
  });

  it('isSystemStatusNote is false for ordinary + feedback notes', () => {
    expect(isSystemStatusNote('FEEDBACK NEEDED: which option?')).toBe(false);
    expect(isSystemStatusNote('Some completion note.')).toBe(false);
    expect(isSystemStatusNote('')).toBe(false);
    // Only a note that STARTS with the reclaim prefix counts — a mid-text mention doesn't.
    expect(isSystemStatusNote('follow-up: Claim lease expired — reclaimed from `x`.')).toBe(false);
  });

  it('lastMeaningfulNoteIndex skips trailing system notes', () => {
    const claim = buildClaimReclaimNote('owner');
    expect(lastMeaningfulNoteIndex(['a', 'FEEDBACK NEEDED: q', claim])).toBe(1);
    expect(lastMeaningfulNoteIndex(['FEEDBACK NEEDED: q', claim, buildClaimReclaimNote('null')])).toBe(0);
    expect(lastMeaningfulNoteIndex(['a', 'b'])).toBe(1);
    expect(lastMeaningfulNoteIndex([])).toBe(-1);
    expect(lastMeaningfulNoteIndex([claim])).toBe(-1); // all system → none meaningful
  });
});

// HS-9525 — "reclaimed from `null`" told the reader nothing. The wording changed;
// the PREFIX must not, because `isSystemStatusNote` recognizes the note by it.
describe('buildClaimReclaimNote — the unnamed-claimant case (HS-9525)', () => {
  it('names an unnamed worker instead of interpolating null', () => {
    for (const who of [null, undefined, '', '   ']) {
      const note = buildClaimReclaimNote(who);
      expect(note, String(who)).toContain(UNNAMED_CLAIMANT);
      expect(note, String(who)).not.toContain('null');
      expect(note, String(who)).not.toContain('undefined');
    }
  });

  it('still quotes a real claimant', () => {
    expect(buildClaimReclaimNote('worker-3')).toBe(`${CLAIM_RECLAIM_NOTE_PREFIX}\`worker-3\`.`);
  });

  it('KEEPS the system-note prefix in every case', () => {
    // The load-bearing invariant: lose the prefix and `isSystemStatusNote` stops
    // recognising the note, which silently resurrects the HS-9526 masking bug.
    for (const who of [null, undefined, '', 'worker-3']) {
      expect(isSystemStatusNote(buildClaimReclaimNote(who)), String(who)).toBe(true);
    }
  });
});
