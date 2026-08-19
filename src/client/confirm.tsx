import { choice } from 'kerfjs/overlay';

/**
 * In-app confirm dialogs. `window.confirm()` / `window.prompt()` are silent
 * no-ops in Tauri's WKWebView (they return false/null immediately without
 * showing anything), so any client flow that would use them must go through
 * these overlays instead.
 *
 * KERF-EVAL (feature 9 / KF-494) — both dialogs are now kerf 4.2's high-level
 * `choice<R>()` helper (beta.4): it renders one button per action, resolves that
 * action's `value` on click or `null` on dismissal (Escape / backdrop), owns the
 * focus-trap + focus-restore, AND — via `defaultValue` — resolves a default
 * action on **Enter anywhere in the dialog** WITHOUT us holding the overlay
 * handle. That replaced the hand-rolled `overlay()` wiring: the per-button
 * `querySelector().addEventListener`, the global Enter keydown listener, and the
 * `await handle.result` result-mapping all move into kerf. The `render` slot
 * option keeps our exact markup (`.confirm-dialog-overlay` → `.confirm-dialog`),
 * so the existing SCSS applies verbatim; `choice()` supplies each button's click
 * wiring via the `actions[i]` attribute bag we spread on.
 *
 * `confirmDialog` is `choice<boolean>` (Enter → confirm); `choiceDialog` is the
 * three-way `choice<ChoiceResult>` (Enter → primary, dismissal → the SAFE cancel).
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

  const result = await choice<boolean>(
    options.message,
    [
      { value: false, label: cancelLabel },
      { value: true, label: confirmLabel },
    ],
    {
      className: 'confirm-dialog-overlay',
      defaultValue: true, // Enter anywhere confirms
      render: ({ message, actions }) => (
        <div className="confirm-dialog" aria-label={title}>
          <div className="confirm-dialog-header">{title}</div>
          <div className="confirm-dialog-body">{message}</div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm confirm-dialog-cancel" {...actions[0]}>{cancelLabel}</button>
            <button type="button" className={confirmClass} {...actions[1]}>{confirmLabel}</button>
          </div>
        </div>
      ),
    },
  );
  return result === true; // Escape / backdrop → null → false
}

/** Three-way variant of {@link confirmDialog}: a primary action, a secondary
 *  action, and a cancel/escape. The cancel path is always the SAFE one (Escape
 *  + backdrop-click + the cancel button all resolve `'cancel'`) so an accidental
 *  open never destroys data — e.g. a "Save Draft / Discard / Keep Editing"
 *  prompt (HS-9180). Enter triggers the primary. Like `confirmDialog`, this
 *  replaces native dialogs that no-op in Tauri's WKWebView, and rides kerf's
 *  `choice()` helper (KERF-EVAL feature 9 / KF-494). */
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

  const result = await choice<ChoiceResult>(
    options.message,
    [
      { value: 'cancel', label: cancelLabel },
      { value: 'secondary', label: options.secondaryLabel },
      { value: 'primary', label: options.primaryLabel },
    ],
    {
      className: 'confirm-dialog-overlay',
      defaultValue: 'primary', // Enter anywhere triggers the primary
      render: ({ message, actions }) => (
        <div className="confirm-dialog" aria-label={title}>
          <div className="confirm-dialog-header">{title}</div>
          <div className="confirm-dialog-body">{message}</div>
          <div className="confirm-dialog-footer">
            <button type="button" className="btn btn-sm confirm-dialog-cancel" {...actions[0]}>{cancelLabel}</button>
            <button type="button" className={secondaryClass} {...actions[1]}>{options.secondaryLabel}</button>
            <button type="button" className="btn btn-sm confirm-dialog-confirm" {...actions[2]}>{options.primaryLabel}</button>
          </div>
        </div>
      ),
    },
  );
  return result ?? 'cancel'; // Escape / backdrop → null → the SAFE cancel
}
