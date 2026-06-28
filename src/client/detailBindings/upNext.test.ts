// @vitest-environment happy-dom
/** HS-9143 — `bindDetailUpNext` click-handler branches (up-next star toggle). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailUpNext } from './upNext.js';

const h = vi.hoisted(() => ({
  state: { activeTicketId: null as number | null, tickets: [] as Array<{ id: number; status: string; up_next: boolean }> },
  shouldReset: vi.fn<(s: string) => boolean>(),
  toggleUpNext: vi.fn(() => Promise.resolve()),
  trackedPatch: vi.fn(() => Promise.resolve()),
  openDetail: vi.fn(),
  loadTickets: vi.fn(() => Promise.resolve()),
  channelAutoTrigger: vi.fn(),
}));
vi.mock('../../api/index.js', () => ({ toggleUpNext: h.toggleUpNext }));
vi.mock('../channelUI.js', () => ({ channelAutoTrigger: h.channelAutoTrigger }));
vi.mock('../detail.js', () => ({ openDetail: h.openDetail }));
vi.mock('../state.js', () => ({ state: h.state, shouldResetStatusOnUpNext: h.shouldReset }));
vi.mock('../ticketList.js', () => ({ loadTickets: h.loadTickets }));
vi.mock('../undo/actions.js', () => ({ trackedPatch: h.trackedPatch }));

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<button id="detail-upnext"></button>';
  h.state.activeTicketId = null;
  h.state.tickets = [];
  for (const k of ['shouldReset', 'toggleUpNext', 'trackedPatch', 'openDetail', 'loadTickets', 'channelAutoTrigger'] as const) h[k].mockReset();
  h.toggleUpNext.mockResolvedValue(undefined); h.trackedPatch.mockResolvedValue(undefined); h.loadTickets.mockResolvedValue(undefined);
  bindDetailUpNext();
});
afterEach(() => { document.body.innerHTML = ''; });

const click = async (): Promise<void> => { document.getElementById('detail-upnext')!.click(); await flush(); };

describe('bindDetailUpNext', () => {
  it('no-ops when no ticket is active', async () => {
    await click();
    expect(h.trackedPatch).not.toHaveBeenCalled();
    expect(h.toggleUpNext).not.toHaveBeenCalled();
  });

  it('starring a backlog ticket resets status to not_started + up_next true', async () => {
    h.state.activeTicketId = 5;
    h.state.tickets = [{ id: 5, status: 'archived', up_next: false }];
    h.shouldReset.mockReturnValue(true);
    await click();
    expect(h.trackedPatch).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), { status: 'not_started', up_next: true }, 'Toggle up next');
    expect(h.loadTickets).toHaveBeenCalled();
    expect(h.channelAutoTrigger).toHaveBeenCalled();
    expect(h.openDetail).toHaveBeenCalledWith(5);
  });

  it('toggling an already-up-next ticket just flips up_next', async () => {
    h.state.activeTicketId = 6;
    h.state.tickets = [{ id: 6, status: 'started', up_next: true }];
    h.shouldReset.mockReturnValue(false);
    await click();
    expect(h.trackedPatch).toHaveBeenCalledWith(expect.objectContaining({ id: 6 }), { up_next: false }, 'Toggle up next');
  });

  it('falls back to toggleUpNext when the ticket is not in local state', async () => {
    h.state.activeTicketId = 9;
    h.state.tickets = []; // not found
    await click();
    expect(h.toggleUpNext).toHaveBeenCalledWith(9);
    expect(h.trackedPatch).not.toHaveBeenCalled();
  });
});
