// @vitest-environment happy-dom
/** HS-9143 — `bindDetailNotes` "Add note" click-handler branches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailNotes } from './notes.js';

const h = vi.hoisted(() => ({
  state: { activeTicketId: null as number | null, tickets: [] as Array<{ id: number; notes: string }> },
  putTicketNotesBulk: vi.fn<(id: number, json: string) => Promise<void>>(),
  pushNotesUndo: vi.fn(),
  openDetailAndFocusNote: vi.fn(),
}));
vi.mock('../../api/index.js', () => ({ putTicketNotesBulk: h.putTicketNotesBulk }));
vi.mock('../detail.js', () => ({ openDetailAndFocusNote: h.openDetailAndFocusNote }));
vi.mock('../state.js', () => ({ state: h.state }));
vi.mock('../undo/actions.js', () => ({ pushNotesUndo: h.pushNotesUndo }));
vi.mock('../json.js', () => ({ parseJsonArrayOr: (s: string, d: unknown[]): unknown[] => { try { const v: unknown = JSON.parse(s); return Array.isArray(v) ? (v as unknown[]) : d; } catch { return d; } } }));

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<button id="detail-add-note-btn"></button>';
  h.state.activeTicketId = null;
  h.state.tickets = [];
  for (const k of ['putTicketNotesBulk', 'pushNotesUndo', 'openDetailAndFocusNote'] as const) h[k].mockReset();
  h.putTicketNotesBulk.mockResolvedValue(undefined);
  bindDetailNotes();
});
afterEach(() => { document.body.innerHTML = ''; });

const click = async (): Promise<void> => { document.getElementById('detail-add-note-btn')!.click(); await flush(); };

describe('bindDetailNotes', () => {
  it('no-ops when no ticket is active', async () => {
    await click();
    expect(h.putTicketNotesBulk).not.toHaveBeenCalled();
  });

  it('no-ops when the active ticket is not in local state', async () => {
    h.state.activeTicketId = 5; // not in tickets
    await click();
    expect(h.putTicketNotesBulk).not.toHaveBeenCalled();
  });

  it('appends an empty note, records undo, and focuses it', async () => {
    h.state.activeTicketId = 5;
    h.state.tickets = [{ id: 5, notes: '[{"id":"n1","text":"old","created_at":"t"}]' }];
    await click();
    expect(h.putTicketNotesBulk).toHaveBeenCalledTimes(1);
    const [id, json] = h.putTicketNotesBulk.mock.calls[0];
    expect(id).toBe(5);
    const arr = JSON.parse(json) as Array<{ text: string }>;
    expect(arr).toHaveLength(2);              // old + new
    expect(arr[1].text).toBe('');             // new note starts empty
    expect(h.pushNotesUndo).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'Add note', json);
    expect(h.openDetailAndFocusNote).toHaveBeenCalledWith(5, expect.any(String));
    // The store's copy was updated to the new JSON.
    expect(h.state.tickets[0].notes).toBe(json);
  });

  it('starts a fresh array when existing notes are not valid JSON', async () => {
    h.state.activeTicketId = 7;
    h.state.tickets = [{ id: 7, notes: 'not json' }];
    await click();
    const json = h.putTicketNotesBulk.mock.calls[0][1];
    expect(JSON.parse(json)).toHaveLength(1); // fell back to [] then appended one
  });
});
