// @vitest-environment happy-dom
/**
 * HS-8826 — `previewAttachment` integration coverage.
 *
 * The bug: in the Tauri/macOS branch the `return` sat OUTSIDE the try/catch
 * around `invoke('quicklook', …)`, so a FAILED Quick Look (missing file,
 * qlmanage error) still returned and the "fallback below" the comment promised
 * was dead code — nothing happened at all. These tests pin down:
 *
 *  1. Tauri + macOS + a stored path → calls the native `quicklook` command and
 *     does NOT build the browser overlay.
 *  2. Tauri + macOS but `quicklook` THROWS → falls through to the inline
 *     browser overlay (the regression fix).
 *  3. Browser (no Tauri) + an image → builds the overlay.
 *  4. Browser + a non-previewable file → no overlay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindDetailAttachmentActions, previewAttachment } from './attachmentActions.js';

// HS-9143 — mocks for the `bindDetailAttachmentActions` handlers. `previewAttachment`
// (tested above) uses none of these (only getTauriInvoke), so the mocks don't affect
// those cases. `reactive` (delegate) + `dom` stay real so event delegation works.
const m = vi.hoisted(() => ({
  deleteAttachment: vi.fn<(id: number) => Promise<void>>(),
  revealAttachment: vi.fn<(id: number) => Promise<void>>(),
  openDetail: vi.fn(),
  state: { activeTicketId: null as number | null },
}));
vi.mock('../../api/index.js', () => ({ deleteAttachment: m.deleteAttachment, revealAttachment: m.revealAttachment }));
vi.mock('../detail.js', () => ({ openDetail: m.openDetail }));
vi.mock('../state.js', () => ({ state: m.state }));

interface TauriWindow extends Window { __TAURI__?: { core?: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } } }

function makeItem(opts: { filename: string; attId?: string; storedPath?: string }): HTMLElement {
  const el = document.createElement('div');
  el.className = 'attachment-item';
  el.dataset.filename = opts.filename;
  el.dataset.attId = opts.attId ?? '7';
  if (opts.storedPath !== undefined) el.dataset.storedPath = opts.storedPath;
  document.body.appendChild(el);
  return el;
}

/** Force macOS detection regardless of the happy-dom host UA. */
function stubMac(): void {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
}

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.quicklook-overlay');
}

beforeEach(() => {
  document.body.innerHTML = '';
  stubMac();
});

afterEach(() => {
  delete (window as TauriWindow).__TAURI__;
  document.body.innerHTML = '';
});

describe('previewAttachment — Tauri macOS Quick Look (HS-8826)', () => {
  it('invokes the native quicklook command with the stored path and shows no overlay', async () => {
    const invoke = vi.fn(() => Promise.resolve());
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const item = makeItem({ filename: 'shot.png', storedPath: '/data/attachments/HS-1_shot.png' });

    await previewAttachment(item);

    expect(invoke).toHaveBeenCalledWith('quicklook', { path: '/data/attachments/HS-1_shot.png' });
    expect(overlay()).toBeNull(); // native path handled it — no browser overlay
  });

  it('falls back to the inline overlay when the native quicklook command throws', async () => {
    // The regression: pre-fix this rejection was swallowed and the function
    // returned anyway, so NOTHING was shown. Now it falls through to the
    // browser overlay for the (image) attachment.
    const invoke = vi.fn(() => Promise.reject(new Error('file not found')));
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const item = makeItem({ filename: 'shot.png', storedPath: '/data/attachments/HS-1_shot.png' });

    await previewAttachment(item);

    expect(invoke).toHaveBeenCalledOnce();
    const ov = overlay();
    expect(ov).not.toBeNull();
    // HS-8826 — the overlay must serve by the on-disk STORED basename
    // (`HS-1_shot.png`), NOT the user-facing `original_filename` (`shot.png`):
    // the file is written as `${ticket_number}_<base>.ext`, so a URL built from
    // the original name 404s → the broken-image overlay the user reported.
    expect(ov?.querySelector('img')?.getAttribute('src')).toBe('/api/attachments/file/HS-1_shot.png');
  });

  it('serves by the stored basename even when it differs from the original name (broken-image fix)', async () => {
    // The reported symptom: a draft attachment stored as
    // `HS-8826_draft_xxx_Screenshot 2026-06-17 at 9.19.15 AM.png` was served by
    // the original `Screenshot ….png`, which does not exist on disk → 404.
    const invoke = vi.fn(() => Promise.reject(new Error('qlmanage failed')));
    (window as TauriWindow).__TAURI__ = { core: { invoke } };
    const item = makeItem({
      filename: 'Screenshot 2026-06-17 at 9.19.15 AM.png',
      storedPath: '/data/attachments/HS-8826_draft_abc_Screenshot 2026-06-17 at 9.19.15 AM.png',
    });

    await previewAttachment(item);

    const src = overlay()?.querySelector('img')?.getAttribute('src');
    expect(src).toBe(
      `/api/attachments/file/${encodeURIComponent('HS-8826_draft_abc_Screenshot 2026-06-17 at 9.19.15 AM.png')}`,
    );
  });
});

describe('previewAttachment — browser fallback overlay (HS-8826)', () => {
  it('builds an image overlay in a non-Tauri browser', async () => {
    const item = makeItem({ filename: 'photo.jpeg' }); // no __TAURI__, no storedPath
    await previewAttachment(item);
    const ov = overlay();
    expect(ov).not.toBeNull();
    expect(ov?.querySelector('img')).not.toBeNull();
  });

  // NB: the PDF branch mirrors the image branch (same overlay/esc/click path,
  // just `<iframe>` vs `<img>`); it isn't asserted live here because happy-dom
  // tries to actually network-load an appended `<iframe src>`.

  it('does nothing for a non-previewable file type', async () => {
    const item = makeItem({ filename: 'archive.zip' });
    await previewAttachment(item);
    expect(overlay()).toBeNull();
  });

  it('bails out when the attachment id is missing', async () => {
    const el = document.createElement('div');
    el.className = 'attachment-item';
    el.dataset.filename = 'photo.png';
    el.dataset.attId = ''; // empty → early return
    document.body.appendChild(el);
    await previewAttachment(el);
    expect(overlay()).toBeNull();
  });
});

// HS-9143 — the row click / delete / reveal / keyboard handlers.
describe('bindDetailAttachmentActions', () => {
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

  function row(attId: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'attachment-item';
    item.tabIndex = 0;
    item.dataset.attId = attId;
    item.innerHTML = `<button class="attachment-reveal" data-att-id="${attId}"></button><button class="attachment-delete" data-att-id="${attId}"></button>`;
    return item;
  }
  function container(...ids: string[]): HTMLElement {
    const c = document.createElement('div');
    c.id = 'detail-attachments';
    for (const id of ids) c.appendChild(row(id));
    document.body.appendChild(c);
    return c;
  }

  beforeEach(() => {
    m.deleteAttachment.mockReset().mockResolvedValue(undefined);
    m.revealAttachment.mockReset().mockResolvedValue(undefined);
    m.openDetail.mockReset();
    m.state.activeTicketId = null;
  });

  it('reveal button click reveals the attachment in the file manager', () => {
    container('11');
    bindDetailAttachmentActions();
    document.querySelector<HTMLElement>('.attachment-reveal')!.click();
    expect(m.revealAttachment).toHaveBeenCalledWith(11);
  });

  it('delete button click deletes then reopens the detail', async () => {
    m.state.activeTicketId = 4;
    container('12');
    bindDetailAttachmentActions();
    document.querySelector<HTMLElement>('.attachment-delete')!.click();
    expect(m.deleteAttachment).toHaveBeenCalledWith(12);
    await flush();
    expect(m.openDetail).toHaveBeenCalledWith(4);
  });

  it('clicking the row (not a button) selects + focuses it', () => {
    const c = container('13');
    bindDetailAttachmentActions();
    const item = c.querySelector<HTMLElement>('.attachment-item')!;
    item.click();
    expect(item.classList.contains('selected')).toBe(true);
    expect(m.revealAttachment).not.toHaveBeenCalled();
    expect(m.deleteAttachment).not.toHaveBeenCalled();
  });

  it('ArrowDown moves the selection to the next item', () => {
    const c = container('1', '2');
    bindDetailAttachmentActions();
    const items = c.querySelectorAll<HTMLElement>('.attachment-item');
    items[0].focus();
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(items[1].classList.contains('selected')).toBe(true);
  });

  it('double-click previews the row (browser image overlay)', async () => {
    const c = container('1');
    bindDetailAttachmentActions();
    const item = c.querySelector<HTMLElement>('.attachment-item')!;
    item.dataset.filename = 'pic.png';
    item.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(overlay()).not.toBeNull();
  });

  it('Space on a focused item triggers the preview branch (preventDefault)', () => {
    const c = container('1');
    bindDetailAttachmentActions();
    const item = c.querySelector<HTMLElement>('.attachment-item')!;
    item.dataset.filename = 'pic.png';
    item.focus();
    // The Space branch is the only key path that calls previewAttachment; it
    // preventDefaults. (The opened overlay's own esc-handler closes on the same
    // bubbling Space, so asserting the overlay persists would be racy — assert
    // the branch ran instead.)
    const ev = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    const spy = vi.spyOn(ev, 'preventDefault');
    c.dispatchEvent(ev);
    expect(spy).toHaveBeenCalled();
  });

  it('reveal/delete with an empty attId do nothing', () => {
    container(''); // buttons carry data-att-id=""
    bindDetailAttachmentActions();
    document.querySelector<HTMLElement>('.attachment-reveal')!.click();
    document.querySelector<HTMLElement>('.attachment-delete')!.click();
    expect(m.revealAttachment).not.toHaveBeenCalled();
    expect(m.deleteAttachment).not.toHaveBeenCalled();
  });

  it('delete with no active ticket deletes but does not reopen the detail', async () => {
    m.state.activeTicketId = null;
    container('20');
    bindDetailAttachmentActions();
    document.querySelector<HTMLElement>('.attachment-delete')!.click();
    expect(m.deleteAttachment).toHaveBeenCalledWith(20);
    await flush();
    expect(m.openDetail).not.toHaveBeenCalled();
  });

  it('ignores keydown when no attachment item is focused', () => {
    const c = container('1', '2'); // nothing focused → activeElement is not an .attachment-item
    bindDetailAttachmentActions();
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(c.querySelector('.selected')).toBeNull();
  });

  it('ArrowUp moves up; an arrow at the boundary is a no-op', () => {
    const c = container('1', '2');
    bindDetailAttachmentActions();
    const items = c.querySelectorAll<HTMLElement>('.attachment-item');
    items[1].focus();
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(items[0].classList.contains('selected')).toBe(true);
    // At the top, ArrowUp → nextIdx -1 (out of bounds) → no change.
    items[0].focus();
    items.forEach(el => el.classList.remove('selected'));
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(c.querySelector('.selected')).toBeNull();
  });
});
