import { createTicket, uploadAttachment } from '../api/index.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';
import { showToast } from './toast.js';

/**
 * HS-8662 — paste files/images from the OS clipboard to create attachments.
 *
 * Target resolution by current selection:
 * - **1 ticket selected** → attach to that ticket.
 * - **0 selected** → attach to a new "Attachment" / "Attachments" ticket
 *   (mirrors the dropped-image fallback in `app.tsx::resolveDropTicketId`).
 * - **2+ selected** → no-op + a toast (pasting to multiple tickets at once
 *   isn't supported).
 *
 * A file paste is hijacked regardless of which plain input/textarea has focus
 * (a text field can't accept a file anyway); a text-only paste carries no
 * files and falls through to the browser's native paste. Only rich
 * `contenteditable` surfaces (e.g. a note editor that may handle an inline
 * image itself) are left entirely alone.
 */
export function bindPasteAttachmentListener(): void {
  document.addEventListener('paste', (e) => {
    // Only defer to rich `contenteditable` surfaces (e.g. a note editor that
    // may handle an inline image paste itself). A plain text input / textarea
    // can't accept a *file* paste, so we still hijack file pastes there — and
    // a text-only paste carries no files (handled below) and falls through to
    // the native paste regardless of focus.
    if (isContentEditableTarget(document.activeElement) || isContentEditableTarget(e.target as Element | null)) return;
    const files = extractClipboardFiles(e.clipboardData);
    if (files.length === 0) return; // no files → leave the native (text) paste alone
    e.preventDefault();
    void handlePastedFiles(files);
  });
}

/** Whether `el` is a `contenteditable` surface that owns its own paste
 *  (including inline image paste). Plain inputs / textareas are intentionally
 *  NOT treated as such — a file paste can't land in them, so paste-to-
 *  attachment should still fire when files are on the clipboard. */
function isContentEditableTarget(el: Element | null): boolean {
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Gather pasted files/images from a clipboard payload, preferring `.files`
 *  and falling back to `.items` (some browsers populate only the latter for a
 *  pasted screenshot). Exported for unit testing. */
export function extractClipboardFiles(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const out: File[] = [];
  for (const f of Array.from(data.files)) out.push(f);
  if (out.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f !== null) out.push(f);
      }
    }
  }
  return out;
}

/** Upload `files` as attachments to the selection-resolved target ticket.
 *  Exported for unit testing. Returns the ticket id the files landed on, or
 *  `null` when the paste was a no-op (2+ tickets selected). */
export async function handlePastedFiles(files: File[]): Promise<number | null> {
  if (files.length === 0) return null;

  const selectedCount = state.selectedIds.size;
  if (selectedCount > 1) {
    showToast("Pasting attachments to multiple tickets at once isn't supported", { variant: 'warning' });
    return null;
  }

  let ticketId: number;
  if (selectedCount === 1) {
    ticketId = Array.from(state.selectedIds)[0];
  } else {
    const res = await createTicket({ title: files.length > 1 ? 'Attachments' : 'Attachment' });
    ticketId = res.id;
  }

  for (const file of files) {
    await uploadAttachment(ticketId, file);
  }
  void loadTickets();
  showToast(`Attached ${String(files.length)} file${files.length === 1 ? '' : 's'}`, { variant: 'success' });
  return ticketId;
}
