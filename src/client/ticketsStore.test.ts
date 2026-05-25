// @vitest-environment happy-dom
/**
 * §61 Phase 2 prep / HS-8321 — unit tests for the `ticketsStore`
 * factory in isolation. The store has no consumers wired yet (HS-8239
 * is the atomic-flip ticket); these tests exercise the actions +
 * `filteredTickets` derived signal directly so the contract is pinned
 * before the rewiring lands.
 *
 * Test pattern matches the §61 documented convention (see
 * `channelUI.test.ts`): `_ticketsStoreForTesting.reset()` in
 * `beforeEach` + `afterEach` for isolation, all assertions go through
 * the public action + state surface, no mocking of kerf internals.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { effect } from './reactive.js';
import type { Ticket } from './state.js';
import {
  _clearPerTicketSignalsForTesting,
  _ticketsStoreForTesting,
  DEFAULT_FILTER,
  effectiveView,
  filteredTickets,
  type FilterState,
  getTicketSignals,
  ticketsByStatusSignal,
  ticketsStore,
} from './ticketsStore.js';

beforeEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
});

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

describe('ticketsStore — initial state', () => {
  it('starts with an empty ticket list', () => {
    expect(ticketsStore.state.value.tickets).toEqual([]);
  });

  it('starts with the documented default filter', () => {
    expect(ticketsStore.state.value.filter).toEqual(DEFAULT_FILTER);
  });

  it('starts with no selection', () => {
    expect(ticketsStore.state.value.selectedId).toBeNull();
  });

  it('reset() returns the store to the initial state after mutations', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    ticketsStore.actions.select(1);
    ticketsStore.actions.patchFilter({ search: 'foo' });
    expect(ticketsStore.state.value.tickets.length).toBe(2);
    expect(ticketsStore.state.value.selectedId).toBe(1);
    expect(ticketsStore.state.value.filter.search).toBe('foo');
    _ticketsStoreForTesting.reset();
    expect(ticketsStore.state.value.tickets).toEqual([]);
    expect(ticketsStore.state.value.selectedId).toBeNull();
    expect(ticketsStore.state.value.filter).toEqual(DEFAULT_FILTER);
  });
});

describe('ticketsStore — setTickets / setFilter / patchFilter / select', () => {
  it('setTickets replaces the entire list', () => {
    ticketsStore.actions.setTickets([makeTicket(1)]);
    expect(ticketsStore.state.value.tickets.map(t => t.id)).toEqual([1]);
    ticketsStore.actions.setTickets([makeTicket(2), makeTicket(3)]);
    expect(ticketsStore.state.value.tickets.map(t => t.id)).toEqual([2, 3]);
  });

  it('setFilter replaces the filter wholesale', () => {
    const next: FilterState = { view: 'mine', search: 'bug', includeBacklogInSearch: true, includeArchiveInSearch: false };
    ticketsStore.actions.setFilter(next);
    expect(ticketsStore.state.value.filter).toEqual(next);
  });

  it('patchFilter merges a partial update on top of the current filter', () => {
    ticketsStore.actions.patchFilter({ search: 'auth' });
    expect(ticketsStore.state.value.filter).toEqual({ ...DEFAULT_FILTER, search: 'auth' });
    ticketsStore.actions.patchFilter({ includeArchiveInSearch: true });
    expect(ticketsStore.state.value.filter).toEqual({
      ...DEFAULT_FILTER,
      search: 'auth',
      includeArchiveInSearch: true,
    });
  });

  it('select sets / clears the selectedId', () => {
    ticketsStore.actions.select(42);
    expect(ticketsStore.state.value.selectedId).toBe(42);
    ticketsStore.actions.select(null);
    expect(ticketsStore.state.value.selectedId).toBeNull();
  });
});

describe('ticketsStore — applyServerUpdate', () => {
  it('replaces the matching ticket by id, leaves others alone', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'Original' }), makeTicket(2, { title: 'Other' })]);
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { title: 'Updated' }));
    const tickets = ticketsStore.state.value.tickets;
    expect(tickets.find(t => t.id === 1)?.title).toBe('Updated');
    expect(tickets.find(t => t.id === 2)?.title).toBe('Other');
  });

  it('no-ops when the id isn\'t present in the current list', () => {
    ticketsStore.actions.setTickets([makeTicket(1)]);
    const before = ticketsStore.state.value.tickets;
    ticketsStore.actions.applyServerUpdate(makeTicket(99));
    // Same array reference — no signal write fired.
    expect(ticketsStore.state.value.tickets).toBe(before);
  });
});

describe('ticketsStore — removeTicket', () => {
  it('drops the matching ticket from the list', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2), makeTicket(3)]);
    ticketsStore.actions.removeTicket(2);
    expect(ticketsStore.state.value.tickets.map(t => t.id)).toEqual([1, 3]);
  });

  it('clears selectedId when the dropped ticket was selected', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    ticketsStore.actions.select(2);
    ticketsStore.actions.removeTicket(2);
    expect(ticketsStore.state.value.selectedId).toBeNull();
  });

  it('leaves selectedId untouched when a different ticket is dropped', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    ticketsStore.actions.select(1);
    ticketsStore.actions.removeTicket(2);
    expect(ticketsStore.state.value.selectedId).toBe(1);
  });

  it('no-ops when the id isn\'t present', () => {
    ticketsStore.actions.setTickets([makeTicket(1)]);
    const before = ticketsStore.state.value.tickets;
    ticketsStore.actions.removeTicket(99);
    expect(ticketsStore.state.value.tickets).toBe(before);
  });
});

describe('ticketsStore — optimisticUpdate', () => {
  it('merges a partial patch into the matching ticket', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { status: 'not_started', up_next: false })]);
    ticketsStore.actions.optimisticUpdate(1, { status: 'started', up_next: true });
    const updated = ticketsStore.state.value.tickets.find(t => t.id === 1);
    expect(updated?.status).toBe('started');
    expect(updated?.up_next).toBe(true);
    // Other fields preserved.
    expect(updated?.title).toBe('Ticket 1');
  });

  it('leaves other tickets alone', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { title: 'A' }),
      makeTicket(2, { title: 'B' }),
    ]);
    ticketsStore.actions.optimisticUpdate(1, { title: 'A-prime' });
    expect(ticketsStore.state.value.tickets.find(t => t.id === 2)?.title).toBe('B');
  });

  it('no-ops when the id isn\'t present', () => {
    ticketsStore.actions.setTickets([makeTicket(1)]);
    const before = ticketsStore.state.value.tickets;
    ticketsStore.actions.optimisticUpdate(99, { title: 'nope' });
    expect(ticketsStore.state.value.tickets).toBe(before);
  });
});

describe('ticketsStore — filteredTickets derived signal', () => {
  it('returns all tickets when no search is active', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2), makeTicket(3)]);
    expect(filteredTickets.value.length).toBe(3);
  });

  it('filters by title (case-insensitive)', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { title: 'Auth bug' }),
      makeTicket(2, { title: 'Performance issue' }),
      makeTicket(3, { title: 'AUTH crash' }),
    ]);
    ticketsStore.actions.patchFilter({ search: 'auth' });
    const visible = filteredTickets.value.map(t => t.id);
    expect(visible).toEqual([1, 3]);
  });

  it('filters by details', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { title: 'A', details: 'mentions websocket inside' }),
      makeTicket(2, { title: 'B', details: 'no match' }),
    ]);
    ticketsStore.actions.patchFilter({ search: 'WebSocket' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([1]);
  });

  it('filters by ticket_number', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1234),
      makeTicket(5678),
    ]);
    ticketsStore.actions.patchFilter({ search: 'HS-12' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([1234]);
  });

  it('recomputes when the underlying ticket list changes', () => {
    ticketsStore.actions.patchFilter({ search: 'foo' });
    expect(filteredTickets.value).toEqual([]);
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'foobar' })]);
    expect(filteredTickets.value.map(t => t.id)).toEqual([1]);
  });

  it('recomputes when the filter changes', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { title: 'apple' }),
      makeTicket(2, { title: 'banana' }),
    ]);
    ticketsStore.actions.patchFilter({ search: 'apple' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([1]);
    ticketsStore.actions.patchFilter({ search: 'banana' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([2]);
  });

  it('returns the unfiltered list reference when search is cleared', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    ticketsStore.actions.patchFilter({ search: 'foo' });
    expect(filteredTickets.value.length).toBe(0);
    ticketsStore.actions.patchFilter({ search: '' });
    expect(filteredTickets.value.length).toBe(2);
  });

  // HS-8380 — the server's WHERE clause matches against title + details +
  // ticket_number + tags + notes. Pre-fix the client filter only checked
  // the first three, so server-returned matches whose only hit was in tags
  // or notes were dropped on the client. Symptom: "Hide N archive items"
  // banner whose N (server count) was much larger than the visible list
  // (client re-filter).
  it('filters by notes (HS-8380 — mirrors server ILIKE clause)', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { title: 'A', notes: JSON.stringify([{ id: 'n1', text: 'FEEDBACK NEEDED: confirm fix?', created_at: '2026-05-14T00:00:00Z' }]) }),
      makeTicket(2, { title: 'B', notes: '[]' }),
    ]);
    ticketsStore.actions.patchFilter({ search: 'FEEDBACK NEEDED' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([1]);
  });

  it('filters by tags (HS-8380 — mirrors server ILIKE clause)', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { title: 'A', tags: JSON.stringify(['urgent', 'auth']) }),
      makeTicket(2, { title: 'B', tags: '[]' }),
    ]);
    ticketsStore.actions.patchFilter({ search: 'urgent' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([1]);
  });
});

/**
 * HS-8334 — `filteredTickets` body extended to be the single source
 * of filter truth (view + include flags + search, against the full
 * unfiltered store contents). These tests pin the per-view branches
 * + the active-scope exclusion + the include-flag overrides.
 */
describe('ticketsStore — filteredTickets per-view narrowing (HS-8334)', () => {
  function mixedFixture() {
    // Span every status the active-scope filter cares about + a few
    // (category, priority, up_next) the sub-view branches care about.
    return [
      makeTicket(1, { status: 'not_started', category: 'feature' }),
      makeTicket(2, { status: 'started', category: 'bug', up_next: true }),
      makeTicket(3, { status: 'completed', category: 'feature' }),
      makeTicket(4, { status: 'verified', category: 'task' }),
      makeTicket(5, { status: 'deleted' }),
      makeTicket(6, { status: 'backlog', category: 'feature' }),
      makeTicket(7, { status: 'archive', category: 'task', priority: 'high' }),
      makeTicket(8, { status: 'not_started', priority: 'high', up_next: true }),
    ];
  }

  it("view='all' includes the active scope only (excludes deleted / backlog / archive)", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3, 4, 8]);
  });

  it("view='up-next' narrows to up_next=true within the active scope", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'up-next' });
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([2, 8]);
  });

  it("view='open' narrows to status in (not_started, started)", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'open' });
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 8]);
  });

  it("view='completed' narrows to status='completed'", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'completed' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([3]);
  });

  it("view='verified' narrows to status='verified'", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'verified' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([4]);
  });

  it("view='non-verified' excludes verified but includes not_started / started / completed", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'non-verified' });
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3, 8]);
  });

  it("view='trash' narrows to status='deleted' regardless of include flags", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'trash' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([5]);
  });

  it("view='backlog' narrows to status='backlog'", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'backlog' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([6]);
  });

  it("view='archive' narrows to status='archive'", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'archive' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([7]);
  });

  it("view='category:feature' narrows to category=feature within the active scope", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'category:feature' });
    // tickets 1, 3, 8 are category=feature in the active scope.
    // ticket 6 is also category=feature but is backlog → excluded.
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 3, 8]);
  });

  it("view='priority:high' narrows to priority=high within the active scope", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'priority:high' });
    // ticket 7 is also priority=high but is archive → excluded.
    expect(filteredTickets.value.map(t => t.id)).toEqual([8]);
  });

  it("view='custom:foo' passes through unchanged (server pre-filtered)", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'custom:any-id' });
    // Custom views short-circuit — no active-scope filter applied.
    // All 8 fixture tickets come through, including deleted / backlog /
    // archive. (In live use, the server's /tickets/query endpoint
    // narrows to just the matching set; the client doesn't second-guess.)
    expect(filteredTickets.value.length).toBe(8);
  });

  it("includeBacklogInSearch=true allows backlog tickets through the active-scope filter", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ includeBacklogInSearch: true });
    // ticket 6 (backlog) is now visible in view='all'; archive (7) still excluded.
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3, 4, 6, 8]);
  });

  it("includeArchiveInSearch=true allows archive tickets through the active-scope filter", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ includeArchiveInSearch: true });
    // ticket 7 (archive) is now visible in view='all'; backlog (6) still excluded.
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3, 4, 7, 8]);
  });

  it("both include flags = true allows backlog + archive but not deleted", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ includeBacklogInSearch: true, includeArchiveInSearch: true });
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3, 4, 6, 7, 8]);
  });

  it("include flags do NOT bypass cross-scope views (trash / backlog / archive)", () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'trash', includeBacklogInSearch: true, includeArchiveInSearch: true });
    expect(filteredTickets.value.map(t => t.id)).toEqual([5]);
  });

  // HS-8618 — a non-empty search is view-INDEPENDENT for standard views:
  // it behaves as 'all'. Pre-HS-8618 this asserted `[1]` (search confined to
  // the 'completed' view); now ticket 3 (not_started, also matches 'foo')
  // comes through because the 'completed' narrowing is dropped while
  // searching.
  it('search from a standard view ignores the view narrowing (HS-8618)', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'completed', title: 'foo bar' }),
      makeTicket(2, { status: 'completed', title: 'baz' }),
      makeTicket(3, { status: 'not_started', title: 'foo qux' }),
    ]);
    ticketsStore.actions.patchFilter({ view: 'completed', search: 'foo' });
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 3]);
  });

  it('recomputes on view change without needing setTickets', () => {
    ticketsStore.actions.setTickets(mixedFixture());
    ticketsStore.actions.patchFilter({ view: 'all' });
    const allCount = filteredTickets.value.length;
    ticketsStore.actions.patchFilter({ view: 'completed' });
    const completedCount = filteredTickets.value.length;
    expect(allCount).toBe(5);
    expect(completedCount).toBe(1);
  });
});

/**
 * HS-8618 — search is view-independent. A non-empty search behaves as the
 * 'all' view for every standard view (so results don't depend on which
 * sidebar bucket is active), with Trash and custom/saved views exempt.
 * These pin the `effectiveView` helper directly and the cross-view search
 * behavior through `filteredTickets`.
 */
describe('ticketsStore — view-independent search (HS-8618)', () => {
  it('effectiveView returns the real view when search is empty', () => {
    expect(effectiveView('open', '')).toBe('open');
    expect(effectiveView('completed', '')).toBe('completed');
    expect(effectiveView('category:bug', '')).toBe('category:bug');
    expect(effectiveView('backlog', '')).toBe('backlog');
    expect(effectiveView('trash', '')).toBe('trash');
    expect(effectiveView('custom:x', '')).toBe('custom:x');
  });

  it('effectiveView collapses every standard view to "all" when searching', () => {
    for (const v of ['all', 'up-next', 'open', 'completed', 'non-verified', 'verified', 'backlog', 'archive', 'category:bug', 'priority:high']) {
      expect(effectiveView(v, 'foo')).toBe('all');
    }
  });

  it('effectiveView leaves trash + custom views unchanged when searching', () => {
    expect(effectiveView('trash', 'foo')).toBe('trash');
    expect(effectiveView('custom:my-view', 'foo')).toBe('custom:my-view');
  });

  function crossStatusFixture() {
    return [
      makeTicket(1, { status: 'not_started', title: 'alpha task' }),
      makeTicket(2, { status: 'completed', title: 'alpha done' }),
      makeTicket(3, { status: 'verified', title: 'alpha verified' }),
      makeTicket(4, { status: 'started', title: 'beta', category: 'bug' }),
      makeTicket(5, { status: 'deleted', title: 'alpha deleted' }),
    ];
  }

  it('searching from the "open" view surfaces matches outside the open bucket', () => {
    ticketsStore.actions.setTickets(crossStatusFixture());
    ticketsStore.actions.patchFilter({ view: 'open', search: 'alpha' });
    // not_started (1), completed (2), verified (3) all match 'alpha' in the
    // active scope; deleted (5) stays excluded (active scope never includes
    // deleted, and trash isn't mixed in without its own view).
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3]);
  });

  it('searching from a category view ignores the category narrowing', () => {
    ticketsStore.actions.setTickets(crossStatusFixture());
    ticketsStore.actions.patchFilter({ view: 'category:bug', search: 'alpha' });
    // Without HS-8618 this would be empty (no bug-category ticket matches
    // 'alpha'); now it spans all categories in the active scope.
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3]);
  });

  it('searching from the trash view STAYS within trash (exempt)', () => {
    ticketsStore.actions.setTickets(crossStatusFixture());
    ticketsStore.actions.patchFilter({ view: 'trash', search: 'alpha' });
    // Only the deleted ticket (5) — trash is not collapsed to 'all'.
    expect(filteredTickets.value.map(t => t.id)).toEqual([5]);
  });

  it('searching from a custom view STAYS a passthrough (exempt)', () => {
    ticketsStore.actions.setTickets(crossStatusFixture());
    ticketsStore.actions.patchFilter({ view: 'custom:any', search: 'alpha' });
    // Custom view = server-pre-filtered passthrough, then the client search
    // filter applies across the whole snapshot (incl. deleted 5).
    expect(filteredTickets.value.map(t => t.id).sort()).toEqual([1, 2, 3, 5]);
  });
});

/**
 * HS-8332 — `ticketsByStatusSignal` partitions `filteredTickets` (the
 * narrowed visible set, not raw `ticketsSignal`) by `ticket.status`.
 * Used by the column-view per-column bindLists in `columnView.tsx`.
 */
describe('ticketsStore — ticketsByStatusSignal partitioning (HS-8332)', () => {
  it('partitions tickets by status key', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'not_started' }),
      makeTicket(2, { status: 'started' }),
      makeTicket(3, { status: 'started' }),
      makeTicket(4, { status: 'completed' }),
    ]);
    const grouped = ticketsByStatusSignal.value;
    expect(grouped['not_started']?.map(t => t.id)).toEqual([1]);
    expect(grouped['started']?.map(t => t.id)).toEqual([2, 3]);
    expect(grouped['completed']?.map(t => t.id)).toEqual([4]);
    expect(grouped['verified']).toBeUndefined();
  });

  it('preserves insertion order within each bucket', () => {
    ticketsStore.actions.setTickets([
      makeTicket(10, { status: 'started' }),
      makeTicket(5, { status: 'started' }),
      makeTicket(20, { status: 'started' }),
    ]);
    expect(ticketsByStatusSignal.value['started']?.map(t => t.id)).toEqual([10, 5, 20]);
  });

  it('respects the upstream filteredTickets narrowing', () => {
    // Setting up tickets that should be excluded by the default view filter:
    // 'deleted' is always excluded; in default view='all' it shouldn't appear.
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'not_started' }),
      makeTicket(2, { status: 'deleted' }),
      makeTicket(3, { status: 'backlog' }),
    ]);
    // Default filter view='all' excludes deleted/backlog/archive by HS-8334.
    const grouped = ticketsByStatusSignal.value;
    expect(grouped['not_started']?.map(t => t.id)).toEqual([1]);
    expect(grouped['deleted']).toBeUndefined();
    expect(grouped['backlog']).toBeUndefined();
  });

  it('exposes trash bucket when view=trash narrows the source', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'not_started' }),
      makeTicket(2, { status: 'deleted' }),
    ]);
    ticketsStore.actions.patchFilter({ view: 'trash' });
    const grouped = ticketsByStatusSignal.value;
    expect(grouped['deleted']?.map(t => t.id)).toEqual([2]);
    expect(grouped['not_started']).toBeUndefined();
  });

  it('recomputes on view change without setTickets', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'not_started' }),
      makeTicket(2, { status: 'completed' }),
    ]);
    const allKeys = Object.keys(ticketsByStatusSignal.value).sort();
    ticketsStore.actions.patchFilter({ view: 'completed' });
    const completedKeys = Object.keys(ticketsByStatusSignal.value);
    expect(allKeys).toEqual(['completed', 'not_started']);
    expect(completedKeys).toEqual(['completed']);
  });

  it('returns an empty object when no tickets match the filter', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'not_started', title: 'foo' }),
    ]);
    ticketsStore.actions.patchFilter({ search: 'no-match-zzzz' });
    expect(Object.keys(ticketsByStatusSignal.value)).toEqual([]);
  });
});

/**
 * HS-8335 — per-ticket signal infrastructure. The signal Map lives
 * outside the store's reactive state so updates to one ticket don't
 * churn the outer state ref (which would re-fire every consumer of
 * the store's top-level state + every list-level computed). Each
 * action that mutates ticket data also reconciles / fires / disposes
 * the per-ticket signal so the per-row effects in `createTicketRow`
 * / `createColumnCard` stay in sync.
 */
describe('ticketsStore — per-ticket signals (HS-8335)', () => {
  it('setTickets creates per-ticket signals for each id', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    expect(getTicketSignals(1)?.ticket.value.id).toBe(1);
    expect(getTicketSignals(2)?.ticket.value.id).toBe(2);
  });

  it('getTicketSignals returns undefined for unknown ids', () => {
    ticketsStore.actions.setTickets([makeTicket(1)]);
    expect(getTicketSignals(99)).toBeUndefined();
  });

  it('setTickets preserves signal identity across calls for surviving ids', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'Original' })]);
    const before = getTicketSignals(1);
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'Updated' })]);
    const after = getTicketSignals(1);
    expect(after).toBe(before);
    expect(after?.ticket.value.title).toBe('Updated');
  });

  it('setTickets fires the per-ticket signal when reactive fields change', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'A' })]);
    const sigs = getTicketSignals(1);
    expect(sigs).toBeDefined();
    let fires = 0;
    const stop = effect(() => {
      // Touch the signal to subscribe; skip the initial fire.
      const _ = sigs!.ticket.value;
      void _;
      fires++;
    });
    expect(fires).toBe(1);
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'B' })]);
    expect(fires).toBe(2);
    stop();
  });

  it('setTickets does NOT fire the per-ticket signal when only ignored fields change', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'A', details: 'x' })]);
    const sigs = getTicketSignals(1);
    let fires = 0;
    const stop = effect(() => {
      void sigs!.ticket.value;
      fires++;
    });
    expect(fires).toBe(1);
    // `details` is NOT in `ticketEqualForRender`'s field list — the
    // per-ticket signal shouldn't fire for a details-only change.
    ticketsStore.actions.setTickets([makeTicket(1, { title: 'A', details: 'y' })]);
    expect(fires).toBe(1);
    stop();
  });

  it('setTickets removes signals for ids no longer in the list', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    expect(getTicketSignals(1)).toBeDefined();
    expect(getTicketSignals(2)).toBeDefined();
    ticketsStore.actions.setTickets([makeTicket(1)]);
    expect(getTicketSignals(1)).toBeDefined();
    expect(getTicketSignals(2)).toBeUndefined();
  });

  it('applyServerUpdate fires the per-ticket signal', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { up_next: false })]);
    const sigs = getTicketSignals(1);
    let fires = 0;
    const stop = effect(() => {
      void sigs!.ticket.value.up_next;
      fires++;
    });
    expect(fires).toBe(1);
    ticketsStore.actions.applyServerUpdate(makeTicket(1, { up_next: true }));
    expect(fires).toBe(2);
    expect(sigs?.ticket.value.up_next).toBe(true);
    stop();
  });

  it('optimisticUpdate fires the per-ticket signal', () => {
    ticketsStore.actions.setTickets([makeTicket(1, { status: 'not_started' })]);
    const sigs = getTicketSignals(1);
    let fires = 0;
    const stop = effect(() => {
      void sigs!.ticket.value.status;
      fires++;
    });
    expect(fires).toBe(1);
    ticketsStore.actions.optimisticUpdate(1, { status: 'started' });
    expect(fires).toBe(2);
    expect(sigs?.ticket.value.status).toBe('started');
    stop();
  });

  it('removeTicket disposes the per-ticket signal', () => {
    ticketsStore.actions.setTickets([makeTicket(1), makeTicket(2)]);
    expect(getTicketSignals(1)).toBeDefined();
    ticketsStore.actions.removeTicket(1);
    expect(getTicketSignals(1)).toBeUndefined();
    expect(getTicketSignals(2)).toBeDefined();
  });
});
