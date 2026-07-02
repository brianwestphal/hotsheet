import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { notesEndWithFeedback, projectHasPendingFeedback } from './feedback-state.js';
import { buildClaimReclaimNote } from './systemNotes.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

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

  // HS-9289 — a claim-lease-reclaim SYSTEM note appended after the FEEDBACK
  // NEEDED note must NOT hide the pending state (the reader skips trailing
  // system notes to find the last MEANINGFUL note).
  it('stays true when a claim-reclaim system note follows the feedback note', () => {
    const notes = JSON.stringify([
      { text: 'FEEDBACK NEEDED: which option?', created_at: '2026-05-13T11:00:00Z' },
      { text: buildClaimReclaimNote('owner'), created_at: '2026-05-13T11:30:00Z' },
      { text: buildClaimReclaimNote('null'), created_at: '2026-05-13T12:00:00Z' }, // multiple trailing system notes
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('stays false when a real response (not a system note) follows the feedback note', () => {
    const notes = JSON.stringify([
      { text: 'FEEDBACK NEEDED: which option?', created_at: '2026-05-13T11:00:00Z' },
      { text: 'Use a Map.', created_at: '2026-05-13T11:05:00Z' },
      { text: buildClaimReclaimNote('owner'), created_at: '2026-05-13T11:30:00Z' },
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

  it('HS-8702 — matches the phrase embedded mid-text (relaxed from start-only)', () => {
    // Pre-HS-8702 the phrase had to be at the very start of the note. AIs
    // don't always follow that, so the phrase anywhere in the LAST note now
    // counts — the user still gets pulled to the prompt.
    const notes = JSON.stringify([
      { text: 'Some context first. FEEDBACK NEEDED: yes or no?', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('HS-8702 — matches without the trailing colon', () => {
    const notes = JSON.stringify([
      { text: 'FEEDBACK NEEDED which approach should I take?', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('HS-8702 — matches IMMEDIATE FEEDBACK NEEDED embedded mid-text', () => {
    const notes = JSON.stringify([
      { text: 'Heads up — IMMEDIATE FEEDBACK NEEDED: build is broken.', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(true);
  });

  it('HS-8702 — case-sensitive: lowercase prose does NOT false-positive', () => {
    const notes = JSON.stringify([
      { text: 'I think feedback needed from the user before continuing.', created_at: '2026-05-13T11:00:00Z' },
    ]);
    expect(notesEndWithFeedback(notes)).toBe(false);
  });
});

/**
 * HS-8381 — `projectHasPendingFeedback` must exclude backlog + archive
 * (in addition to the pre-existing `deleted` exclusion) so the purple
 * project-tab dot only flags actionable feedback prompts. A FEEDBACK
 * NEEDED note left on a ticket that's been moved to backlog or archive
 * is set aside on purpose and shouldn't pull attention to the project.
 */
describe('projectHasPendingFeedback (HS-8381 — bucket exclusions)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await setupTestDb();
  });

  afterEach(async () => {
    await cleanupTestDb(tempDir);
  });

  async function insertTicketWithFeedback(status: string): Promise<void> {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    const notes = JSON.stringify([
      { id: 'n1', text: 'FEEDBACK NEEDED: confirm?', created_at: '2026-05-14T10:00:00Z' },
    ]);
    await db.query(
      `INSERT INTO tickets (ticket_number, title, details, category, priority, status, up_next, notes, tags)
       VALUES ($1, $2, '', 'bug', 'default', $3, false, $4, '[]')`,
      [`HS-${Math.floor(Math.random() * 1_000_000)}`, `Ticket ${status}`, status, notes],
    );
  }

  it('returns true when a non_started ticket has a pending feedback prompt', async () => {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    await insertTicketWithFeedback('not_started');
    expect(await projectHasPendingFeedback(db)).toBe(true);
  });

  it('returns false when the only feedback-prompt ticket is in backlog', async () => {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    await insertTicketWithFeedback('backlog');
    expect(await projectHasPendingFeedback(db)).toBe(false);
  });

  it('returns false when the only feedback-prompt ticket is in archive', async () => {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    await insertTicketWithFeedback('archive');
    expect(await projectHasPendingFeedback(db)).toBe(false);
  });

  it('returns false when the only feedback-prompt ticket is deleted', async () => {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    await insertTicketWithFeedback('deleted');
    expect(await projectHasPendingFeedback(db)).toBe(false);
  });

  it('returns true when an active ticket has feedback even alongside backlog/archive feedback tickets', async () => {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    await insertTicketWithFeedback('backlog');
    await insertTicketWithFeedback('archive');
    await insertTicketWithFeedback('started');
    expect(await projectHasPendingFeedback(db)).toBe(true);
  });

  it('returns false when no tickets have notes at all', async () => {
    const { getDb } = await import('./db/connection.js');
    const db = await getDb();
    expect(await projectHasPendingFeedback(db)).toBe(false);
  });
});
