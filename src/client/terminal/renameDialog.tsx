/**
 * HS-8195 — Shared rename dialog for the §22 drawer terminal tabs (called from
 * `terminal.tsx::promptRenameTerminal`) and the §25 dashboard tile rename
 * (called from `terminalDashboard.tsx::openDashboardTileRename`).
 *
 * Pre-fix both call sites had nearly-identical 60-line copies of the same
 * dialog (overlay shell, dialog header / body / footer, X / Cancel / Rename
 * buttons, Enter / Escape / backdrop dismiss). The only surface-specific bit
 * was the `apply` callback — drawer tabs update `inst.config.name` +
 * `updateTabLabel`; dashboard tiles update the `.terminal-dashboard-tile-name`
 * span directly via `data-terminal-id`. This module owns the shared chrome;
 * the surface passes its commit logic via `onApply(next)`.
 */
import { toElement } from '../dom.js';

export interface OpenRenameDialogOptions {
  /** Current value pre-filled in the input. Empty string is allowed. */
  initialValue: string;
  /** Called with the trimmed final value when the user confirms. The
   *  surface decides whether to persist, update DOM, etc. The dialog is
   *  closed by the time `onApply` returns. */
  onApply: (next: string) => void;
  /** Optional override for the dialog title (default: 'Rename Terminal'). */
  title?: string;
  /** Optional override for the input label (default: 'Tab name'). */
  label?: string;
  /** Optional override for the hint paragraph below the input (default
   *  matches the existing copy: "This rename is temporary…"). */
  hint?: string;
}

const DEFAULT_HINT = "This rename is temporary — it doesn't change saved settings and resets on reload or project switch.";

/** Mount the shared rename overlay. Returns the overlay element so callers
 *  can run assertions in tests; production callers ignore the return. */
export function openRenameDialog(opts: OpenRenameDialogOptions): HTMLElement {
  // Idempotent: tear any prior rename overlay down before mounting a fresh
  // one. Mirrors the convention used by `permissionAllowListUI::openRuleEditor`.
  document.querySelectorAll('.terminal-rename-overlay').forEach(el => el.remove());

  const title = opts.title ?? 'Rename Terminal';
  const label = opts.label ?? 'Tab name';
  const hint = opts.hint ?? DEFAULT_HINT;

  const overlay = toElement(
    <div className="cmd-editor-overlay terminal-rename-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>{title}</span>
          <button className="cmd-editor-close-btn" title="Close" type="button">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>{label}</label>
            <input type="text" className="term-rename-input" value={opts.initialValue} />
            <span className="settings-hint">{hint}</span>
          </div>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-cancel-btn" type="button">Cancel</button>
          <button className="btn btn-sm btn-primary cmd-editor-done-btn" type="button">Rename</button>
        </div>
      </div>
    </div>
  );

  const input = overlay.querySelector<HTMLInputElement>('.term-rename-input');
  if (input === null) { overlay.remove(); return overlay; }

  const cancel = (): void => { overlay.remove(); };
  const apply = (): void => {
    const next = input.value.trim();
    overlay.remove();
    opts.onApply(next);
  };

  overlay.querySelector('.cmd-editor-close-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-cancel-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-done-btn')?.addEventListener('click', apply);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  document.body.appendChild(overlay);
  input.focus();
  input.select();
  return overlay;
}
