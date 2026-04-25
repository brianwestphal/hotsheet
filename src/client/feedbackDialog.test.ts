import { describe, expect, it } from 'vitest';

import { pickDraftForFeedbackNote } from './feedbackDialog.js';

/**
 * HS-7822 — pickDraftForFeedbackNote pure-helper tests. The helper drives
 * the auto-show flow on detail-panel open: when the latest note is a
 * FEEDBACK NEEDED request and a saved draft exists for it, the dialog
 * should open with the draft pre-loaded instead of the original prompt.
 */
describe('pickDraftForFeedbackNote', () => {
  it('returns null when there are no drafts', () => {
    expect(pickDraftForFeedbackNote([], 'note-1')).toBeNull();
  });

  it('matches the parentNoteId-bound draft over a floating one', () => {
    const drafts = [
      { id: 'd1', parentNoteId: null, updatedAt: '2026-04-26T10:00:00Z' },
      { id: 'd2', parentNoteId: 'note-1', updatedAt: '2026-04-26T08:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('d2');
  });

  it('picks the most recently updated draft when several match the same parent note', () => {
    const drafts = [
      { id: 'old', parentNoteId: 'note-1', updatedAt: '2026-04-25T10:00:00Z' },
      { id: 'newer', parentNoteId: 'note-1', updatedAt: '2026-04-26T10:00:00Z' },
      { id: 'oldest', parentNoteId: 'note-1', updatedAt: '2026-04-24T10:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('newer');
  });

  it('falls back to the most recent free-floating draft when no parent-matching draft exists', () => {
    // Free-floating drafts (parentNoteId === null) survive when their
    // original parent FEEDBACK note is deleted — see docs/21-feedback.md
    // §21.2.3.
    const drafts = [
      { id: 'd1', parentNoteId: 'other-note', updatedAt: '2026-04-26T10:00:00Z' },
      { id: 'free-old', parentNoteId: null, updatedAt: '2026-04-25T10:00:00Z' },
      { id: 'free-newer', parentNoteId: null, updatedAt: '2026-04-26T11:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('free-newer');
  });

  it('returns null when no draft matches the active note nor floats free', () => {
    const drafts = [
      { id: 'd1', parentNoteId: 'other-note', updatedAt: '2026-04-26T10:00:00Z' },
    ];
    expect(pickDraftForFeedbackNote(drafts, 'note-1')).toBeNull();
  });

  it('preserves the input draft shape — extra fields on the input pass through to the returned reference', () => {
    interface FullDraft {
      id: string;
      parentNoteId: string | null;
      updatedAt: string;
      promptText: string;
    }
    const drafts: FullDraft[] = [
      { id: 'd1', parentNoteId: 'note-1', updatedAt: '2026-04-26T10:00:00Z', promptText: 'Saved' },
    ];
    const picked = pickDraftForFeedbackNote<FullDraft>(drafts, 'note-1');
    expect(picked?.promptText).toBe('Saved');
  });

  it('handles missing updatedAt fields gracefully (treats as oldest)', () => {
    const drafts = [
      { id: 'no-ts', parentNoteId: 'note-1' },
      { id: 'with-ts', parentNoteId: 'note-1', updatedAt: '2026-04-26T10:00:00Z' },
    ];
    const picked = pickDraftForFeedbackNote(drafts, 'note-1');
    expect(picked?.id).toBe('with-ts');
  });
});
