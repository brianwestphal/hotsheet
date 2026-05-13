import { describe, expect, it } from 'vitest';

import { notesEndWithFeedback } from './feedback-state.js';

/**
 * HS-8378 — pure unit tests for `notesEndWithFeedback`. The DB-side
 * `projectHasPendingFeedback` is covered by the route-level test in
 * `projects.test.ts` (it needs a live PGLite). The pure helper is the
 * mirror of `hasPendingFeedback(ticket)` in `src/client/ticketRow.tsx` —
 * keeping the two behaviors aligned is what guarantees the cross-project
 * dot agrees with the active-project dot on the same ticket.
 */
describe('notesEndWithFeedback (HS-8378)', () => {
  it('returns false for null / undefined / empty / "[]"', () => {
    expect(notesEndWithFeedback(null)).toBe(false);
    expect(notesEndWithFeedback(undefined)).toBe(false);
    expect(notesEndWithFeedback('')).toBe(false);
    expect(notesEndWithFeedback('[]')).toBe(false);
    expect(notesEndWithFeedback('   ')).toBe(false);
  });

  it('returns true when the LAST note starts with `FEEDBACK NEEDED:`', () => {
    const notes = JSON.stringify([
      { text: 'Started work on the feature.', created_at: '2026-05-13T10:00:00Z' },
      { text: 'FEEDBACK NEEDED: Should we use a Map or a Set here?', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('returns true when the LAST note starts with `IMMEDIATE FEEDBACK NEEDED:`', () => {
    const notes = JSON.stringify([
      { text: 'IMMEDIATE FEEDBACK NEEDED: Build is broken — should I revert HS-8377?', created_at: '2026-05-13T12:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('returns false when a feedback prefix is on an EARLIER note but the latest is a response', () => {
    // This is the "user responded" path — the feedback was asked, then a
    // response note was appended, so the dot should clear.
    const notes = JSON.stringify([
      { text: 'FEEDBACK NEEDED: Should we use a Map or a Set here?', created_at: '2026-05-13T11:00:00Z' },
      { text: 'Use a Map.', created_at: '2026-05-13T11:05:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(false);
  });

  it('tolerates leading whitespace before the prefix', () => {
    // Mirrors the client `hasPendingFeedback` which `trim()`s before
    // matching — a chat-paste with a leading space shouldn't slip past
    // the check.
    const notes = JSON.stringify([
      { text: '   FEEDBACK NEEDED: trimmed prompt', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('returns false when the latest note lacks a `text` field', () => {
    const notes = JSON.stringify([
      { created_at: '2026-05-13T10:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(false);
  });

  it('returns false on non-JSON input', () => {
    expect(notesEndWithFeedback('this is not json')).toBe(false);
  });

  it('returns false when the JSON parses to a non-array shape', () => {
    expect(notesEndWithFeedback('{}')).toBe(false);
    expect(notesEndWithFeedback('"a string"')).toBe(false);
    expect(notesEndWithFeedback('42')).toBe(false);
  });

  it('returns false when an array entry is null', () => {
    expect(notesEndWithFeedback(JSON.stringify([null]))).toBe(false);
  });

  it('does NOT match a feedback prefix embedded mid-text', () => {
    // The prefix must be at the very start of the trimmed note for the
    // client-side check too — a casual mention of "FEEDBACK NEEDED:"
    // inside a longer note shouldn't trigger the dot.
    const notes = JSON.stringify([
      { text: 'Earlier I asked: FEEDBACK NEEDED: yes or no?', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(false);
  });
});
