// @vitest-environment happy-dom
/** HS-9143 — `bindDetailPanel`: close button + ticket-number copy-to-clipboard,
 *  and that it wires the sub-bindings. The sub-bind modules are mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailPanel } from './panel.js';

const h = vi.hoisted(() => ({
  closeDetail: vi.fn(),
  bindDetailDetailsRenderToggle: vi.fn(),
  bindDetailTagInput: vi.fn(),
  bindDetailAutoSave: vi.fn(),
  bindDetailDropdowns: vi.fn(),
  bindDetailUpNext: vi.fn(),
  bindDetailNotes: vi.fn(),
  bindDetailFileUpload: vi.fn(),
  bindDetailAttachmentActions: vi.fn(),
  bindDetailReaderButton: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock('../detail.js', () => ({ closeDetail: h.closeDetail, bindDetailDetailsRenderToggle: h.bindDetailDetailsRenderToggle }));
vi.mock('../tagAutocomplete.js', () => ({ bindDetailTagInput: h.bindDetailTagInput }));
vi.mock('./autoSave.js', () => ({ bindDetailAutoSave: h.bindDetailAutoSave }));
vi.mock('./dropdowns.js', () => ({ bindDetailDropdowns: h.bindDetailDropdowns }));
vi.mock('./upNext.js', () => ({ bindDetailUpNext: h.bindDetailUpNext }));
vi.mock('./notes.js', () => ({ bindDetailNotes: h.bindDetailNotes }));
vi.mock('./fileUpload.js', () => ({ bindDetailFileUpload: h.bindDetailFileUpload }));
vi.mock('./attachmentActions.js', () => ({ bindDetailAttachmentActions: h.bindDetailAttachmentActions }));
vi.mock('./readerButton.js', () => ({ bindDetailReaderButton: h.bindDetailReaderButton }));

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '<button id="detail-close"></button><span id="detail-ticket-number">HS-42</span>';
  Object.values(h).forEach(fn => fn.mockReset());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: h.writeText } });
  bindDetailPanel();
});
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('bindDetailPanel', () => {
  it('wires the close button to closeDetail', () => {
    document.getElementById('detail-close')!.click();
    expect(h.closeDetail).toHaveBeenCalled();
  });

  it('clicking the ticket number copies it + shows a transient "Copied!"', () => {
    const el = document.getElementById('detail-ticket-number')!;
    el.click();
    expect(h.writeText).toHaveBeenCalledWith('HS-42');
    expect(el.textContent).toBe('Copied!');
    vi.advanceTimersByTime(1000);
    expect(el.textContent).toBe('HS-42'); // restored
  });

  it('does not copy when the ticket number is empty', () => {
    const el = document.getElementById('detail-ticket-number')!;
    el.textContent = '';
    el.click();
    expect(h.writeText).not.toHaveBeenCalled();
  });

  it('invokes the sub-bindings', () => {
    expect(h.bindDetailAutoSave).toHaveBeenCalled();
    expect(h.bindDetailDropdowns).toHaveBeenCalled();
    expect(h.bindDetailUpNext).toHaveBeenCalled();
    expect(h.bindDetailTagInput).toHaveBeenCalled();
    expect(h.bindDetailAttachmentActions).toHaveBeenCalled();
  });
});
