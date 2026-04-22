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
