// @vitest-environment happy-dom
/** HS-9143 — `bindDetailReaderButton` click branches (reader overlay). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailReaderButton } from './readerButton.js';

const h = vi.hoisted(() => ({
  state: { activeTicketId: null as number | null, tickets: [] as Array<{ id: number; ticket_number: string; title: string; notes: string }> },
  openReaderOverlay: vi.fn(),
  syncDetailReaderButton: vi.fn(),
  buildDetailsReaderTitle: vi.fn(() => 'Title'),
  buildCombinedReaderEntries: vi.fn<() => Array<{ id: string; title: string; markdown: string }>>(),
  parseNotesJson: vi.fn(() => [] as unknown[]),
}));
vi.mock('../state.js', () => ({ state: h.state }));
vi.mock('../readerOverlay.js', () => ({
  openReaderOverlay: h.openReaderOverlay,
  syncDetailReaderButton: h.syncDetailReaderButton,
  buildDetailsReaderTitle: h.buildDetailsReaderTitle,
  buildCombinedReaderEntries: h.buildCombinedReaderEntries,
}));
vi.mock('../noteRenderer.js', () => ({ parseNotesJson: h.parseNotesJson }));

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

function setup(withBtn = true): void {
  document.body.innerHTML = (withBtn ? '<button id="detail-reader-btn"></button>' : '') + '<textarea id="detail-details"></textarea>';
}

beforeEach(() => {
  for (const k of ['openReaderOverlay', 'syncDetailReaderButton', 'buildDetailsReaderTitle', 'buildCombinedReaderEntries', 'parseNotesJson'] as const) h[k].mockReset();
  h.buildDetailsReaderTitle.mockReturnValue('Title');
  h.parseNotesJson.mockReturnValue([]);
  h.state.activeTicketId = null; h.state.tickets = [];
});
afterEach(() => { document.body.innerHTML = ''; });

describe('bindDetailReaderButton', () => {
  it('no-ops (no throw) when the reader button is absent', () => {
    setup(false);
    expect(() => bindDetailReaderButton()).not.toThrow();
    expect(h.syncDetailReaderButton).not.toHaveBeenCalled();
  });

  it('syncs the button state on bind', () => {
    setup();
    bindDetailReaderButton();
    expect(h.syncDetailReaderButton).toHaveBeenCalled();
  });

  it('does nothing when the button is disabled', async () => {
    setup();
    bindDetailReaderButton();
    const btn = document.getElementById('detail-reader-btn') as HTMLButtonElement;
    btn.disabled = true;
    btn.click();
    await flush();
    expect(h.openReaderOverlay).not.toHaveBeenCalled();
  });

  it('opens the overlay with navigation when there is more than one entry', async () => {
    setup();
    h.state.activeTicketId = 4;
    h.state.tickets = [{ id: 4, ticket_number: 'HS-4', title: 'T', notes: '[]' }];
    (document.getElementById('detail-details') as HTMLTextAreaElement).value = 'body';
    h.buildCombinedReaderEntries.mockReturnValue([
      { id: 'details', title: 'Details', markdown: 'body' },
      { id: 'n1', title: 'Note', markdown: 'note' },
    ]);
    bindDetailReaderButton();
    document.getElementById('detail-reader-btn')!.click();
    await flush();
    expect(h.openReaderOverlay).toHaveBeenCalledTimes(1);
    const arg = h.openReaderOverlay.mock.calls[0][0] as { navigation?: { initialIndex: number; entries: unknown[] } };
    expect(arg.navigation).toBeDefined();
    expect(arg.navigation!.initialIndex).toBe(0); // details is first
    expect(arg.navigation!.entries).toHaveLength(2);
  });

  it('omits navigation when there is a single entry', async () => {
    setup();
    h.state.activeTicketId = 4;
    h.state.tickets = [{ id: 4, ticket_number: 'HS-4', title: 'T', notes: '[]' }];
    h.buildCombinedReaderEntries.mockReturnValue([{ id: 'details', title: 'Details', markdown: 'body' }]);
    bindDetailReaderButton();
    document.getElementById('detail-reader-btn')!.click();
    await flush();
    const arg = h.openReaderOverlay.mock.calls[0][0] as { navigation?: unknown };
    expect(arg.navigation).toBeUndefined();
  });
});
