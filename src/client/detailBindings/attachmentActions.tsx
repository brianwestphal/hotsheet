/**
 * HS-8553 — extracted from `src/client/app.tsx`. Attachment row click /
 * dblclick / keyboard handlers for the detail panel — reveal in file
 * manager, delete, select, arrow-key nav, Space to preview. Also owns
 * the `previewAttachment` helper since it's the only consumer.
 */
import { deleteAttachment, revealAttachment } from '../../api/index.js';
import { openDetail } from '../detail.js';
import { byId, toElement } from '../dom.js';
import { delegate } from '../reactive.js';
import { state } from '../state.js';
import { getTauriInvoke } from '../tauriIntegration.js';

/** Preview an attachment — Quicklook on macOS (Tauri), inline overlay in browser.
 *  Exported for the `bindDetailAttachmentActions` handlers below; not part of
 *  the panel's public surface. */
export async function previewAttachment(item: HTMLElement): Promise<void> {
  const filename = item.dataset.filename ?? '';
  const attId = item.dataset.attId ?? '';
  if (attId === '') return;

  // Tauri: use qlmanage for macOS Quicklook
  const invoke = getTauriInvoke();
  if (invoke && navigator.platform.includes('Mac')) {
    const storedPath = item.dataset.storedPath ?? '';
    if (storedPath !== '') {
      try { await invoke('quicklook', { path: storedPath }); } catch { /* fallback below */ }
      return;
    }
  }

  // Browser fallback: show inline preview overlay for images
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const imageExts = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp']);
  const pdfExts = new Set(['pdf']);

  if (imageExts.has(ext) || pdfExts.has(ext)) {
    const overlay = toElement(
      <div className="quicklook-overlay" style="position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;cursor:pointer">
        {imageExts.has(ext)
          ? <img src={`/api/attachments/file/${encodeURIComponent(filename)}`} style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.4)" alt={filename} />
          : <iframe src={`/api/attachments/file/${encodeURIComponent(filename)}`} style="width:80vw;height:85vh;border:none;border-radius:8px" title={filename}></iframe>
        }
      </div>
    );
    overlay.addEventListener('click', () => overlay.remove());
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape' || e.key === ' ') { e.preventDefault(); overlay.remove(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(overlay);
  }
}

export function bindDetailAttachmentActions(): void {
  const attEl = byId('detail-attachments');
  // HS-8615 — kerf `delegate()` (was hand-rolled `addEventListener` +
  // `closest()`). `#detail-attachments` is page-lifetime, so the disposers are
  // discarded via `void`. The reveal / delete buttons are CHILDREN of
  // `.attachment-item`, so a single `.attachment-item` delegate + an in-handler
  // `closest()` branch preserves the pre-fix priority order (reveal → delete →
  // select) without the three nested selectors racing each other.
  void delegate<HTMLElement>(attEl, 'click', '.attachment-item', (e, item) => {
    const target = e.target instanceof Element ? e.target : null;

    // Reveal in file manager
    const revealBtn = target?.closest<HTMLElement>('.attachment-reveal');
    if (revealBtn) {
      const attId = revealBtn.dataset['attId'];
      if (attId !== undefined && attId !== '') void revealAttachment(Number(attId));
      return;
    }

    // Delete
    const deleteBtn = target?.closest<HTMLElement>('.attachment-delete');
    if (deleteBtn) {
      const attId = deleteBtn.dataset['attId'];
      if (attId === undefined || attId === '') return;
      void deleteAttachment(Number(attId)).then(() => {
        if (state.activeTicketId != null) openDetail(state.activeTicketId);
      });
      return;
    }

    // Select attachment item (click on the row itself)
    attEl.querySelectorAll('.attachment-item.selected').forEach(el => el.classList.remove('selected'));
    item.classList.add('selected');
    item.focus();
  });

  // Double-click to preview
  void delegate<HTMLElement>(attEl, 'dblclick', '.attachment-item', (_e, item) => {
    void previewAttachment(item);
  });

  // Keyboard navigation and Space to preview
  attEl.addEventListener('keydown', (e) => {
    const active = document.activeElement as HTMLElement | null;
    if (active == null || !active.classList.contains('attachment-item')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = Array.from(attEl.querySelectorAll<HTMLElement>('.attachment-item'));
      const idx = items.indexOf(active);
      const nextIdx = e.key === 'ArrowDown' ? idx + 1 : idx - 1;
      if (nextIdx >= 0 && nextIdx < items.length) {
        const next = items[nextIdx];
        items.forEach(el => el.classList.remove('selected'));
        next.classList.add('selected');
        next.focus();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      void previewAttachment(active);
    }
  });
}
