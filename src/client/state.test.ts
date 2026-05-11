import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearPerProjectSessionState,
  getCategoryColor,
  getCategoryLabel,
  getPriorityColor,
  getPriorityIcon,
  getProjectGridActive,
  getProjectGridColumnCount,
  getStatusIcon,
  setActiveProject,
  setProjectGridActive,
  setProjectGridColumnCount,
  shouldResetStatusOnUpNext,
  state,
  type Ticket,
} from './state.js';
import { _ticketsStoreForTesting, ticketsStore } from './ticketsStore.js';

describe('getCategoryColor', () => {
  it('returns correct colors for all categories', () => {
    expect(getCategoryColor('issue')).toBe('#6b7280');
    expect(getCategoryColor('bug')).toBe('#ef4444');
    expect(getCategoryColor('feature')).toBe('#22c55e');
    expect(getCategoryColor('requirement_change')).toBe('#f97316');
    expect(getCategoryColor('task')).toBe('#3b82f6');
    expect(getCategoryColor('investigation')).toBe('#8b5cf6');
  });

  it('returns default for unknown category', () => {
    expect(getCategoryColor('unknown')).toBe('#6b7280');
  });
});

describe('getCategoryLabel', () => {
  it('returns correct abbreviations for all categories', () => {
    expect(getCategoryLabel('issue')).toBe('ISS');
    expect(getCategoryLabel('bug')).toBe('BUG');
    expect(getCategoryLabel('feature')).toBe('FEA');
    expect(getCategoryLabel('requirement_change')).toBe('REQ');
    expect(getCategoryLabel('task')).toBe('TSK');
    expect(getCategoryLabel('investigation')).toBe('INV');
  });

  it('returns default for unknown category', () => {
    expect(getCategoryLabel('unknown')).toBe('UNK');
  });
});

describe('getPriorityIcon', () => {
  it('returns correct icons for all priorities', () => {
    // All priority icons are now Lucide SVG strings
    expect(getPriorityIcon('highest')).toContain('<svg');
    expect(getPriorityIcon('high')).toContain('<svg');
    expect(getPriorityIcon('default')).toContain('<svg');
    expect(getPriorityIcon('low')).toContain('<svg');
    expect(getPriorityIcon('lowest')).toContain('<svg');
  });

  it('returns default for unknown priority', () => {
    expect(getPriorityIcon('unknown')).toBe('—');
  });
});

describe('getPriorityColor', () => {
  it('returns correct colors for all priorities', () => {
    expect(getPriorityColor('highest')).toBe('#ef4444');
    expect(getPriorityColor('high')).toBe('#f97316');
    expect(getPriorityColor('default')).toBe('#6b7280');
    expect(getPriorityColor('low')).toBe('#3b82f6');
    expect(getPriorityColor('lowest')).toBe('#94a3b8');
  });

  it('returns default for unknown priority', () => {
    expect(getPriorityColor('unknown')).toBe('#6b7280');
  });
});

describe('getStatusIcon', () => {
  it('returns correct icons for all statuses', () => {
    expect(getStatusIcon('not_started')).toBe('○');
    expect(getStatusIcon('started')).toBe('◔');
    expect(getStatusIcon('completed')).toBe('✓');
    expect(getStatusIcon('verified')).toContain('<svg');
    expect(getStatusIcon('backlog')).toBe('□');
    expect(getStatusIcon('archive')).toBe('■');
  });

  it('returns default for unknown status', () => {
    expect(getStatusIcon('unknown')).toBe('○');
  });
});

describe('shouldResetStatusOnUpNext (HS-7998)', () => {
  it('returns true for completed (existing behavior preserved)', () => {
    expect(shouldResetStatusOnUpNext('completed')).toBe(true);
  });

  it('returns true for verified (existing behavior preserved)', () => {
    expect(shouldResetStatusOnUpNext('verified')).toBe(true);
  });

  it('returns true for backlog — the HS-7998 fix', () => {
    expect(shouldResetStatusOnUpNext('backlog')).toBe(true);
  });

  it('returns true for archive — the HS-7998 fix', () => {
    expect(shouldResetStatusOnUpNext('archive')).toBe(true);
  });

  it('returns false for not_started (already in active workflow)', () => {
    expect(shouldResetStatusOnUpNext('not_started')).toBe(false);
  });

  it('returns false for started (already in active workflow)', () => {
    expect(shouldResetStatusOnUpNext('started')).toBe(false);
  });

  it('returns false for an unknown status (defensive — treat as already in workflow)', () => {
    expect(shouldResetStatusOnUpNext('weird-future-status')).toBe(false);
  });
});

describe('setActiveProject per-project search state (HS-7360)', () => {
  const projA = { name: 'A', dataDir: '/a', secret: 'secret-a' };
  const projB = { name: 'B', dataDir: '/b', secret: 'secret-b' };

  beforeEach(() => {
    clearPerProjectSessionState('secret-a');
    clearPerProjectSessionState('secret-b');
    state.search = '';
    state.view = 'all';
    setActiveProject(projA);
  });

  it("saves project A's search on switch and restores it on switch-back", () => {
    state.search = 'foo';
    setActiveProject(projB);
    expect(state.search).toBe('');
    setActiveProject(projA);
    expect(state.search).toBe('foo');
  });

  it('starts a never-seen project with an empty search query', () => {
    state.search = 'hello';
    setActiveProject(projB);
    expect(state.search).toBe('');
  });

  it('remembers per-project search independently', () => {
    state.search = 'aaa';
    setActiveProject(projB);
    state.search = 'bbb';
    setActiveProject(projA);
    expect(state.search).toBe('aaa');
    setActiveProject(projB);
    expect(state.search).toBe('bbb');
  });

  it('clearPerProjectSessionState wipes both view and search for a secret', () => {
    state.search = 'zzz';
    state.view = 'up-next';
    setActiveProject(projB);
    clearPerProjectSessionState('secret-a');
    setActiveProject(projA);
    expect(state.search).toBe('');
    expect(state.view).toBe('all');
  });

  it('switch-to-same-secret preserves the current query under that secret', () => {
    state.search = 'keep';
    setActiveProject(projA);
    setActiveProject(projB);
    setActiveProject(projA);
    expect(state.search).toBe('keep');
  });
});

describe('per-project drawer grid state (HS-6311)', () => {
  const projA = { name: 'A', dataDir: '/a', secret: 'grid-a' };
  const projB = { name: 'B', dataDir: '/b', secret: 'grid-b' };

  beforeEach(() => {
    clearPerProjectSessionState('grid-a');
    clearPerProjectSessionState('grid-b');
    setActiveProject(projA);
  });

  it('defaults grid-active to false for a never-seen project', () => {
    expect(getProjectGridActive('grid-a')).toBe(false);
    expect(getProjectGridActive('grid-b')).toBe(false);
  });

  it('setProjectGridActive(true) persists for that secret', () => {
    setProjectGridActive('grid-a', true);
    expect(getProjectGridActive('grid-a')).toBe(true);
    expect(getProjectGridActive('grid-b')).toBe(false);
  });

  it('setProjectGridActive(false) clears the flag (distinct from never-seen)', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridActive('grid-a', false);
    expect(getProjectGridActive('grid-a')).toBe(false);
  });

  it('defaults column count to 4 for a never-seen project (HS-8176)', () => {
    expect(getProjectGridColumnCount('grid-a')).toBe(4);
    expect(getProjectGridColumnCount('grid-b')).toBe(4);
  });

  it('setProjectGridColumnCount persists per secret', () => {
    setProjectGridColumnCount('grid-a', 6);
    setProjectGridColumnCount('grid-b', 2);
    expect(getProjectGridColumnCount('grid-a')).toBe(6);
    expect(getProjectGridColumnCount('grid-b')).toBe(2);
  });

  it('grid state survives a setActiveProject round-trip — not cleared by project switch', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridColumnCount('grid-a', 8);
    setActiveProject(projB);
    setActiveProject(projA);
    expect(getProjectGridActive('grid-a')).toBe(true);
    expect(getProjectGridColumnCount('grid-a')).toBe(8);
  });

  it('clearPerProjectSessionState drops grid-active + column count for that secret', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridColumnCount('grid-a', 5);
    clearPerProjectSessionState('grid-a');
    expect(getProjectGridActive('grid-a')).toBe(false);
    expect(getProjectGridColumnCount('grid-a')).toBe(4);
  });

  it('grid state for one project does not leak into another on switch', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridColumnCount('grid-a', 9);
    setActiveProject(projB);
    expect(getProjectGridActive('grid-b')).toBe(false);
    expect(getProjectGridColumnCount('grid-b')).toBe(4);
  });
});

describe('state.tickets — kerf store delegate (HS-8239)', () => {
  beforeEach(() => {
    _ticketsStoreForTesting.reset();
  });

  afterEach(() => {
    _ticketsStoreForTesting.reset();
  });

  function mkTicket(id: number, overrides: Partial<Ticket> = {}): Ticket {
    return {
      id,
      ticket_number: `HS-${id}`,
      title: `Ticket ${id}`,
      details: '',
      category: 'task',
      priority: 'default',
      status: 'not_started',
      up_next: false,
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:00Z',
      completed_at: null,
      verified_at: null,
      deleted_at: null,
      notes: '',
      tags: '[]',
      last_read_at: null,
      ...overrides,
    };
  }

  it('reading state.tickets returns the store value', () => {
    ticketsStore.actions.setTickets([mkTicket(1), mkTicket(2)]);
    expect(state.tickets.map(t => t.id)).toEqual([1, 2]);
  });

  it('writing state.tickets = X writes through to the store via setTickets', () => {
    state.tickets = [mkTicket(7), mkTicket(8)];
    expect(ticketsStore.state.value.tickets.map(t => t.id)).toEqual([7, 8]);
  });

  it('writes are immediately readable through state.tickets', () => {
    state.tickets = [mkTicket(42)];
    expect(state.tickets[0].id).toBe(42);
  });

  it('writing state.tickets = [] clears via the store', () => {
    state.tickets = [mkTicket(1)];
    state.tickets = [];
    expect(state.tickets).toEqual([]);
    expect(ticketsStore.state.value.tickets).toEqual([]);
  });

  it('readonly Array methods on state.tickets (find / filter / map) work normally', () => {
    state.tickets = [mkTicket(1, { title: 'A' }), mkTicket(2, { title: 'B' })];
    expect(state.tickets.find(t => t.id === 2)?.title).toBe('B');
    expect(state.tickets.filter(t => t.title === 'A').map(t => t.id)).toEqual([1]);
  });
});

describe('state filter-state — kerf store delegate (HS-8327)', () => {
  beforeEach(() => {
    _ticketsStoreForTesting.reset();
  });

  afterEach(() => {
    _ticketsStoreForTesting.reset();
  });

  it('reading state.view returns the store filter.view', () => {
    ticketsStore.actions.patchFilter({ view: 'completed' });
    expect(state.view).toBe('completed');
  });

  it('writing state.view writes through patchFilter', () => {
    state.view = 'verified';
    expect(ticketsStore.state.value.filter.view).toBe('verified');
  });

  it('reading state.search returns the store filter.search', () => {
    ticketsStore.actions.patchFilter({ search: 'hello' });
    expect(state.search).toBe('hello');
  });

  it('writing state.search writes through patchFilter', () => {
    state.search = 'world';
    expect(ticketsStore.state.value.filter.search).toBe('world');
  });

  it('writing state.includeBacklogInSearch + state.includeArchiveInSearch writes through', () => {
    state.includeBacklogInSearch = true;
    state.includeArchiveInSearch = true;
    expect(ticketsStore.state.value.filter.includeBacklogInSearch).toBe(true);
    expect(ticketsStore.state.value.filter.includeArchiveInSearch).toBe(true);
  });

  it('the four filter fields are independently settable (one does not clobber another)', () => {
    state.view = 'up-next';
    state.search = 'aaa';
    state.includeBacklogInSearch = true;
    state.includeArchiveInSearch = true;
    expect(state.view).toBe('up-next');
    expect(state.search).toBe('aaa');
    expect(state.includeBacklogInSearch).toBe(true);
    expect(state.includeArchiveInSearch).toBe(true);
  });

  it('reset() restores all four filter fields to their defaults', () => {
    state.view = 'completed';
    state.search = 'foo';
    state.includeBacklogInSearch = true;
    state.includeArchiveInSearch = true;
    _ticketsStoreForTesting.reset();
    expect(state.view).toBe('all');
    expect(state.search).toBe('');
    expect(state.includeBacklogInSearch).toBe(false);
    expect(state.includeArchiveInSearch).toBe(false);
  });
});
