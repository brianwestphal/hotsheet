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

  // Click ticket number to copy to clipboard.
  //
  // HS-9408 — the "Copied!" confirmation is a CSS overlay (`.is-copied` → a
  // `::after`), NOT a `textContent` swap. Pre-fix the handler wrote 'Copied!'
  // INTO the element and read the number back out of it on the next click, so
  // the element was both the display and the source of truth. Two bugs fell out:
  //
  //   1. Clicking twice inside the 1 s window copied the literal string
  //      "Copied!" to the clipboard (the reported symptom), and
  //   2. the second click captured 'Copied!' as `original`, so the restore left
  //      the header permanently reading "Copied!" until the panel re-rendered.
  //
  // A pending restore was also a landmine across ticket switches: `detail.tsx`
  // rewrites this element on load, and a timer from the previous ticket would
  // clobber the new number ~1 s later.
  //
  // Keeping `textContent` always equal to the real ticket number removes the
  // whole class — there is no state to restore and nothing to race.
  const ticketNumEl = byId('detail-ticket-number');
  ticketNumEl.style.cursor = 'pointer';
  ticketNumEl.title = 'Click to copy';
  let copiedFlashTimer: ReturnType<typeof setTimeout> | null = null;
  ticketNumEl.addEventListener('click', () => {
    const num = ticketNumEl.textContent;
    if (num === '') return;
    void navigator.clipboard.writeText(num);
    ticketNumEl.classList.add('is-copied');
    // Restart the flash on a repeat click rather than letting the first timer
    // clear it out from under the second.
    if (copiedFlashTimer !== null) clearTimeout(copiedFlashTimer);
    copiedFlashTimer = setTimeout(() => {
      ticketNumEl.classList.remove('is-copied');
      copiedFlashTimer = null;
    }, 1000);
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
