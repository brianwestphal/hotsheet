// @vitest-environment happy-dom
/**
 * HS-8645 — `parseNotesJson` must return a STABLE id for the same id-less note
 * across re-parses. `loadDetail` re-parses the notes column on every `/poll`
 * tick; the old random `clientNoteId()` drifted the id each parse, breaking the
 * HS-8644 feedback auto-show key, focus preservation, and `data-note-id`
 * stability. Server-created notes carry their own `id` and must be preserved
 * verbatim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiIndex from '../api/index.js';
import { deleteTicketNote, editTicketNote } from '../api/index.js';
import type { Ticket } from '../types.js';
import { _resetNotesDelegationForTests, parseNotesJson, renderNotes } from './noteRenderer.js';
import { state } from './state.js';

vi.mock('../api/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiIndex>()),
  editTicketNote: vi.fn(() => Promise.resolve({})),
  deleteTicketNote: vi.fn(() => Promise.resolve({})),
  deleteFeedbackDraft: vi.fn(() => Promise.resolve({})),
}));
vi.mock('./undo/actions.js', () => ({ pushNotesUndo: vi.fn() }));

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

/**
 * HS-8613 — the per-note listeners are delegated once at `#detail-notes`,
 * reading note identity from `data-note-id` + a module-level render context
 * (the container is reused across tickets). These tests cover the edit flow
 * through delegation and the context-swap correctness the design depends on.
 */
function ticket(id: number): Ticket {
  return { id, title: `T${id}`, details: '', notes: '', ticket_number: `HS-${id}` } as Ticket;
}
function noteEntry(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`#detail-notes .note-entry[data-note-id="${id}"]`);
  if (el === null) throw new Error(`no note-entry ${id}`);
  return el;
}

describe('renderNotes — delegated note interactions (HS-8613)', () => {
  beforeEach(() => {
    _resetNotesDelegationForTests();
    document.body.innerHTML = '<div id="detail-notes"></div>';
    vi.mocked(editTicketNote).mockClear();
    vi.mocked(deleteTicketNote).mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    state.tickets = [];
    _resetNotesDelegationForTests();
  });

  it('clicking a note enters edit mode (textarea seeded with the note text)', () => {
    state.tickets = [ticket(1)];
    const notes = [{ id: 'n1', text: 'first', created_at: '' }];
    renderNotes(1, notes);

    noteEntry('n1').click();
    const ta = noteEntry('n1').querySelector<HTMLTextAreaElement>('.note-edit-area');
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe('first');
  });

  it('Cmd+Enter commits the edit via editTicketNote with the right id + text', async () => {
    state.tickets = [ticket(2)];
    const notes = [{ id: 'n2', text: 'before', created_at: '' }];
    renderNotes(2, notes);

    noteEntry('n2').click();
    const ta = noteEntry('n2').querySelector<HTMLTextAreaElement>('.note-edit-area')!;
    ta.value = 'after';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    await vi.waitFor(() => { expect(vi.mocked(editTicketNote)).toHaveBeenCalledWith(2, 'n2', 'after'); });
    expect(notes[0].text).toBe('after');
  });

  it('right-click → Delete Note removes the note via deleteTicketNote', async () => {
    state.tickets = [ticket(3)];
    const notes = [{ id: 'n3', text: 'doomed', created_at: '' }];
    renderNotes(3, notes);

    noteEntry('n3').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    const item = document.querySelector<HTMLElement>('.note-context-menu .context-menu-item');
    expect(item).not.toBeNull();
    item!.click();
    await vi.waitFor(() => { expect(vi.mocked(deleteTicketNote)).toHaveBeenCalledWith(3, 'n3'); });
  });

  it('the bottom Add-note button forwards to the top add button', () => {
    state.tickets = [ticket(4)];
    const topBtn = document.createElement('button');
    topBtn.id = 'detail-add-note-btn';
    const clicked = vi.fn();
    topBtn.addEventListener('click', clicked);
    document.body.appendChild(topBtn);

    renderNotes(4, [{ id: 'n4', text: 'x', created_at: '' }]);
    document.querySelector<HTMLButtonElement>('.detail-add-note-bottom-btn')!.click();
    expect(clicked).toHaveBeenCalledTimes(1);
  });

  it('CONTEXT-SWAP REGRESSION: after re-rendering for a different ticket, the delegated edit hits the NEW ticket', async () => {
    state.tickets = [ticket(10), ticket(20)];
    // Render ticket 10's notes, then (same container) ticket 20's notes.
    renderNotes(10, [{ id: 'a', text: 'ten', created_at: '' }]);
    const notes20 = [{ id: 'b', text: 'twenty', created_at: '' }];
    renderNotes(20, notes20);

    noteEntry('b').click();
    const ta = noteEntry('b').querySelector<HTMLTextAreaElement>('.note-edit-area')!;
    ta.value = 'twenty-edited';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
    // Must edit ticket 20's note 'b' — not ticket 10 (whose context the
    // pre-fix per-element closures would have captured).
    await vi.waitFor(() => { expect(vi.mocked(editTicketNote)).toHaveBeenCalledWith(20, 'b', 'twenty-edited'); });
    expect(notes20[0].text).toBe('twenty-edited');
  });
});

/**
 * HS-8651 — `renderNotes` commits via `morph()` (was `replaceChildren`). These
 * pin the morph behaviors: in-place reconciliation (node identity preserved →
 * scroll/focus survive), in-progress inline-edit preservation across a
 * re-render (the full-payoff goal), and that a committed save still rebuilds
 * the entry into display mode.
 */
describe('renderNotes — morph reconciliation (HS-8651)', () => {
  beforeEach(() => {
    _resetNotesDelegationForTests();
    document.body.innerHTML = '<div id="detail-notes"></div>';
    vi.mocked(editTicketNote).mockClear();
    vi.mocked(deleteTicketNote).mockClear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    state.tickets = [];
    _resetNotesDelegationForTests();
  });

  it('reuses note-entry nodes across a same-data re-render (morph in place, not teardown)', () => {
    state.tickets = [ticket(1)];
    const notes = [{ id: 'a', text: 'one', created_at: '' }, { id: 'b', text: 'two', created_at: '' }];
    renderNotes(1, notes);
    const aEl = noteEntry('a');
    const bEl = noteEntry('b');

    renderNotes(1, notes); // re-render identical data

    // morph reconciles in place → SAME element instances (a `replaceChildren`
    // rebuild would have produced fresh nodes, resetting scroll + focus).
    expect(noteEntry('a')).toBe(aEl);
    expect(noteEntry('b')).toBe(bEl);
  });

  it('preserves existing note nodes when a new note is added (keyed by data-key)', () => {
    state.tickets = [ticket(1)];
    renderNotes(1, [{ id: 'a', text: 'one', created_at: '' }, { id: 'b', text: 'two', created_at: '' }]);
    const aEl = noteEntry('a');
    const bEl = noteEntry('b');

    // A new note arrives (e.g. via poll) — A and B keep their identity; C is new.
    renderNotes(1, [
      { id: 'a', text: 'one', created_at: '' },
      { id: 'b', text: 'two', created_at: '' },
      { id: 'c', text: 'three', created_at: '' },
    ]);
    expect(noteEntry('a')).toBe(aEl);
    expect(noteEntry('b')).toBe(bEl);
    expect(noteEntry('c')).not.toBeNull();
  });

  it('PRESERVES an in-progress (uncommitted) inline edit across a re-render', () => {
    state.tickets = [ticket(1)];
    const notes = [{ id: 'a', text: 'hello', created_at: '' }];
    renderNotes(1, notes);

    // Enter edit mode (delegated click injects the textarea).
    noteEntry('a').click();
    const ta = noteEntry('a').querySelector<HTMLTextAreaElement>('.note-edit-area');
    expect(ta).not.toBeNull();
    ta!.value = 'in-progress edit';

    // A re-render fires WHILE editing (e.g. a detail poll) — same note data.
    renderNotes(1, notes);

    // The textarea (and its unsaved value) survives — `commitNotesChildren`
    // marked the editing entry `data-morph-skip`. A `replaceChildren` rebuild
    // (or an un-skipped morph) would have discarded it.
    const taAfter = noteEntry('a').querySelector<HTMLTextAreaElement>('.note-edit-area');
    expect(taAfter).toBe(ta);
    expect(taAfter!.value).toBe('in-progress edit');
  });

  it('a committed save rebuilds the entry into display mode (textarea gone, new text shown)', async () => {
    state.tickets = [ticket(1)];
    const notes = [{ id: 'a', text: 'before', created_at: '' }];
    renderNotes(1, notes);

    noteEntry('a').click();
    const ta = noteEntry('a').querySelector<HTMLTextAreaElement>('.note-edit-area')!;
    ta.value = 'after';
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));

    await vi.waitFor(() => { expect(vi.mocked(editTicketNote)).toHaveBeenCalledWith(1, 'a', 'after'); });
    // The committed textarea is NOT skipped → morph rebuilt the entry: no
    // textarea, the new text rendered in `.note-text`.
    expect(noteEntry('a').querySelector('.note-edit-area')).toBeNull();
    expect(noteEntry('a').querySelector('.note-text')?.textContent).toContain('after');
  });
});
