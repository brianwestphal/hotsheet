// @vitest-environment happy-dom
/** HS-9143 — `bindDetailDropdowns`: open-on-click guard + `applyDetailChange` branches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailDropdowns } from './dropdowns.js';

interface Item { label: string; action: () => void }
const h = vi.hoisted(() => ({
  state: {
    activeTicketId: null as number | null,
    tickets: [] as Array<{ id: number }>,
    categories: [{ id: 'bug', label: 'Bug', shortcutKey: 'b', color: '#f00' }],
  },
  updateTicket: vi.fn(() => Promise.resolve()),
  trackedPatch: vi.fn(() => Promise.resolve()),
  openDetail: vi.fn(),
  loadTickets: vi.fn(() => Promise.resolve()),
  updateDetailCategory: vi.fn(),
  updateDetailPriority: vi.fn(),
  updateDetailStatus: vi.fn(),
  closeAllMenus: vi.fn(),
  createDropdown: vi.fn((_btn: HTMLElement, _items: Item[]) => document.createElement('div')),
  positionDropdown: vi.fn(),
}));
vi.mock('../../api/index.js', () => ({ updateTicket: h.updateTicket }));
vi.mock('../detail.js', () => ({ openDetail: h.openDetail, updateDetailCategory: h.updateDetailCategory, updateDetailPriority: h.updateDetailPriority, updateDetailStatus: h.updateDetailStatus }));
vi.mock('../dropdown.js', () => ({ closeAllMenus: h.closeAllMenus, createDropdown: h.createDropdown, positionDropdown: h.positionDropdown }));
vi.mock('../ticketList.js', () => ({ loadTickets: h.loadTickets }));
vi.mock('../undo/actions.js', () => ({ trackedPatch: h.trackedPatch }));
vi.mock('../state.js', () => ({
  state: h.state,
  PRIORITY_ITEMS: [{ label: 'High', key: 'h', value: 'high' }],
  STATUS_ITEMS: [{ label: 'Started', key: 's', value: 'started' }],
  getPriorityColor: () => '#000', getPriorityIcon: () => '', getStatusIcon: () => '',
}));

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = `
    <button id="detail-category" data-value="bug"></button>
    <button id="detail-priority" data-value="high"></button>
    <button id="detail-status" data-value="started"></button>`;
  h.state.activeTicketId = null; h.state.tickets = [];
  for (const k of ['updateTicket', 'trackedPatch', 'openDetail', 'loadTickets', 'updateDetailCategory', 'updateDetailPriority', 'updateDetailStatus', 'closeAllMenus', 'createDropdown', 'positionDropdown'] as const) h[k].mockReset();
  h.createDropdown.mockImplementation(() => document.createElement('div'));
  h.updateTicket.mockResolvedValue(undefined); h.trackedPatch.mockResolvedValue(undefined); h.loadTickets.mockResolvedValue(undefined);
  bindDetailDropdowns();
});
afterEach(() => { document.body.innerHTML = ''; });

describe('open-on-click', () => {
  it('opens a dropdown (closeAllMenus + createDropdown + position) when enabled', () => {
    document.getElementById('detail-category')!.click();
    expect(h.closeAllMenus).toHaveBeenCalled();
    expect(h.createDropdown).toHaveBeenCalledTimes(1);
    expect(h.positionDropdown).toHaveBeenCalled();
  });

  it('does nothing when the button is disabled', () => {
    (document.getElementById('detail-priority') as HTMLButtonElement).disabled = true;
    document.getElementById('detail-priority')!.click();
    expect(h.createDropdown).not.toHaveBeenCalled();
  });
});

describe('applyDetailChange (via a selected item action)', () => {
  async function selectFirstCategoryItem(): Promise<void> {
    document.getElementById('detail-category')!.click();
    const items = h.createDropdown.mock.calls[0][1];
    items[0].action();
    await flush();
  }

  it('trackedPatches when the ticket is in local state', async () => {
    h.state.activeTicketId = 2; h.state.tickets = [{ id: 2 }];
    await selectFirstCategoryItem();
    expect(h.updateDetailCategory).toHaveBeenCalledWith('bug');
    expect(h.trackedPatch).toHaveBeenCalledWith({ id: 2 }, { category: 'bug' }, 'Change category');
    expect(h.openDetail).toHaveBeenCalledWith(2);
  });

  it('falls back to updateTicket when not in local state', async () => {
    h.state.activeTicketId = 3; h.state.tickets = [];
    await selectFirstCategoryItem();
    expect(h.updateTicket).toHaveBeenCalledWith(3, { category: 'bug' });
    expect(h.trackedPatch).not.toHaveBeenCalled();
  });

  it('no-ops when no ticket is active', async () => {
    h.state.activeTicketId = null;
    await selectFirstCategoryItem();
    expect(h.trackedPatch).not.toHaveBeenCalled();
    expect(h.updateTicket).not.toHaveBeenCalled();
  });

  it('priority + status dropdowns build their items + run the right update helper', async () => {
    h.state.activeTicketId = 2; h.state.tickets = [{ id: 2 }];
    document.getElementById('detail-priority')!.click();
    h.createDropdown.mock.calls[0][1][0].action();
    await flush();
    expect(h.updateDetailPriority).toHaveBeenCalledWith('high');

    h.createDropdown.mockClear();
    document.getElementById('detail-status')!.click();
    h.createDropdown.mock.calls[0][1][0].action();
    await flush();
    expect(h.updateDetailStatus).toHaveBeenCalledWith('started');
  });
});
