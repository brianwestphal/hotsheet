import { overlay } from 'kerfjs/overlay';

/**
 * In-app confirm dialog. `window.confirm()` is a silent no-op in Tauri's
 * WKWebView — it returns false immediately without showing a dialog — so any
 * client flow that would have used it must go through this overlay instead.
 *
 * KERF-EVAL (feature 9) — the modal PLUMBING (append wrapper, Escape/backdrop
 * dismiss, focus trap, focus restore, teardown) is now kerf 4.2's `overlay()`
 * engine; this module only owns the app's markup + button semantics. That
 * deleted the hand-rolled keydown/backdrop/finish/focus code AND added
 * restore-focus-on-close, which the previous implementation lacked. The DOM
 * shape is unchanged (`.confirm-dialog-overlay` wrapper → `.confirm-dialog`
 * content), so the existing SCSS applies verbatim. Enter-to-confirm is wired
 * here (kerf's overlay handles Escape/Tab, not Enter).
 */

interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const title = options.title ?? 'Confirm';
  const confirmLabel = options.confirmLabel ?? 'OK';
  const cancelLabel = options.cancelLabel ?? 'Cancel';
  const confirmClass = options.danger === true
    ? 'btn btn-sm btn-danger confirm-dialog-confirm'
    : 'btn btn-sm confirm-dialog-confirm';

  const handle = overlay(
    <div className="confirm-dialog">
      <div className="confirm-dialog-header">{title}</div>
      <div className="confirm-dialog-body">{options.message}</div>
      <div className="confirm-dialog-footer">
        <button type="button" className="btn btn-sm confirm-dialog-cancel">{cancelLabel}</button>
        <button type="button" className={confirmClass}>{confirmLabel}</button>
      </div>
    </div>,
    { className: 'confirm-dialog-overlay', dismiss: ['escape', 'backdrop'], initialFocus: '.confirm-dialog-confirm' },
  );
  handle.el.setAttribute('aria-label', title);
  handle.el.querySelector('.confirm-dialog-cancel')?.addEventListener('click', () => handle.close(false));
  handle.el.querySelector('.confirm-dialog-confirm')?.addEventListener('click', () => handle.close(true));
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') { e.preventDefault(); handle.close(true); }
  };
  document.addEventListener('keydown', onKey, true);
  try {
    // Escape / backdrop resolve `undefined` (kerf user-dismissal) → false.
    return (await handle.result) === true;
  } finally {
    document.removeEventListener('keydown', onKey, true);
  }
}

/** Three-way variant of {@link confirmDialog}: a primary action, a secondary
 *  action, and a cancel/escape. The cancel path is always the SAFE one (Escape
 *  + backdrop-click + the cancel button all resolve `'cancel'`) so an accidental
 *  open never destroys data — e.g. a "Save Draft / Discard / Keep Editing"
 *  prompt (HS-9180). Enter triggers the primary. Like `confirmDialog`, this
 *  replaces native dialogs that no-op in Tauri's WKWebView, and rides kerf's
 *  `overlay()` engine (KERF-EVAL feature 9). */
export type ChoiceResult = 'primary' | 'secondary' | 'cancel';

interface ChoiceOptions {
  message: string;
  title?: string;
  primaryLabel: string;
  secondaryLabel: string;
  /** Defaults to 'Cancel'. */
  cancelLabel?: string;
  /** Style the SECONDARY button as destructive (red). */
  secondaryDanger?: boolean;
}

export async function choiceDialog(options: ChoiceOptions): Promise<ChoiceResult> {
  const title = options.title ?? 'Confirm';
  const cancelLabel = options.cancelLabel ?? 'Cancel';
  const secondaryClass = options.secondaryDanger === true
    ? 'btn btn-sm btn-danger confirm-dialog-secondary'
    : 'btn btn-sm confirm-dialog-secondary';

  const handle = overlay(
    <div className="confirm-dialog">
      <div className="confirm-dialog-header">{title}</div>
      <div className="confirm-dialog-body">{options.message}</div>
      <div className="confirm-dialog-footer">
        <button type="button" className="btn btn-sm confirm-dialog-cancel">{cancelLabel}</button>
        <button type="button" className={secondaryClass}>{options.secondaryLabel}</button>
        <button type="button" className="btn btn-sm confirm-dialog-confirm">{options.primaryLabel}</button>
      </div>
    </div>,
    { className: 'confirm-dialog-overlay', dismiss: ['escape', 'backdrop'], initialFocus: '.confirm-dialog-confirm' },
  );
  handle.el.setAttribute('aria-label', title);
  handle.el.querySelector('.confirm-dialog-cancel')?.addEventListener('click', () => handle.close('cancel'));
  handle.el.querySelector('.confirm-dialog-secondary')?.addEventListener('click', () => handle.close('secondary'));
  handle.el.querySelector('.confirm-dialog-confirm')?.addEventListener('click', () => handle.close('primary'));
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter') { e.preventDefault(); handle.close('primary'); }
  };
  document.addEventListener('keydown', onKey, true);
  try {
    // Escape / backdrop resolve `undefined` (kerf user-dismissal) → the SAFE cancel.
    const r = await handle.result;
    return r === 'primary' || r === 'secondary' ? r : 'cancel';
  } finally {
    document.removeEventListener('keydown', onKey, true);
  }
}
