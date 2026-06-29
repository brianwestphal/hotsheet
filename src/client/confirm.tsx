import { toElement } from './dom.js';

/**
 * In-app confirm dialog. `window.confirm()` is a silent no-op in Tauri's
 * WKWebView — it returns false immediately without showing a dialog — so any
 * client flow that would have used it must go through this overlay instead.
 * The overlay also matches the app's visual style and traps keyboard input
 * (Enter → confirm, Escape → cancel).
 */

interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const title = options.title ?? 'Confirm';
    const confirmLabel = options.confirmLabel ?? 'OK';
    const cancelLabel = options.cancelLabel ?? 'Cancel';

    const confirmClass = options.danger === true
      ? 'btn btn-sm btn-danger confirm-dialog-confirm'
      : 'btn btn-sm confirm-dialog-confirm';

    const overlay = toElement(
      <div className="confirm-dialog-overlay" role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-dialog">
          <div className="confirm-dialog-header">{title}</div>
          <div className="confirm-dialog-body">{options.message}</div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm confirm-dialog-cancel">{cancelLabel}</button>
            <button type="button" className={confirmClass}>{confirmLabel}</button>
          </div>
        </div>
      </div>
    );

    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };

    overlay.querySelector('.confirm-dialog-cancel')?.addEventListener('click', () => finish(false));
    overlay.querySelector('.confirm-dialog-confirm')?.addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });

    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    (overlay.querySelector('.confirm-dialog-confirm') as HTMLButtonElement).focus();
  });
}

/** Three-way variant of {@link confirmDialog}: a primary action, a secondary
 *  action, and a cancel/escape. The cancel path is always the SAFE one (Escape
 *  + backdrop-click + the cancel button all resolve `'cancel'`) so an accidental
 *  open never destroys data — e.g. a "Save Draft / Discard / Keep Editing"
 *  prompt (HS-9180). Enter triggers the primary. Like `confirmDialog`, this
 *  replaces native dialogs that no-op in Tauri's WKWebView. */
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

export function choiceDialog(options: ChoiceOptions): Promise<ChoiceResult> {
  return new Promise((resolve) => {
    const title = options.title ?? 'Confirm';
    const cancelLabel = options.cancelLabel ?? 'Cancel';
    const secondaryClass = options.secondaryDanger === true
      ? 'btn btn-sm btn-danger confirm-dialog-secondary'
      : 'btn btn-sm confirm-dialog-secondary';

    const overlay = toElement(
      <div className="confirm-dialog-overlay" role="dialog" aria-modal="true" aria-label={title}>
        <div className="confirm-dialog">
          <div className="confirm-dialog-header">{title}</div>
          <div className="confirm-dialog-body">{options.message}</div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm confirm-dialog-cancel">{cancelLabel}</button>
            <button type="button" className={secondaryClass}>{options.secondaryLabel}</button>
            <button type="button" className="btn btn-sm confirm-dialog-confirm">{options.primaryLabel}</button>
          </div>
        </div>
      </div>
    );

    let settled = false;
    const finish = (result: ChoiceResult) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); finish('cancel'); }
      else if (e.key === 'Enter') { e.preventDefault(); finish('primary'); }
    };

    overlay.querySelector('.confirm-dialog-cancel')?.addEventListener('click', () => finish('cancel'));
    overlay.querySelector('.confirm-dialog-secondary')?.addEventListener('click', () => finish('secondary'));
    overlay.querySelector('.confirm-dialog-confirm')?.addEventListener('click', () => finish('primary'));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel'); });

    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    (overlay.querySelector('.confirm-dialog-confirm') as HTMLButtonElement).focus();
  });
}
