/**
 * HS-9131 — internal cross-project copy/cut/paste clipboard (`clipboard.ts`).
 * The API + ticketList + state deps are mocked; the real kerf signal,
 * TicketSchema, and dedup logic run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  copyTickets,
  cutTicketIdsSignal,
  getCutTicketIds,
  hasClipboardTickets,
  pasteTickets,
} from './clipboard.js';
import type { Ticket } from './state.js';

const h = vi.hoisted(() => ({
  createTicket: vi.fn<(b: unknown) => Promise<{ id: number }>>(),
  putTicketNotesBulk: vi.fn<(id: number, notes: string) => void>(),
  copyTicketAttachments: vi.fn<(id: number, opts: unknown) => void>(),
  updateTicket: vi.fn<(id: number, body: unknown, opts?: unknown) => void>(),
  loadTickets: vi.fn<() => Promise<void>>(),
  renderTicketList: vi.fn<() => void>(),
  activeSecret: 'S',
  state: { tickets: [] as Ticket[], selectedIds: new Set<number>() },
}));
vi.mock('../api/index.js', () => ({
  createTicket: (b: unknown): Promise<{ id: number }> => h.createTicket(b),
  putTicketNotesBulk: (id: number, notes: string): Promise<void> => { h.putTicketNotesBulk(id, notes); return Promise.resolve(); },
  copyTicketAttachments: (id: number, opts: unknown): Promise<void> => { h.copyTicketAttachments(id, opts); return Promise.resolve(); },
  updateTicket: (id: number, body: unknown, opts?: unknown): Promise<unknown> => { h.updateTicket(id, body, opts); return Promise.resolve({}); },
}));
vi.mock('./ticketList.js', () => ({ loadTickets: (): Promise<void> => h.loadTickets(), renderTicketList: (): void => { h.renderTicketList(); } }));
vi.mock('./state.js', () => ({ state: h.state, getActiveProject: () => ({ secret: h.activeSecret }) }));

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 1, ticket_number: 'HS-1', title: 'T', details: '', category: 'task', priority: 'default',
    status: 'not_started', up_next: false, created_at: '', updated_at: '', completed_at: null,
    verified_at: null, deleted_at: null, notes: '', tags: '', last_read_at: null, ...over,
  };
}

let nextId = 100;
beforeEach(() => {
  nextId = 100;
  h.createTicket.mockReset().mockImplementation(() => Promise.resolve({ id: nextId++ }));
  h.putTicketNotesBulk.mockReset();
  h.copyTicketAttachments.mockReset();
  h.updateTicket.mockReset();
  h.loadTickets.mockReset().mockResolvedValue(undefined);
  h.renderTicketList.mockReset();
  h.activeSecret = 'S';
  h.state.tickets = [];
  h.state.selectedIds = new Set();
  copyTickets([], false); // clear
});
afterEach(() => { copyTickets([], false); });

describe('copy / cut state', () => {
  it('hasClipboardTickets reflects whether anything is stored', () => {
    expect(hasClipboardTickets()).toBe(false);
    copyTickets([ticket({ id: 1 })], false);
    expect(hasClipboardTickets()).toBe(true);
  });
  it('cutTicketIdsSignal/getCutTicketIds expose cut ids only for the source project', () => {
    copyTickets([ticket({ id: 1 }), ticket({ id: 2 })], true);
    expect(getCutTicketIds()).toEqual(new Set([1, 2]));
    expect(cutTicketIdsSignal.value).toEqual(new Set([1, 2]));
    // A copy (not cut) exposes no cut ids.
    copyTickets([ticket({ id: 3 })], false);
    expect(getCutTicketIds()).toEqual(new Set());
  });
  it('cut ids are hidden when the active project differs from the source', () => {
    copyTickets([ticket({ id: 1 })], true); // recorded with source secret 'S'
    h.activeSecret = 'OTHER';
    expect(cutTicketIdsSignal.value).toEqual(new Set());
  });
});

describe('pasteTickets', () => {
  it('is a no-op when the clipboard is empty', async () => {
    await pasteTickets();
    expect(h.createTicket).not.toHaveBeenCalled();
  });

  it('creates a copy per ticket, deduplicating titles against existing tickets', async () => {
    h.state.tickets = [ticket({ id: 9, title: 'Foo' })];
    copyTickets([ticket({ id: 1, title: 'Foo' }), ticket({ id: 2, title: 'Foo' })], false);
    await pasteTickets();
    const titles = h.createTicket.mock.calls.map(c => (c[0] as { title: string }).title);
    expect(titles).toEqual(['Foo (Copy)', 'Foo (Copy 2)']);
    expect(h.loadTickets).toHaveBeenCalled();
    expect(h.renderTicketList).toHaveBeenCalled();
    // Newly created ids selected.
    expect([...h.state.selectedIds]).toEqual([100, 101]);
  });

  it('copies notes only when the source had real notes', async () => {
    copyTickets([ticket({ id: 1, title: 'A', notes: '[{"text":"n"}]' }), ticket({ id: 2, title: 'B', notes: '[]' })], false);
    await pasteTickets();
    expect(h.putTicketNotesBulk).toHaveBeenCalledTimes(1);
    expect(h.putTicketNotesBulk).toHaveBeenCalledWith(100, '[{"text":"n"}]');
  });

  it('copies attachments from the source project (best-effort)', async () => {
    copyTickets([ticket({ id: 7, title: 'A' })], false);
    await pasteTickets();
    expect(h.copyTicketAttachments).toHaveBeenCalledWith(100, { sourceSecret: 'S', sourceTicketId: 7 });
  });

  it('a deleted-status source pastes back as not_started', async () => {
    copyTickets([ticket({ id: 1, title: 'A', status: 'deleted' })], false);
    await pasteTickets();
    expect((h.createTicket.mock.calls[0][0] as { defaults: { status: string } }).defaults.status).toBe('not_started');
  });

  it('on cut, deletes the originals in the source project + clears the clipboard', async () => {
    copyTickets([ticket({ id: 1, title: 'A' }), ticket({ id: 2, title: 'B' })], true);
    await pasteTickets();
    expect(h.updateTicket).toHaveBeenCalledWith(1, { status: 'deleted' }, { secret: 'S' });
    expect(h.updateTicket).toHaveBeenCalledWith(2, { status: 'deleted' }, { secret: 'S' });
    expect(hasClipboardTickets()).toBe(false); // clipboard cleared after a cut-paste
  });
});
