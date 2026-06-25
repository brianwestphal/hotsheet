// @vitest-environment happy-dom
// HS-9052 — `toggleReadState` must update each ticket's per-row reactive SIGNAL
// (not just mutate the object in place) so the bindList-preserved list / column
// rows re-run their `syncUnreadDot` effect immediately. Unlike `actions.test.ts`,
// this exercises the REAL `ticketsStore` + the `state.tickets` getter over it (so
// the optimistic update actually lands), and asserts the per-ticket signal value
// changed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from '../state.js';
import { _clearPerTicketSignalsForTesting, getTicketSignals, ticketsStore } from '../ticketsStore.js';
import { toggleReadState } from './actions.js';

const mocks = vi.hoisted(() => ({
  batchTickets: vi.fn((_req: { ids: number[]; action: string; value?: unknown }) => Promise.resolve({})),
  renderTicketList: vi.fn(),
  loadTickets: vi.fn(() => Promise.resolve()),
  refreshDetail: vi.fn(),
  setSuppressAutoRead: vi.fn(),
  updateTicket: vi.fn(() => Promise.resolve({})),
}));

// Mock only the side-effecting deps — NOT `../state.js` / `../ticketsStore.js`,
// so the read-state change flows through the real store + the `state.tickets`
// getter (the whole point of the fix).
vi.mock('../../api/index.js', async () => {
  const validation = await import('../../routes/validation.js');
  return {
    BatchActionSchema: validation.BatchActionSchema,
    UpdateTicketSchema: validation.UpdateTicketSchema,
    batchTickets: mocks.batchTickets,
    updateTicket: mocks.updateTicket,
    deleteTicket: vi.fn(() => Promise.resolve({})),
    restoreTicket: vi.fn(() => Promise.resolve({})),
    putTicketNotesBulk: vi.fn(() => Promise.resolve({})),
  };
});
vi.mock('../detail.js', () => ({ refreshDetail: mocks.refreshDetail, setSuppressAutoRead: mocks.setSuppressAutoRead }));
vi.mock('../ticketList.js', () => ({ loadTickets: mocks.loadTickets, renderTicketList: mocks.renderTicketList }));

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 1, ticket_number: 'HS-1', title: 'T', details: '', category: 'feature', priority: 'default',
    status: 'not_started', up_next: false, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    completed_at: null, verified_at: null, deleted_at: null, notes: '', tags: '[]', last_read_at: null, ...over,
  };
}

describe('toggleReadState — fires the per-row signal (HS-9052)', () => {
  beforeEach(() => {
    _clearPerTicketSignalsForTesting();
    ticketsStore.actions.setTickets([]);
    vi.clearAllMocks();
  });

  afterEach(() => {
    _clearPerTicketSignalsForTesting();
    ticketsStore.actions.setTickets([]);
  });

  it('mark-as-read updates the ticket signal value (so the unread dot clears live)', async () => {
    // Unread: updated_at > last_read_at.
    ticketsStore.actions.setTickets([ticket({ id: 1, updated_at: '2026-01-02T00:00:00Z', last_read_at: '2026-01-01T00:00:00Z' })]);
    const before = getTicketSignals(1)?.ticket.value.last_read_at;

    await toggleReadState([1]);

    const after = getTicketSignals(1)?.ticket.value.last_read_at;
    expect(after).not.toBe(before);
    // Now read — last_read_at moved to >= updated_at.
    expect(after !== null && after !== undefined && after >= '2026-01-02T00:00:00Z').toBe(true);
    expect(mocks.batchTickets.mock.calls[0]?.[0]).toMatchObject({ action: 'mark_read' });
  });

  it('mark-as-unread updates the ticket signal value (so the unread dot appears live)', async () => {
    // Read: last_read_at >= updated_at.
    ticketsStore.actions.setTickets([ticket({ id: 1, updated_at: '2026-01-01T00:00:00Z', last_read_at: '2026-01-02T00:00:00Z' })]);
    const before = getTicketSignals(1)?.ticket.value.last_read_at;

    await toggleReadState([1]);

    const after = getTicketSignals(1)?.ticket.value.last_read_at;
    expect(after).not.toBe(before);
    expect(after).toBe('1970-01-01T00:00:00Z'); // the epoch sentinel = unread
    expect(mocks.batchTickets.mock.calls[0]?.[0]).toMatchObject({ action: 'mark_unread' });
  });
});
