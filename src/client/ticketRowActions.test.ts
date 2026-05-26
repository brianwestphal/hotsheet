// @vitest-environment happy-dom
/**
 * HS-8574 — coverage for the `cycleStatus` + `toggleUpNext` actions
 * on `src/client/ticketRow.tsx`. The existing `ticketRow.test.tsx` is
 * HS-8335 / HS-8357 / HS-8367 focused on per-row reactive effects and
 * never actually invokes either action — only references them in a
 * regression-rationale comment. This file fills that gap.
 *
 * Mock surface:
 *   - the typed `updateTicket` (so `trackedPatch`'s PATCH is observable +
 *     faked out — HS-8642 routed it through the typed API layer)
 *   - `ticketListState.registerCallbacks` is called with stub fns so
 *     the `callRenderTicketList` / `callLoadTickets` reaches inside
 *     the actions don't blow up with `null!` deref.
 *   - Real `ticketsStore` (its `_ticketsStoreForTesting.reset()` hook
 *     keeps state clean between cases).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from './state.js';
import { registerCallbacks } from './ticketListState.js';
import { cycleStatus, toggleUpNext } from './ticketRow.js';
import { _ticketsStoreForTesting, ticketsStore } from './ticketsStore.js';

// HS-8642 — `cycleStatus` / `toggleUpNext` route through `trackedPatch`, which
// now calls the typed `updateTicket` (after `UpdateTicketSchema.parse`). Mock
// the typed callers but keep the REAL request schemas so the `.parse()` inside
// `trackedPatch` works.
const mockUpdateTicket = vi.fn<(id: number, body: unknown) => Promise<unknown>>();
vi.mock('../api/index.js', async () => {
  const validation = await import('../routes/validation.js');
  return {
    BatchActionSchema: validation.BatchActionSchema,
    UpdateTicketSchema: validation.UpdateTicketSchema,
    updateTicket: (id: number, body: unknown): Promise<unknown> => mockUpdateTicket(id, body),
    batchTickets: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    deleteTicket: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    restoreTicket: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
    putTicketNotesBulk: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
  };
});

const mockRenderTicketList = vi.fn<() => void>();
const mockLoadTickets = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
const mockUpdateSelectionClasses = vi.fn<() => void>();
const mockUpdateBatchToolbar = vi.fn<() => void>();
const mockUpdateColumnSelectionClasses = vi.fn<() => void>();
const mockFocusDraftInput = vi.fn<() => void>();

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 1,
    ticket_number: 'HS-1',
    title: 'Test',
    details: '',
    category: 'task',
    priority: 'default',
    status: 'not_started',
    up_next: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    completed_at: null,
    verified_at: null,
    deleted_at: null,
    notes: '',
    tags: '[]',
    last_read_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockUpdateTicket.mockReset();
  mockRenderTicketList.mockReset();
  mockLoadTickets.mockReset().mockResolvedValue(undefined);
  _ticketsStoreForTesting.reset();
  registerCallbacks({
    renderTicketList: mockRenderTicketList,
    loadTickets: mockLoadTickets,
    updateSelectionClasses: mockUpdateSelectionClasses,
    updateBatchToolbar: mockUpdateBatchToolbar,
    updateColumnSelectionClasses: mockUpdateColumnSelectionClasses,
    focusDraftInput: mockFocusDraftInput,
  });
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
});

describe('cycleStatus — 6-status cycle', () => {
  const cycle: Array<[Ticket['status'], string]> = [
    ['not_started', 'started'],
    ['started', 'completed'],
    ['completed', 'verified'],
    ['verified', 'not_started'],
    ['backlog', 'not_started'],
    ['archive', 'not_started'],
  ];

  for (const [from, to] of cycle) {
    it(`PATCHes ${from} → ${to}`, async () => {
      const t = ticket({ status: from });
      ticketsStore.actions.setTickets([t]);
      mockUpdateTicket.mockResolvedValue({ ...t, status: to });

      await cycleStatus(t);

      expect(mockUpdateTicket).toHaveBeenCalledWith(1, { status: to });
      expect(mockRenderTicketList).toHaveBeenCalled();
    });
  }

  it('writes the updated status back to the closure ticket reference', async () => {
    const t = ticket({ status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, status: 'started' });

    await cycleStatus(t);

    expect(t.status).toBe('started');
  });

  it('routes through the store BEFORE mutating the closure (HS-8367 regression guard)', async () => {
    const t = ticket({ status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    // Capture the in-flight `ticket` state observed by
    // `applyServerUpdate` so we can prove it sees the updated status
    // and NOT the pre-cycle one (HS-8367's "closure mutated before
    // store, store sees same ref, skips signal fire" bug).
    let storeObservedStatus: string | null = null;
    const applySpy = vi.spyOn(ticketsStore.actions, 'applyServerUpdate').mockImplementation((u) => {
      storeObservedStatus = u.status;
    });
    mockUpdateTicket.mockResolvedValue({ ...t, status: 'started' });

    await cycleStatus(t);

    expect(applySpy).toHaveBeenCalled();
    expect(storeObservedStatus).toBe('started');
    applySpy.mockRestore();
  });
});

describe('toggleUpNext — basic flip', () => {
  it('PATCHes up_next=true when starring an unstarred not_started ticket', async () => {
    const t = ticket({ up_next: false, status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    await toggleUpNext(t);

    expect(mockUpdateTicket).toHaveBeenCalledWith(1, { up_next: true });
    expect(t.up_next).toBe(true);
  });

  it('PATCHes up_next=false when unstarring a starred ticket (no status reset)', async () => {
    const t = ticket({ up_next: true, status: 'completed' });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: false });

    await toggleUpNext(t);

    // Unstar path takes the simple `up_next: false` branch — no
    // status reset even though the ticket is completed.
    expect(mockUpdateTicket).toHaveBeenCalledWith(1, { up_next: false });
  });
});

describe('toggleUpNext — HS-7998 status reset on add', () => {
  const resetStatuses: Array<Ticket['status']> = ['completed', 'verified', 'backlog', 'archive'];

  for (const status of resetStatuses) {
    it(`resets ${status} → not_started when starring`, async () => {
      const t = ticket({ status, up_next: false });
      ticketsStore.actions.setTickets([t]);
      mockUpdateTicket.mockResolvedValue({ ...t, status: 'not_started', up_next: true });

      await toggleUpNext(t);

      expect(mockUpdateTicket).toHaveBeenCalledWith(1, { status: 'not_started', up_next: true });
    });
  }

  it('does NOT reset status for `started` (already in flight)', async () => {
    const t = ticket({ status: 'started', up_next: false });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    await toggleUpNext(t);

    // `started` is not in the reset set — the call should be the
    // plain `up_next: true` shape, NOT the compound `status +
    // up_next` shape.
    expect(mockUpdateTicket).toHaveBeenCalledWith(1, { up_next: true });
  });

  it('does NOT reset status for `not_started` either (already there)', async () => {
    const t = ticket({ status: 'not_started', up_next: false });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    await toggleUpNext(t);

    expect(mockUpdateTicket).toHaveBeenCalledWith(1, { up_next: true });
  });
});

describe('toggleUpNext — side effects', () => {
  it('dispatches the `hotsheet:upnext-changed` custom event', async () => {
    const t = ticket({ up_next: false });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    const handler = vi.fn();
    document.addEventListener('hotsheet:upnext-changed', handler);
    await toggleUpNext(t);
    document.removeEventListener('hotsheet:upnext-changed', handler);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reloads tickets via callLoadTickets', async () => {
    const t = ticket({ up_next: false });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    await toggleUpNext(t);
    // `void callLoadTickets()` — the action doesn't await the
    // reload, so drain the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLoadTickets).toHaveBeenCalled();
  });

  it('writes the updated up_next back to the closure ticket reference', async () => {
    const t = ticket({ up_next: false });
    ticketsStore.actions.setTickets([t]);
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    await toggleUpNext(t);

    expect(t.up_next).toBe(true);
  });

  it('routes through the store BEFORE mutating the closure (HS-8367 regression guard)', async () => {
    const t = ticket({ up_next: false });
    ticketsStore.actions.setTickets([t]);
    let storeObservedUpNext: boolean | null = null;
    const applySpy = vi.spyOn(ticketsStore.actions, 'applyServerUpdate').mockImplementation((u) => {
      storeObservedUpNext = u.up_next;
    });
    mockUpdateTicket.mockResolvedValue({ ...t, up_next: true });

    await toggleUpNext(t);

    expect(applySpy).toHaveBeenCalled();
    expect(storeObservedUpNext).toBe(true);
    applySpy.mockRestore();
  });
});
