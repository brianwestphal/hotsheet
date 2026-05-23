// @vitest-environment happy-dom
/**
 * HS-8574 — coverage backfill for the pure-logic helpers on
 * `src/client/ticketList.tsx`. The module was at 1.83% statement
 * coverage pre-fix — the heavy `renderTicketList` / `loadTickets`
 * paths are best left to E2E (they're tightly coupled to the live
 * `ticketsStore` + `bindList` + `flipAnimate` machinery and an
 * isolated unit test would have to mock the whole stack). The
 * smaller helpers — `canUseColumnView`, `computeTargetVariant`,
 * `computeScrollKey`, `buildScopeKey`, `rowFactoryFor`,
 * `unmountBindList`, `setTicketsAnimated` — are the meaningful
 * unit-test surface and they're what this file covers.
 *
 * Pure-logic helpers are reached via the `_testing` escape hatch
 * (HS-8574-added). `setTicketsAnimated` + `unmountBindList` are the
 * production exports and exercised via the real `ticketsStore`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Ticket } from './state.js';
import * as stateMod from './state.js';
import { _testing, canUseColumnView, setTicketsAnimated, unmountBindList } from './ticketList.js';
import { _ticketsStoreForTesting, ticketsSignal } from './ticketsStore.js';

const mockApi = vi.fn<(path: string) => Promise<unknown>>();
vi.mock('./api.js', () => ({
  api: (path: string): Promise<unknown> => mockApi(path),
}));

const mockGetActiveProject = vi.fn<() => { name: string; dataDir: string; secret: string } | null>();
vi.spyOn(stateMod, 'getActiveProject').mockImplementation(() => mockGetActiveProject());

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
  mockApi.mockReset();
  mockGetActiveProject.mockReturnValue({ name: 'p1', dataDir: '/tmp/p1', secret: 'proj-1' });
  _ticketsStoreForTesting.reset();
  _testing.resetScopeKeyForTests();
  _testing.resetScrollKeyForTests();
  // Reset state shape used by the helpers.
  stateMod.state.view = 'all';
  stateMod.state.search = '';
  stateMod.state.sortBy = 'created';
  stateMod.state.sortDir = 'desc';
  stateMod.state.layout = 'list';
  stateMod.state.includeBacklogInSearch = false;
  stateMod.state.includeArchiveInSearch = false;
  stateMod.state.backupPreview = null;
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  unmountBindList();
});

describe('canUseColumnView', () => {
  it('allows column view on the "all" sidebar item', () => {
    stateMod.state.view = 'all';
    expect(canUseColumnView()).toBe(true);
  });

  it('allows column view on the "open" sidebar item', () => {
    stateMod.state.view = 'open';
    expect(canUseColumnView()).toBe(true);
  });

  it('allows column view on any custom: view', () => {
    stateMod.state.view = 'custom:my-filter';
    expect(canUseColumnView()).toBe(true);
  });

  const disallowed = ['completed', 'verified', 'trash', 'backlog', 'archive'];
  for (const view of disallowed) {
    it(`disallows column view on "${view}"`, () => {
      stateMod.state.view = view;
      expect(canUseColumnView()).toBe(false);
    });
  }
});

describe('computeTargetVariant', () => {
  it('returns "preview" when backupPreview.active=true (highest priority)', () => {
    stateMod.state.backupPreview = { active: true, tickets: [], filename: 'b.tar.gz', timestamp: '2026-01-01T00:00:00Z', tier: '5m' };
    stateMod.state.view = 'trash'; // even with view=trash, preview wins
    expect(_testing.computeTargetVariant()).toBe('preview');
  });

  it('returns "trash" when view=trash and not in preview mode', () => {
    stateMod.state.view = 'trash';
    expect(_testing.computeTargetVariant()).toBe('trash');
  });

  it('returns "default" for every other view', () => {
    for (const view of ['all', 'open', 'completed', 'verified', 'backlog', 'archive', 'custom:x']) {
      stateMod.state.view = view;
      expect(_testing.computeTargetVariant()).toBe('default');
    }
  });
});

describe('computeScrollKey', () => {
  it('returns null when there is no active project (boot-time pre-handshake)', () => {
    mockGetActiveProject.mockReturnValue(null);
    expect(_testing.computeScrollKey()).toBeNull();
  });

  it('returns the {secret, view, preview, key} triple for the live view', () => {
    mockGetActiveProject.mockReturnValue({ name: 'p', dataDir: '/d', secret: 'abc123' });
    stateMod.state.view = 'all';
    stateMod.state.backupPreview = null;
    const k = _testing.computeScrollKey();
    expect(k).toEqual({ secret: 'abc123', view: 'all', preview: false, key: 'abc123::all::live' });
  });

  it('returns the preview-tagged key when in preview mode', () => {
    mockGetActiveProject.mockReturnValue({ name: 'p', dataDir: '/d', secret: 'abc123' });
    stateMod.state.view = 'all';
    stateMod.state.backupPreview = { active: true, tickets: [], filename: 'b.tar.gz', timestamp: '2026-01-01T00:00:00Z', tier: '5m' };
    const k = _testing.computeScrollKey();
    expect(k?.preview).toBe(true);
    expect(k?.key).toBe('abc123::all::preview');
  });
});

describe('buildScopeKey', () => {
  it('builds a stable key from the 7 scope-affecting state fields', () => {
    stateMod.state.view = 'open';
    stateMod.state.search = 'foo';
    stateMod.state.sortBy = 'priority';
    stateMod.state.sortDir = 'asc';
    stateMod.state.layout = 'list';
    stateMod.state.includeBacklogInSearch = false;
    stateMod.state.includeArchiveInSearch = false;

    expect(_testing.buildScopeKey()).toBe('open|foo|priority|asc|list|0|0');
  });

  it('changes when any of the 7 fields changes', () => {
    stateMod.state.view = 'all';
    stateMod.state.search = '';
    stateMod.state.sortBy = 'created';
    stateMod.state.sortDir = 'desc';
    stateMod.state.layout = 'list';
    stateMod.state.includeBacklogInSearch = false;
    stateMod.state.includeArchiveInSearch = false;
    const base = _testing.buildScopeKey();

    stateMod.state.view = 'open';
    expect(_testing.buildScopeKey()).not.toBe(base);
    stateMod.state.view = 'all';

    stateMod.state.search = 'foo';
    expect(_testing.buildScopeKey()).not.toBe(base);
    stateMod.state.search = '';

    stateMod.state.includeBacklogInSearch = true;
    expect(_testing.buildScopeKey()).not.toBe(base);
    stateMod.state.includeBacklogInSearch = false;

    stateMod.state.includeArchiveInSearch = true;
    expect(_testing.buildScopeKey()).not.toBe(base);
  });

  it('serializes the boolean include-* flags as 0 / 1 strings', () => {
    stateMod.state.includeBacklogInSearch = true;
    stateMod.state.includeArchiveInSearch = false;
    expect(_testing.buildScopeKey()).toMatch(/\|1\|0$/);

    stateMod.state.includeBacklogInSearch = false;
    stateMod.state.includeArchiveInSearch = true;
    expect(_testing.buildScopeKey()).toMatch(/\|0\|1$/);
  });
});

describe('rowFactoryFor', () => {
  it('returns createTicketRow for "default"', () => {
    expect(_testing.rowFactoryFor('default').name).toBe('createTicketRow');
  });

  it('returns createTrashRow for "trash"', () => {
    expect(_testing.rowFactoryFor('trash').name).toBe('createTrashRow');
  });

  it('returns createPreviewRow for "preview"', () => {
    expect(_testing.rowFactoryFor('preview').name).toBe('createPreviewRow');
  });
});

describe('unmountBindList', () => {
  it('is a no-op when nothing is mounted (idempotent)', () => {
    expect(_testing.getMountedVariant()).toBeNull();
    expect(() => unmountBindList()).not.toThrow();
    expect(() => unmountBindList()).not.toThrow(); // second call also fine
    expect(_testing.getMountedVariant()).toBeNull();
  });
});

describe('setTicketsAnimated', () => {
  it('writes through to the ticketsStore', () => {
    const t1 = ticket({ id: 1 });
    const t2 = ticket({ id: 2 });
    setTicketsAnimated([t1, t2]);
    expect(ticketsSignal.value.length).toBe(2);
    expect(ticketsSignal.value[0].id).toBe(1);
    expect(ticketsSignal.value[1].id).toBe(2);
  });

  it('does not throw when passed an empty array', () => {
    expect(() => setTicketsAnimated([])).not.toThrow();
    expect(ticketsSignal.value.length).toBe(0);
  });
});
