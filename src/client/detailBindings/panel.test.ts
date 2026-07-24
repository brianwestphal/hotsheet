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
    // HS-9408 — the flash is a CSS overlay; the label itself is never rewritten.
    expect(el.classList.contains('is-copied')).toBe(true);
    expect(el.textContent).toBe('HS-42');
    vi.advanceTimersByTime(1000);
    expect(el.classList.contains('is-copied')).toBe(false);
    expect(el.textContent).toBe('HS-42');
  });

  // HS-9408 — the reported bug: a second click inside the 1 s confirmation window
  // used to read the label back out of the DOM, which by then said "Copied!".
  it('a second click within the flash window still copies the NUMBER, not "Copied!"', () => {
    const el = document.getElementById('detail-ticket-number')!;
    el.click();
    vi.advanceTimersByTime(200); // still flashing
    el.click();
    expect(h.writeText).toHaveBeenCalledTimes(2);
    expect(h.writeText).toHaveBeenNthCalledWith(2, 'HS-42');
    expect(h.writeText).not.toHaveBeenCalledWith('Copied!');
  });

  // HS-9408 — the second failure mode: the repeat click captured 'Copied!' as the
  // value to restore, permanently corrupting the header.
  it('the label is intact after the flash from a double click expires', () => {
    const el = document.getElementById('detail-ticket-number')!;
    el.click();
    vi.advanceTimersByTime(200);
    el.click();
    // The second click restarts the timer, so the flash outlives the first one.
    vi.advanceTimersByTime(900);
    expect(el.classList.contains('is-copied')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(el.classList.contains('is-copied')).toBe(false);
    expect(el.textContent).toBe('HS-42');
  });

  // HS-9408 — a pending restore used to be a landmine across ticket switches:
  // `detail.tsx` rewrites this element on load, and the old timer would clobber
  // the new number ~1 s later.
  it('does not clobber the next ticket\'s number when the panel re-renders mid-flash', () => {
    const el = document.getElementById('detail-ticket-number')!;
    el.click();
    el.textContent = 'HS-99'; // detail.tsx loading a different ticket
    vi.advanceTimersByTime(1000);
    expect(el.textContent).toBe('HS-99');
  });

  it('repeated clicks over time keep copying the number', () => {
    const el = document.getElementById('detail-ticket-number')!;
    for (let i = 0; i < 5; i++) {
      el.click();
      vi.advanceTimersByTime(1500); // let each flash fully expire
    }
    expect(h.writeText).toHaveBeenCalledTimes(5);
    for (const call of h.writeText.mock.calls) expect(call[0]).toBe('HS-42');
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
