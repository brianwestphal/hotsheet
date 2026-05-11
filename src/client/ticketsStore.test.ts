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

import type { Ticket } from './state.js';
import {
  _ticketsStoreForTesting,
  DEFAULT_FILTER,
  filteredTickets,
  type FilterState,
  ticketsStore,
} from './ticketsStore.js';

beforeEach(() => {
  _ticketsStoreForTesting.reset();
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
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

  it('combined view + search applies both filters', () => {
    ticketsStore.actions.setTickets([
      makeTicket(1, { status: 'completed', title: 'foo bar' }),
      makeTicket(2, { status: 'completed', title: 'baz' }),
      makeTicket(3, { status: 'not_started', title: 'foo qux' }),
    ]);
    ticketsStore.actions.patchFilter({ view: 'completed', search: 'foo' });
    expect(filteredTickets.value.map(t => t.id)).toEqual([1]);
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
