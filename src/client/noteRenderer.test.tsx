// @vitest-environment happy-dom
/**
 * HS-8645 — `parseNotesJson` must return a STABLE id for the same id-less note
 * across re-parses. `loadDetail` re-parses the notes column on every `/poll`
 * tick; the old random `clientNoteId()` drifted the id each parse, breaking the
 * HS-8644 feedback auto-show key, focus preservation, and `data-note-id`
 * stability. Server-created notes carry their own `id` and must be preserved
 * verbatim.
 */
import { describe, expect, it } from 'vitest';

import { parseNotesJson } from './noteRenderer.js';

describe('parseNotesJson — deterministic id-less ids (HS-8645)', () => {
  it('returns the SAME id for the same id-less note across two parses', () => {
    const raw = JSON.stringify([{ text: 'hello', created_at: '2026-05-26T00:00:00Z' }]);
    const a = parseNotesJson(raw);
    const b = parseNotesJson(raw);
    expect(a[0].id).toBe(b[0].id);
    expect(a[0].id).not.toBe(''); // an id is still assigned
  });

  it('preserves a server-supplied id verbatim (only id-less notes are derived)', () => {
    const notes = parseNotesJson(JSON.stringify([{ id: 'n_server_1', text: 'x', created_at: 'y' }]));
    expect(notes[0].id).toBe('n_server_1');
  });

  it('gives two distinct id-less notes distinct ids (index keeps them unique even with identical text + created_at)', () => {
    const notes = parseNotesJson(JSON.stringify([
      { text: 'dup', created_at: 't' },
      { text: 'dup', created_at: 't' },
    ]));
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('id-less notes with differing content get different ids', () => {
    const notes = parseNotesJson(JSON.stringify([
      { text: 'alpha', created_at: 't' },
      { text: 'beta', created_at: 't' },
    ]));
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('the non-JSON raw-string fallback is deterministic across parses', () => {
    const a = parseNotesJson('just a plain string note');
    const b = parseNotesJson('just a plain string note');
    expect(a).toHaveLength(1);
    expect(a[0].id).toBe(b[0].id);
  });

  it('empty input yields no notes', () => {
    expect(parseNotesJson('')).toEqual([]);
    expect(parseNotesJson('   ')).toEqual([]); // whitespace-only is not JSON and not a real note
  });
});
