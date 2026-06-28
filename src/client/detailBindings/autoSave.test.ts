// @vitest-environment happy-dom
/** HS-9143 — `bindDetailAutoSave`: per-field input → undo + debounced save branches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailAutoSave } from './autoSave.js';

const h = vi.hoisted(() => ({
  state: { activeTicketId: null as number | null, tickets: [] as Array<{ id: number }> },
  updateTicketField: vi.fn(() => Promise.resolve()),
  renderDetailsMarkdown: vi.fn(),
  syncDetailReaderButton: vi.fn(),
  recordTextChange: vi.fn(),
  loadTickets: vi.fn(() => Promise.resolve()),
  timeout: null as ReturnType<typeof setTimeout> | null,
}));
vi.mock('../../api/index.js', () => ({ updateTicketField: h.updateTicketField }));
vi.mock('../constants/timers.js', () => ({ TIMERS: { DETAIL_SAVE_MS: 500 } }));
vi.mock('../detail.js', () => ({ renderDetailsMarkdown: h.renderDetailsMarkdown }));
vi.mock('../readerOverlay.js', () => ({ syncDetailReaderButton: h.syncDetailReaderButton }));
vi.mock('../shortcuts.js', () => ({ getDetailSaveTimeout: () => h.timeout, setDetailSaveTimeout: (t: ReturnType<typeof setTimeout> | null) => { h.timeout = t; } }));
vi.mock('../state.js', () => ({ state: h.state }));
vi.mock('../ticketList.js', () => ({ loadTickets: h.loadTickets }));
vi.mock('../undo/actions.js', () => ({ recordTextChange: h.recordTextChange }));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<input id="detail-title"><textarea id="detail-details"></textarea>';
  h.state.activeTicketId = 1; h.state.tickets = [{ id: 1 }]; h.timeout = null;
  for (const k of ['updateTicketField', 'renderDetailsMarkdown', 'syncDetailReaderButton', 'recordTextChange', 'loadTickets'] as const) h[k].mockReset();
  h.updateTicketField.mockResolvedValue(undefined); h.loadTickets.mockResolvedValue(undefined);
  bindDetailAutoSave();
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

function type(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
}

describe('bindDetailAutoSave', () => {
  it('title input records undo + debounce-saves; not the markdown re-render', async () => {
    type('detail-title', 'New title');
    expect(h.recordTextChange).toHaveBeenCalledWith({ id: 1 }, 'title', 'New title');
    expect(h.syncDetailReaderButton).not.toHaveBeenCalled();
    expect(h.updateTicketField).not.toHaveBeenCalled(); // still debouncing
    await vi.advanceTimersByTimeAsync(500);
    expect(h.updateTicketField).toHaveBeenCalledWith(1, 'title', 'New title');
  });

  it('details input also re-renders the markdown sibling + syncs the reader button', async () => {
    type('detail-details', 'body');
    expect(h.recordTextChange).toHaveBeenCalledWith({ id: 1 }, 'details', 'body');
    expect(h.syncDetailReaderButton).toHaveBeenCalled();
    expect(h.renderDetailsMarkdown).toHaveBeenCalledWith('body');
    await vi.advanceTimersByTimeAsync(500);
    expect(h.updateTicketField).toHaveBeenCalledWith(1, 'details', 'body');
  });

  it('a second keystroke clears the prior pending save (debounce coalesces)', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    type('detail-title', 'a');
    type('detail-title', 'ab'); // second input sees an existing timeout → clears it
    expect(clearSpy).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(h.updateTicketField).toHaveBeenCalledTimes(1); // only the latest fired
    expect(h.updateTicketField).toHaveBeenCalledWith(1, 'title', 'ab');
  });

  it('skips recordTextChange when the ticket is not in local state', () => {
    h.state.tickets = [];
    type('detail-title', 'x');
    expect(h.recordTextChange).not.toHaveBeenCalled();
  });

  it('the debounced save no-ops if the ticket was deselected before it fired', async () => {
    type('detail-title', 'x');
    h.state.activeTicketId = null; // deselected during the debounce window
    await vi.advanceTimersByTimeAsync(500);
    expect(h.updateTicketField).not.toHaveBeenCalled();
  });
});
