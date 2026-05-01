/**
 * HS-8062 — clicking a `.ticket-ref` anchor inside a parent that has its
 * own click-to-edit listener (the note-entry's click handler in
 * `noteRenderer.tsx`, the `.detail-details-rendered` click handler in
 * `detail.tsx`) must fire the ticket-reference dialog ONLY — the
 * ancestor edit handler should never see the click. Pre-fix the global
 * handler ran in the bubble phase, which fired AFTER any ancestor
 * listener; so notes ended up both opening the reader AND entering edit
 * mode, and details (whose rendered click handler also passed through
 * for non-anchor targets if linkify hadn't run yet) entered edit mode
 * without the reader showing.
 *
 * Fix: register the global handler with `capture: true` so it runs in
 * the capture phase and `stopPropagation()` prevents the click from
 * reaching ancestor listeners at all.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock('./api.js', () => ({ api: (...args: unknown[]) => apiMock(...args) }));
vi.mock('./detail.js', () => ({ openDetail: vi.fn() }));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
vi.mock('./state.js', () => ({ state: { tickets: [] } }));

// Bind the global handler once for the suite. Each test cleans up the
// DOM body between runs but the document-level listener stays attached;
// re-binding per test would attach duplicate listeners (document is
// shared across tests in the happy-dom environment) and lead to the
// same click being processed N times.
let handlerBound = false;

beforeEach(async () => {
  if (!handlerBound) {
    const mod = await import('./ticketRefDialog.js');
    mod.bindTicketRefGlobalClickHandler();
    handlerBound = true;
  }
  document.body.innerHTML = '';
  apiMock.mockReset();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('bindTicketRefGlobalClickHandler — capture-first interception (HS-8062)', () => {
  it('stops the click from reaching an ancestor click handler when target is `.ticket-ref`', () => {

    // Mimic the note-entry shape: a parent with a click-to-edit listener,
    // a `.ticket-ref` anchor inside.
    const parent = document.createElement('div');
    parent.className = 'note-entry';
    const anchor = document.createElement('a');
    anchor.className = 'ticket-ref';
    anchor.dataset.ticketNumber = 'HS-1234';
    anchor.setAttribute('href', 'javascript:void(0)');
    anchor.textContent = 'HS-1234';
    parent.appendChild(anchor);
    document.body.appendChild(parent);

    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);

    // Mock the by-number lookup so the dialog open path doesn't blow up.
    // Hang the api fetch so the dialog body never tries to render in
    // this test — we only care about click-propagation, not the dialog
    // contents.
    apiMock.mockReturnValueOnce(new Promise(() => { /* never resolves */ }));

    anchor.click();

    expect(parentClick).not.toHaveBeenCalled();
  });

  it('lets non-ticket-ref clicks propagate to the parent normally', () => {

    const parent = document.createElement('div');
    parent.className = 'note-entry';
    const innerSpan = document.createElement('span');
    innerSpan.textContent = 'plain text not a ref';
    parent.appendChild(innerSpan);
    document.body.appendChild(parent);

    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);

    innerSpan.click();

    expect(parentClick).toHaveBeenCalledTimes(1);
  });

  it('also intercepts clicks where the ticket-ref is an ancestor (event target is a descendant element of the anchor)', () => {

    const parent = document.createElement('div');
    parent.className = 'detail-details-rendered';
    const anchor = document.createElement('a');
    anchor.className = 'ticket-ref';
    anchor.dataset.ticketNumber = 'HS-9';
    anchor.setAttribute('href', 'javascript:void(0)');
    // Inject a child element so the click target is the descendant, not
    // the anchor itself — happy-dom click() defaults to dispatching from
    // the element itself; we use dispatchEvent on the descendant to
    // verify `closest('.ticket-ref')` ancestor-walks correctly.
    const inner = document.createElement('strong');
    inner.textContent = 'HS-9';
    anchor.appendChild(inner);
    parent.appendChild(anchor);
    document.body.appendChild(parent);

    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);

    apiMock.mockReturnValueOnce(new Promise(() => { /* never resolves */ }));

    inner.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(parentClick).not.toHaveBeenCalled();
  });

  it('skips when the data-ticket-number attribute is empty', () => {

    const parent = document.createElement('div');
    parent.className = 'note-entry';
    const anchor = document.createElement('a');
    anchor.className = 'ticket-ref';
    anchor.dataset.ticketNumber = '';
    anchor.setAttribute('href', 'javascript:void(0)');
    anchor.textContent = '';
    parent.appendChild(anchor);
    document.body.appendChild(parent);

    const parentClick = vi.fn();
    parent.addEventListener('click', parentClick);

    anchor.click();

    // Empty data-ticket-number bails before stopPropagation, so the
    // ancestor handler still runs (this also pins the no-op behaviour
    // for malformed anchors — they shouldn't break click-to-edit).
    expect(parentClick).toHaveBeenCalledTimes(1);
  });
});
