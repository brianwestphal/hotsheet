/**
 * HS-9162 — save & restore the focused editable element + its caret/selection.
 *
 * A permission popup can appear while the user is mid-edit in a ticket field
 * (title / details / a note). Clicking the popup's Allow/Deny button blurs that
 * field, and previously the caret position was lost — annoying when editing long
 * text. The permission overlay captures the editor focus when a popup opens and
 * restores it once the popup queue empties.
 *
 * Pure of globals (the active element + the `Selection` are passed in) so it can
 * be unit-tested without a live document.
 */

export interface SavedEditorFocus {
  el: HTMLElement;
  /** input/textarea caret/selection (null for a contenteditable element). */
  start: number | null;
  end: number | null;
  /** contenteditable selection range (null for input/textarea). */
  range: Range | null;
}

/** An element whose focus + caret is worth preserving across a popup. */
export function isEditableElement(el: Element | null): el is HTMLElement {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Snapshot the focused editable element + caret. Returns `null` when nothing
 * editable is focused (so the caller does nothing on restore).
 */
export function captureEditorFocus(active: Element | null, selection: Selection | null): SavedEditorFocus | null {
  if (!isEditableElement(active)) return null;
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return { el: active, start: active.selectionStart, end: active.selectionEnd, range: null };
  }
  const range = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0).cloneRange() : null;
  return { el: active, start: null, end: null, range };
}

/**
 * Re-focus the captured element + restore its caret/selection. No-op when the
 * snapshot is `null` or the element has since left the DOM (e.g. the detail
 * panel closed while the popup was up).
 */
export function restoreEditorFocus(saved: SavedEditorFocus | null, selection: Selection | null): void {
  if (saved === null) return;
  const { el } = saved;
  if (!el.isConnected) return;
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (saved.start !== null) {
      // Some input types (email/number/…) throw on setSelectionRange — tolerate.
      try { el.setSelectionRange(saved.start, saved.end ?? saved.start); } catch { /* unsupported input type */ }
    }
  } else if (saved.range !== null && selection !== null) {
    selection.removeAllRanges();
    selection.addRange(saved.range);
  }
}
