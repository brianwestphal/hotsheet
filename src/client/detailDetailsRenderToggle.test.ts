/**
 * HS-8062 — clicking a `HS-NNNN` reference inside the rendered Details
 * markdown view must open the ticket-reference dialog, not enter edit
 * mode. The capture-phase global handler in `ticketRefDialog.tsx` runs
 * `stopPropagation` on `.ticket-ref` clicks so the bubble-phase listener
 * on the rendered div never fires — but on Tauri's WKWebView the
 * mousedown's *focus delegation* can route focus to the closest
 * tabbable ancestor (this rendered div, via `tabIndex=0`) when the
 * click target is an anchor with `href="javascript:void(0)"`. That
 * focus event would normally trigger `setDetailsEditing(true)` BEFORE
 * the capture-phase click handler intercepts the click — leaving edit
 * mode armed underneath the dialog.
 *
 * Fix: suppress the focus-driven edit-mode entry when a mousedown
 * landed inside the rendered div in the immediately-preceding window.
 * Click-driven focus is owned by the click path; keyboard tab focus
 * (no preceding mousedown) still flips into edit mode.
 */
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as StateModule from './state.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
vi.mock('./api.js', () => ({ api: (...args: unknown[]) => apiMock(...args) }));
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));
vi.mock('./state.js', async (importOriginal) => {
  const actual = await importOriginal<typeof StateModule>();
  return {
    ...actual,
    state: {
      ...actual.state,
      tickets: [{ id: 1, ticket_number: 'HS-1', details: '', title: 'x' }],
      activeTicketId: 1,
    },
  };
});

let globalHandlerBound = false;

beforeEach(async () => {
  if (!globalHandlerBound) {
    const mod = await import('./ticketRefDialog.js');
    mod.bindTicketRefGlobalClickHandler();
    globalHandlerBound = true;
  }
  document.body.innerHTML = `
    <div class="detail-details-wrap">
      <div id="detail-details-rendered" class="detail-details-rendered note-markdown" tabindex="0"></div>
      <textarea id="detail-details" rows="6"></textarea>
    </div>
  `;
  apiMock.mockReset();
  // Hang any prefix lookups so the dialog open path doesn't tear down DOM.
  apiMock.mockReturnValue(new Promise(() => { /* never */ }));
});

afterEach(() => { document.body.innerHTML = ''; });

describe('bindDetailDetailsRenderToggle — WKWebView focus-delegation guard (HS-8062)', () => {
  it('clicking a `.ticket-ref` does NOT enter edit mode (capture-phase intercept holds)', async () => {
    const detail = await import('./detail.js');
    detail.bindDetailDetailsRenderToggle();

    const rendered = document.getElementById('detail-details-rendered')!;
    rendered.innerHTML = '<p>see <a class="ticket-ref" data-ticket-number="HS-1234" href="javascript:void(0)">HS-1234</a></p>';

    const anchor = rendered.querySelector('.ticket-ref') as HTMLElement;
    anchor.click();

    const wrap = document.querySelector('.detail-details-wrap')!;
    expect(wrap.classList.contains('is-editing')).toBe(false);
  });

  it('a focus event on rendered THAT FOLLOWS a mousedown on rendered does NOT enter edit mode (covers WKWebView delegation)', async () => {
    const detail = await import('./detail.js');
    detail.bindDetailDetailsRenderToggle();

    const rendered = document.getElementById('detail-details-rendered')!;
    rendered.innerHTML = '<p>see <a class="ticket-ref" data-ticket-number="HS-1234" href="javascript:void(0)">HS-1234</a></p>';

    // Simulate the WKWebView path: mousedown lands inside rendered, then
    // focus is delegated to rendered (not the anchor) because of the
    // `javascript:void(0)` href.
    const anchor = rendered.querySelector('.ticket-ref') as HTMLElement;
    anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    rendered.dispatchEvent(new FocusEvent('focus'));

    const wrap = document.querySelector('.detail-details-wrap')!;
    expect(wrap.classList.contains('is-editing')).toBe(false);
  });

  it('a focus event WITHOUT a preceding mousedown DOES enter edit mode (keyboard tab path stays working)', async () => {
    const detail = await import('./detail.js');
    detail.bindDetailDetailsRenderToggle();

    const rendered = document.getElementById('detail-details-rendered')!;
    // Keyboard tab into the rendered div — no mousedown precedes.
    rendered.dispatchEvent(new FocusEvent('focus'));

    const wrap = document.querySelector('.detail-details-wrap')!;
    expect(wrap.classList.contains('is-editing')).toBe(true);
  });

  it('a focus event LONG after a mousedown DOES enter edit mode (the suppression window is short)', async () => {
    const detail = await import('./detail.js');
    detail.bindDetailDetailsRenderToggle();

    const rendered = document.getElementById('detail-details-rendered')!;

    // First, simulate a stale mousedown.
    rendered.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    // Wait past the 250 ms suppression window, then dispatch focus.
    await new Promise(r => setTimeout(r, 320));
    rendered.dispatchEvent(new FocusEvent('focus'));

    const wrap = document.querySelector('.detail-details-wrap')!;
    expect(wrap.classList.contains('is-editing')).toBe(true);
  });

  it('clicking on plain non-ref text inside rendered enters edit mode (normal click-to-edit path)', async () => {
    const detail = await import('./detail.js');
    detail.bindDetailDetailsRenderToggle();

    const rendered = document.getElementById('detail-details-rendered')!;
    rendered.innerHTML = '<p>just some plain prose</p>';

    const p = rendered.querySelector('p')!;
    p.click();

    const wrap = document.querySelector('.detail-details-wrap')!;
    expect(wrap.classList.contains('is-editing')).toBe(true);
  });
});
