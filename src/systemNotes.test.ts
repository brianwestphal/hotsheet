import { describe, expect, it } from 'vitest';

import { buildClaimReclaimNote, CLAIM_RECLAIM_NOTE_PREFIX, isSystemStatusNote, lastMeaningfulNoteIndex } from './systemNotes.js';

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
