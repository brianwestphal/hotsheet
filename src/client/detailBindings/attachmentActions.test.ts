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

import { previewAttachment } from './attachmentActions.js';

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
