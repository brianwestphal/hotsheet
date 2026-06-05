// @vitest-environment happy-dom
/**
 * HS-8663 — dropping selected tickets onto a project tab copies (default) or
 * moves (Alt) them into that project. These tests pin the wiring from the
 * tab's `drop` handler to `transferTicketsToProject`: a ticket drag (vs. a tab
 * reorder) is detected, the no-op guard for the source project's own tab
 * holds, and the copy/move flag + source secret are threaded through.
 *
 * The transfer itself is mocked here (its choreography is covered by
 * `ticketTransfer.test.ts`); this file asserts only that the tab drop reaches
 * it with the right arguments.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _renderTabsForTesting,
  _resetProjectTabsForTesting,
  _setProjectsForTesting,
} from './projectTabs.js';
import type { ProjectInfo } from './state.js';
import { state } from './state.js';
import { resetApiTransport, wireRealApiTransport } from './test-helpers/realApiTransport.js';
import { setDraggedTicketIds } from './ticketListState.js';
import { transferTicketsToProject } from './ticketTransfer.js';

vi.mock('./ticketTransfer.js', () => ({ transferTicketsToProject: vi.fn() }));
// The move path lazy-imports ticketList to reload after the originals are
// soft-deleted. Stub it so the test never reaches the real api transport.
vi.mock('./ticketList.js', () => ({
  loadTickets: vi.fn().mockResolvedValue(undefined),
  renderTicketList: vi.fn(),
}));

const transferMock = vi.mocked(transferTicketsToProject);

const A: ProjectInfo = { name: 'A', dataDir: '/tmp/a', secret: 'sec-a' };
const B: ProjectInfo = { name: 'B', dataDir: '/tmp/b', secret: 'sec-b' };

function makeTitleArea(): void {
  const div = document.createElement('div');
  div.id = 'app-title-area';
  document.body.appendChild(div);
}

function tabFor(secret: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`.project-tab[data-secret="${secret}"]`);
  if (el === null) throw new Error(`tab ${secret} not mounted`);
  return el;
}

/** Dispatch a synthetic `drop` carrying tickets (happy-dom drops the init
 *  dict's dataTransfer / altKey, so patch them on after construction). */
function dispatchDrop(target: HTMLElement, opts: { alt?: boolean } = {}): void {
  const ev = new DragEvent('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'altKey', { configurable: true, value: opts.alt ?? false });
  Object.defineProperty(ev, 'dataTransfer', { configurable: true, value: { dropEffect: 'none', effectAllowed: 'copyMove' } });
  target.dispatchEvent(ev);
}

beforeEach(() => {
  document.body.innerHTML = '';
  wireRealApiTransport();
  _resetProjectTabsForTesting();
  transferMock.mockReset().mockResolvedValue([]);
  state.tickets = [];
  state.selectedIds.clear();
  setDraggedTicketIds([]);
});

afterEach(() => {
  resetApiTransport();
  _resetProjectTabsForTesting();
  document.body.innerHTML = '';
  setDraggedTicketIds([]);
});

describe('drag tickets onto a project tab (HS-8663)', () => {
  it('copy: dropping onto another project tab transfers with that tab\'s secret', async () => {
    makeTitleArea();
    _setProjectsForTesting([A, B], A.secret);
    _renderTabsForTesting();
    state.tickets = [{ id: 1 } as never, { id: 2 } as never];
    setDraggedTicketIds([1, 2]);

    dispatchDrop(tabFor('sec-b'));
    await Promise.resolve();

    expect(transferMock).toHaveBeenCalledTimes(1);
    const [tickets, secret, callOpts] = transferMock.mock.calls[0];
    expect(tickets.map(t => t.id)).toEqual([1, 2]);
    expect(secret).toBe('sec-b');
    expect(callOpts).toEqual({ move: false, sourceSecret: 'sec-a' });
  });

  it('move: holding Alt threads move:true through', async () => {
    makeTitleArea();
    _setProjectsForTesting([A, B], A.secret);
    _renderTabsForTesting();
    state.tickets = [{ id: 3 } as never];
    setDraggedTicketIds([3]);

    dispatchDrop(tabFor('sec-b'), { alt: true });
    await Promise.resolve();

    expect(transferMock).toHaveBeenCalledTimes(1);
    expect(transferMock.mock.calls[0][2]).toEqual({ move: true, sourceSecret: 'sec-a' });
  });

  it('dropping onto the source project\'s own tab is a no-op', async () => {
    makeTitleArea();
    _setProjectsForTesting([A, B], A.secret);
    _renderTabsForTesting();
    state.tickets = [{ id: 1 } as never];
    setDraggedTicketIds([1]);

    dispatchDrop(tabFor('sec-a'));
    await Promise.resolve();

    expect(transferMock).not.toHaveBeenCalled();
  });

  it('a tab reorder (no dragged tickets) does not trigger a transfer', async () => {
    makeTitleArea();
    _setProjectsForTesting([A, B], A.secret);
    _renderTabsForTesting();
    // No draggedTicketIds set → isTicketDrag() is false.
    dispatchDrop(tabFor('sec-b'));
    await Promise.resolve();

    expect(transferMock).not.toHaveBeenCalled();
  });
});
