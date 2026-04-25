import {
  filterVisible,
  isTerminalHidden,
  setTerminalHidden,
  unhideAllEverywhere,
  unhideAllInProject,
} from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';

/**
 * HS-7661 — "Show / Hide Terminals" dialog.
 *
 * Renders a list of terminals across one or more projects with a
 * grey-when-hidden / black-when-visible row treatment. Click a row to
 * toggle visibility for that terminal. The dialog is non-modal — clicking
 * outside dismisses, Esc dismisses, and the × button dismisses.
 *
 * Two presentation modes:
 * - `'global'` — shows every project's terminals grouped by project name.
 *   Used by the global Terminal Dashboard's eye icon (§25).
 * - `'single-project'` — shows just the active project's terminals (no
 *   grouping). Used by the drawer-grid's eye icon (§36).
 *
 * Per the user's HS-7661 feedback ("1. c"), state is session-only — there's
 * no `/file-settings` plumbing here.
 */

export interface HideTerminalEntry {
  id: string;
  name: string;
}

export interface HideTerminalProjectGroup {
  secret: string;
  name: string;
  terminals: HideTerminalEntry[];
}

export interface ShowDialogOptions {
  mode: 'global' | 'single-project';
  /** All groups to render. For `single-project` mode, callers should pass
   *  exactly one group (the active project). */
  groups: HideTerminalProjectGroup[];
  /** Called after every visibility toggle so the caller can refresh its
   *  tile rendering. The dialog itself is also re-rendered in-place to
   *  reflect the new state. */
  onChange?: () => void;
}

let openOverlay: HTMLElement | null = null;
let openOpts: ShowDialogOptions | null = null;

export function showHideTerminalDialog(opts: ShowDialogOptions): void {
  closeHideTerminalDialog();
  openOpts = opts;
  const overlay = buildOverlay(opts);
  openOverlay = overlay;
  document.body.appendChild(overlay);
  // Esc / outside-click dismissal. Use stopImmediatePropagation so other
  // capture-phase Esc handlers on the document (e.g. the drawer-grid's
  // Esc-exits-grid-mode handler in §36) don't ALSO fire — without it, a
  // user pressing Esc to close this dialog would also drop them out of
  // grid mode entirely.
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      e.preventDefault();
      closeHideTerminalDialog();
    }
  };
  document.addEventListener('keydown', onKey, true);
  (overlay as HTMLElement & { _hsKeyHandler?: (e: KeyboardEvent) => void })._hsKeyHandler = onKey;
}

export function closeHideTerminalDialog(): void {
  if (openOverlay === null) return;
  const overlay = openOverlay;
  openOverlay = null;
  openOpts = null;
  const handler = (overlay as HTMLElement & { _hsKeyHandler?: (e: KeyboardEvent) => void })._hsKeyHandler;
  if (handler !== undefined) document.removeEventListener('keydown', handler, true);
  overlay.remove();
}

function buildOverlay(opts: ShowDialogOptions): HTMLElement {
  const overlay = toElement(
    <div className="hide-terminal-dialog-overlay" style="z-index:2700">
      <div className="hide-terminal-dialog">
        <div className="hide-terminal-dialog-header">
          <span>{opts.mode === 'global' ? 'Show / Hide Terminals' : 'Show / Hide Terminals (this project)'}</span>
          <button className="detail-close" type="button" data-action="close" title="Close">{'×'}</button>
        </div>
        <div className="hide-terminal-dialog-body" data-role="body"></div>
        <div className="hide-terminal-dialog-footer">
          <button type="button" className="hide-terminal-show-all" data-action="show-all">Show all</button>
        </div>
      </div>
    </div>
  );
  // Outside-click dismiss.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHideTerminalDialog();
  });
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', () => closeHideTerminalDialog());
  overlay.querySelector('[data-action="show-all"]')?.addEventListener('click', () => {
    if (opts.mode === 'global') unhideAllEverywhere();
    else if (opts.groups.length > 0) unhideAllInProject(opts.groups[0].secret);
    rerenderBody(overlay, opts);
    if (opts.onChange) opts.onChange();
  });
  rerenderBody(overlay, opts);
  return overlay;
}

function rerenderBody(overlay: HTMLElement, opts: ShowDialogOptions): void {
  const body = overlay.querySelector<HTMLElement>('[data-role="body"]');
  if (body === null) return;
  body.replaceChildren();
  if (opts.groups.every(g => g.terminals.length === 0)) {
    body.appendChild(toElement(<div className="hide-terminal-empty">No terminals registered.</div>));
    return;
  }
  for (const group of opts.groups) {
    if (group.terminals.length === 0) continue;
    if (opts.mode === 'global') {
      body.appendChild(toElement(<div className="hide-terminal-group-heading">{group.name}</div>));
    }
    const visibleCount = filterVisible(group.secret, group.terminals).length;
    void visibleCount; // (reserved for a future "N visible / M total" header — not in v1)
    for (const term of group.terminals) {
      const isHidden = isTerminalHidden(group.secret, term.id);
      const row = toElement(
        <div
          className={`hide-terminal-row${isHidden ? ' is-hidden' : ''}`}
          data-secret={group.secret}
          data-terminal-id={term.id}
          role="button"
          tabIndex={0}
        >
          <span className="hide-terminal-row-icon" aria-hidden="true">
            {isHidden
              ? <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>
              : <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>}
          </span>
          <span className="hide-terminal-row-label">{term.name}</span>
          <span className="hide-terminal-row-status">{isHidden ? 'Hidden' : 'Visible'}</span>
        </div>
      );
      const toggle = (): void => {
        setTerminalHidden(group.secret, term.id, !isTerminalHidden(group.secret, term.id));
        rerenderBody(overlay, opts);
        if (opts.onChange) opts.onChange();
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
      body.appendChild(row);
    }
  }
}

/** Re-render the open dialog's body if any. Useful for callers that mutate
 *  hidden state outside the dialog (e.g. via a context-menu "Hide in
 *  Dashboard" click). No-op when the dialog isn't open. */
export function refreshOpenHideDialog(): void {
  if (openOverlay !== null && openOpts !== null) rerenderBody(openOverlay, openOpts);
}
