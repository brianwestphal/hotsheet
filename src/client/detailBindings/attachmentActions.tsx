/**
 * HS-8553 — extracted from `src/client/app.tsx`. Attachment row click /
 * dblclick / keyboard handlers for the detail panel — reveal in file
 * manager, delete, select, arrow-key nav, Space to preview. Also owns
 * the `previewAttachment` helper since it's the only consumer.
 */
import { deleteAttachment, revealAttachment } from '../../api/index.js';
import { openDetail } from '../detail.js';
import { byId, toElement } from '../dom.js';
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
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- no universal replacement for platform detection
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
  attEl.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;

    // Reveal in file manager
    const revealBtn: HTMLElement | null = target.closest('.attachment-reveal');
    if (revealBtn) {
      const attId = revealBtn.dataset['attId'];
      if (attId !== undefined && attId !== '') void revealAttachment(Number(attId));
      return;
    }

    // Delete
    const deleteBtn: HTMLElement | null = target.closest('.attachment-delete');
    if (deleteBtn !== null) {
      const attId = deleteBtn.dataset['attId'];
      if (attId === undefined || attId === '') return;
      await deleteAttachment(Number(attId));
      if (state.activeTicketId != null) {
        openDetail(state.activeTicketId);
      }
      return;
    }

    // Select attachment item (click on the row itself)
    const item: HTMLElement | null = target.closest('.attachment-item');
    if (item) {
      attEl.querySelectorAll('.attachment-item.selected').forEach(el => el.classList.remove('selected'));
      item.classList.add('selected');
      item.focus();
    }
  });

  // Double-click to preview
  attEl.addEventListener('dblclick', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.attachment-item');
    if (item != null) void previewAttachment(item);
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
