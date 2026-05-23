/**
 * HS-8553 — orchestrator extracted from `src/client/app.tsx`. Calls
 * the per-binding helpers in this directory + wires the small handful
 * of pieces that didn't justify their own file (close button + the
 * ticket-number copy-to-clipboard click).
 */
import { bindDetailDetailsRenderToggle, closeDetail } from '../detail.js';
import { byId } from '../dom.js';
import { bindDetailTagInput } from '../tagAutocomplete.js';
import { bindDetailAttachmentActions } from './attachmentActions.js';
import { bindDetailAutoSave } from './autoSave.js';
import { bindDetailDropdowns } from './dropdowns.js';
import { bindDetailFileUpload } from './fileUpload.js';
import { bindDetailNotes } from './notes.js';
import { bindDetailReaderButton } from './readerButton.js';
import { bindDetailUpNext } from './upNext.js';

export function bindDetailPanel(): void {
  byId('detail-close').addEventListener('click', closeDetail);

  // Click ticket number to copy to clipboard
  const ticketNumEl = byId('detail-ticket-number');
  ticketNumEl.style.cursor = 'pointer';
  ticketNumEl.title = 'Click to copy';
  ticketNumEl.addEventListener('click', () => {
    const num = ticketNumEl.textContent;
    if (num !== '') {
      void navigator.clipboard.writeText(num);
      const original = ticketNumEl.textContent;
      ticketNumEl.textContent = 'Copied!';
      setTimeout(() => { ticketNumEl.textContent = original; }, 1000);
    }
  });

  bindDetailAutoSave();
  bindDetailReaderButton();
  bindDetailDetailsRenderToggle();
  bindDetailDropdowns();
  bindDetailUpNext();
  bindDetailNotes();
  bindDetailFileUpload();
  bindDetailAttachmentActions();
  bindDetailTagInput();
}
