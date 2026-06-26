// @vitest-environment happy-dom
/**
 * HS-9037 — the "Dispatch to worker" context-menu submenu (docs/92 §92.2) gets a
 * leading Lucide `send` icon, matching the icon'd action items in the same menu.
 * The submenu is inserted asynchronously after `getWorkerPool()` resolves with at
 * least one live worker, so this test mocks the pool to one idle worker, opens
 * the menu, waits for the insertion, and asserts the header row renders an SVG
 * inside its `.dropdown-icon`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as ApiIndex from '../api/index.js';
import type { PoolState, WorkerSlotView } from '../api/workers.js';
import { showTicketContextMenu } from './contextMenu.js';
import type { Ticket } from './state.js';
import { state } from './state.js';
import { _clearPerTicketSignalsForTesting, _ticketsStoreForTesting, ticketsStore } from './ticketsStore.js';

// `vi.hoisted` so the mock fn exists before the hoisted `vi.mock` factory runs.
const getWorkerPoolMock = vi.hoisted(() => vi.fn<() => Promise<PoolState>>());

// Keep every other `../api/index.js` export real (the menu touches a few during
// build); override only the worker-pool fetch the dispatch block depends on.
vi.mock('../api/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ApiIndex>();
  return { ...actual, getWorkerPool: getWorkerPoolMock };
});

function ticket(id: number): Ticket {
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
  };
}

function liveWorker(): WorkerSlotView {
  return {
    label: 'worker-1',
    worker: 'worker-1',
    worktreePath: '/tmp/wt-1',
    branch: 'hotsheet/worker-1',
    terminalId: 't1',
    state: 'idle',
    currentTicket: null,
    queueOnly: false,
    ready: false,
    readyBranch: null,
  };
}

function contextMenuEvent(): MouseEvent {
  return new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 });
}

/** Find the "Dispatch to worker" submenu header element, or null. */
function dispatchHeader(): HTMLElement | null {
  const items = document.querySelectorAll<HTMLElement>('.context-menu .context-menu-item.has-submenu');
  for (const el of Array.from(items)) {
    if (el.querySelector('.context-menu-label')?.textContent === 'Dispatch to worker') return el;
  }
  return null;
}

beforeEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  state.selectedIds.clear();
  state.categories = [
    { id: 'feature', label: 'Feature', shortLabel: 'F', color: '#3b82f6', shortcutKey: 'f', description: '' },
  ];
  document.body.innerHTML = '';
  getWorkerPoolMock.mockReset();
});

afterEach(() => {
  _ticketsStoreForTesting.reset();
  _clearPerTicketSignalsForTesting();
  state.selectedIds.clear();
  state.categories = [];
  document.body.innerHTML = '';
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

describe('Dispatch to worker submenu icon (HS-9037)', () => {
  it('renders a leading SVG icon on the submenu header when a live worker exists', async () => {
    getWorkerPoolMock.mockResolvedValue({ targetN: 1, workers: [liveWorker()] , readyCount: 0 });
    const t = ticket(42);
    ticketsStore.actions.setTickets([t]);
    state.tickets = [t];
    state.selectedIds.add(42);

    showTicketContextMenu(contextMenuEvent(), t);

    await vi.waitFor(() => {
      const header = dispatchHeader();
      expect(header).not.toBeNull();
      // The leading icon is a `.dropdown-icon` carrying the Lucide SVG.
      expect(header?.querySelector('.dropdown-icon svg')).not.toBeNull();
    });
  });

  it('omits the submenu entirely when no live worker exists', async () => {
    getWorkerPoolMock.mockResolvedValue({ targetN: 0, workers: [] , readyCount: 0 });
    const t = ticket(7);
    ticketsStore.actions.setTickets([t]);
    state.tickets = [t];
    state.selectedIds.add(7);

    showTicketContextMenu(contextMenuEvent(), t);

    // Give the resolved pool a tick to (not) insert anything.
    await new Promise((r) => setTimeout(r, 0));
    expect(dispatchHeader()).toBeNull();
  });
});
