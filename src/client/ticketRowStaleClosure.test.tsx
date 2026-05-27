// @vitest-environment happy-dom
/**
 * HS-8652 — regression guard for the stale-closure bug in the ticket-list /
 * column-view per-row handlers.
 *
 * `bindList` PRESERVES a row across same-key data changes (it never re-invokes
 * the row factory), so the `ticket` object a row's handler closes over goes
 * STALE after an EXTERNAL update (channel / MCP / another tab) that replaces
 * the per-ticket signal value. The fix: every handler that reads a MUTABLE
 * field re-fetches the live ticket by id via `liveTicket(id, fallback)`. These
 * tests build a REAL row via `createTicketRow` / `createColumnCard`, push an
 * external `applyServerUpdate`, fire the handler, and assert it acted on the
 * NEW data (the assertions invert under the pre-fix closure read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createColumnCard } from './columnView.js';
import type { Ticket } from './state.js';
import { state } from './state.js';
import { registerCallbacks } from './ticketListState.js';
import { createTicketRow, liveTicket } from './ticketRow.js';
import {
  _clearPerTicketSignalsForTesting,
  _ticketsStoreForTesting,
  ticketsStore,
} from './ticketsStore.js';
import { trackedPatch } from './undo/actions.js';

// trackedPatch is the chokepoint every mutable-field handler routes through
// (cycleStatus / toggleUpNext / setTicketField / category+priority menus). Mock
// it to echo `{ ...ticket, ...patch }` so cycleStatus's downstream
// `applyServerUpdate(updated)` gets a valid ticket, and spy on its args.
vi.mock('./undo/actions.js', () => ({
  trackedPatch: vi.fn((ticket: Ticket, patch: Partial<Ticket>) => Promise.resolve({ ...ticket, ...patch })),
  trackedDelete: vi.fn(() => Promise.resolve()),
  trackedRestore: vi.fn(() => Promise.resolve()),
  recordTextChange: vi.fn(),
}));

function makeTicket(id: number, overrides: Partial<Ticket> = {}): Ticket {
  return {
    id,
    ticket_number: `HS-${id}`,
    title: `Ticket ${id}`,
    details: '',
    category: 'feature',
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
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  vi.mocked(trackedPatch).mockClear();
  // ticketList.tsx registers these at boot; tests need no-ops so the
  // post-mutation `callRenderTicketList()` etc. don't NPE on the `!` assertion.
  registerCallbacks({
    renderTicketList: () => { /* no-op */ },
    loadTickets: () => Promise.resolve(),
    updateSelectionClasses: () => { /* no-op */ },
    updateBatchToolbar: () => { /* no-op */ },
    updateColumnSelectionClasses: () => { /* no-op */ },
    focusDraftInput: () => { /* no-op */ },
  });
  state.selectedIds = new Set();
  document.body.innerHTML = '';
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  document.body.innerHTML = '';
});

describe('liveTicket (HS-8652)', () => {
  it('returns the freshest per-ticket signal value after an external update, not the stale fallback', () => {
    const stale = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([stale]);
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'started' }));
    // The fallback (the row's original closure object) still says not_started.
    expect(stale.status).toBe('not_started');
    // liveTicket re-fetches the current value.
    expect(liveTicket(1, stale).status).toBe('started');
  });

  it('falls back to the provided object when the id is no longer in the store', () => {
    const gone = makeTicket(42, { status: 'completed' });
    ticketsStore.actions.setTickets([]); // empty store
    expect(liveTicket(42, gone)).toBe(gone);
  });
});

describe('createTicketRow handlers read the live ticket (HS-8652)', () => {
  it('status-cycle advances from the NEW status after an external update (not the stale closure status)', () => {
    const t = makeTicket(1, { status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const row = createTicketRow(t);
    document.body.appendChild(row);

    // EXTERNAL update flips status not_started -> started (new object; the
    // closure `t` still reads not_started).
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { status: 'started' }));

    row.querySelector<HTMLButtonElement>('.ticket-status-btn')!.click();

    // cycle: started -> completed. The stale closure (not_started) would have
    // produced 'started' instead.
    expect(vi.mocked(trackedPatch)).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(trackedPatch).mock.calls[0];
    expect(patch).toEqual({ status: 'completed' });
  });

  it('star toggle removes from up_next after an external add (reads the live up_next=true)', () => {
    const t = makeTicket(1, { up_next: false, status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const row = createTicketRow(t);
    document.body.appendChild(row);

    // EXTERNAL update adds the ticket to up_next.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { up_next: true, status: 'not_started' }));

    row.querySelector<HTMLButtonElement>('.ticket-star')!.click();

    // Live up_next=true -> toggle to false (remove). The stale closure
    // (up_next=false) would have patched up_next:true (a server no-op, leaving
    // the star visually stuck).
    expect(vi.mocked(trackedPatch)).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(trackedPatch).mock.calls[0];
    expect(patch).toMatchObject({ up_next: false });
  });

  it('category menu highlights the live category as active after an external change', () => {
    state.categories = [
      { id: 'feature', label: 'Feature', shortLabel: 'FT', color: '#111111', shortcutKey: 'f', description: '' },
      { id: 'bug', label: 'Bug', shortLabel: 'BG', color: '#ff0000', shortcutKey: 'b', description: '' },
    ];
    const t = makeTicket(1, { category: 'feature' });
    ticketsStore.actions.setTickets([t]);
    const row = createTicketRow(t);
    document.body.appendChild(row);

    // EXTERNAL update changes the category feature -> bug.
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { category: 'bug' }));

    row.querySelector<HTMLElement>('.ticket-category-badge')!.click();

    // The open dropdown should mark the LIVE category (bug) active, not the
    // stale closure category (feature). `createDropdown` adds the `active`
    // class to the matched item.
    const active = Array.from(document.querySelectorAll<HTMLElement>('.dropdown-item'))
      .find(el => el.classList.contains('active'));
    expect(active).toBeDefined();
    expect(active?.textContent ?? '').toContain('Bug');
  });
});

describe('createColumnCard handlers read the live ticket (HS-8652)', () => {
  it('star toggle removes from up_next after an external add', () => {
    const t = makeTicket(1, { up_next: false, status: 'not_started' });
    ticketsStore.actions.setTickets([t]);
    const card = createColumnCard(t);
    document.body.appendChild(card);

    ticketsStore.actions.applyServerUpdate(makeTicket(1, { up_next: true, status: 'not_started' }));

    card.querySelector<HTMLButtonElement>('.ticket-star')!.click();

    expect(vi.mocked(trackedPatch)).toHaveBeenCalledTimes(1);
    const [, patch] = vi.mocked(trackedPatch).mock.calls[0];
    expect(patch).toMatchObject({ up_next: false });
  });
});
