/**
 * Tile-entry helpers + per-tile context menu + rename overlay extracted
 * out of `terminalDashboard.tsx` per HS-8395 (Phase 1 of the
 * terminalDashboard split — see HS-8383 / HS-8395 for the full scope).
 *
 * Everything here is pure or DOM-only. The `dashboardState` slot stays in
 * `terminalDashboard.tsx`; callers pass any cross-module side effects
 * (e.g. `refreshDashboardGrid`) as callbacks. This decoupling is the
 * pattern the rest of the HS-8395 sub-module split should follow.
 */

import { destroyTerminal } from '../api/index.js';
import { DASHBOARD_SCOPE, setTerminalHidden } from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';
import { ICON_EYE_OFF, ICON_PENCIL, ICON_X } from './icons.js';
import { openRenameDialog } from './terminal/renameDialog.js';
import type { TerminalListEntry } from './terminalDashboardState.js';
import { formatCwdLabel, getCachedHomeDir } from './terminalOsc7.js';
import { type TileEntry } from './terminalTileGrid.js';

/**
 * Build a `(terminal: TerminalListEntry) => TileEntry` mapper closed over
 * the project secret. The closure pre-resolves the cached home directory
 * so the OSC 7 cwd label can be formatted without re-fetching it per tile.
 */
export function toTileEntry(secret: string) {
  const home = getCachedHomeDir();
  return (terminal: TerminalListEntry): TileEntry => {
    const cwd = terminal.currentCwd ?? null;
    const cwdLabel = cwd !== null && cwd !== '' ? formatCwdLabel(cwd, home) : '';
    return {
      id: terminal.id,
      secret,
      label: tileLabel(terminal),
      state: terminal.state ?? 'not_spawned',
      exitCode: terminal.exitCode ?? null,
      bellPending: terminal.bellPending,
      theme: terminal.theme,
      fontFamily: terminal.fontFamily,
      fontSize: terminal.fontSize,
      cwdLabel,
      cwdRaw: cwd ?? '',
      metadata: terminal,
    };
  };
}

export function tileLabel(terminal: TerminalListEntry): string {
  if (typeof terminal.name === 'string' && terminal.name !== '') return terminal.name;
  const word = terminal.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/** HS-7661 — alias used by the hide-dialog opener so the call site reads
 *  clearly. Returns the same display label the tile shows. */
export function tileEntryLabel(terminal: TerminalListEntry): string {
  return tileLabel(terminal);
}

/**
 * Pick a CWD to pass as the new terminal's `cwd` so it opens where the user
 * is currently working in this project. HS-7277 — prefers dynamic-bucket
 * tiles (most-recent ad-hoc spawn) over configured ones (rarely-moving
 * defaults). Returns null when no tile has a server-tracked CWD yet.
 */
export function pickInheritedCwd(terminals: TerminalListEntry[]): string | null {
  const dynamics = terminals.filter(t => t.dynamic === true);
  const statics = terminals.filter(t => t.dynamic !== true);
  for (const t of [...dynamics, ...statics]) {
    const cwd = t.currentCwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Right-click context menu (HS-7065) + rename overlay
// -----------------------------------------------------------------------------

export interface OnTileContextMenuOpts {
  /** Called after the user actions one of the tile-mutating menu items
   *  (Close Terminal). The dashboard rebuilds its grid via this hook
   *  rather than the menu reaching back into the main module's
   *  `refreshDashboardGrid` directly. */
  readonly onTileMutated: () => void;
}

export function onTileContextMenu(
  entry: TileEntry,
  secret: string,
  e: MouseEvent,
  opts: OnTileContextMenuOpts,
): void {
  e.preventDefault();
  e.stopPropagation();
  dismissDashboardTileContextMenu();

  // Use the metadata we attached at toTileEntry time to recover `dynamic`.
  const meta = entry.metadata as TerminalListEntry | undefined;
  const isDynamic = meta?.dynamic === true;
  const closeDisabled = !isDynamic;

  const menu = toElement(
    <div
      className="terminal-dashboard-tile-context-menu command-log-context-menu"
      style={`left:${e.clientX}px;top:${e.clientY}px`}
    >
      {/* HS-7834 — "Close Tab" renamed to "Close Terminal" in the dashboard
          context menu (the tab metaphor lives in the drawer; the dashboard
          shows tiles, not tabs). Hide-in-Dashboard moved up next to Close
          since the two actions are related — both make the tile go away.
          HS-7835 — every item carries a Lucide icon. */}
      <div
        className={`context-menu-item${closeDisabled ? ' disabled' : ''}`}
        data-action="close"
        title={closeDisabled ? 'Configured terminals must be removed from Settings → Terminal' : undefined}
      >
        <span className="dropdown-icon">{ICON_X}</span>
        <span className="context-menu-label">Close Terminal</span>
      </div>
      {/* HS-7661 — hide this terminal from the dashboard. Session-only;
          state lives in dashboardHiddenTerminals.ts. The hidden-state
          subscription rebuilds the dashboard so the tile disappears
          immediately. */}
      <div className="context-menu-item" data-action="hide">
        <span className="dropdown-icon">{ICON_EYE_OFF}</span>
        <span className="context-menu-label">Hide in Dashboard</span>
      </div>
      <div className="context-menu-separator"></div>
      <div className="context-menu-item" data-action="rename">
        <span className="dropdown-icon">{ICON_PENCIL}</span>
        <span className="context-menu-label">Rename...</span>
      </div>
    </div>
  );

  const bind = (action: string, handler: () => void): void => {
    const el = menu.querySelector<HTMLElement>(`[data-action="${action}"]`);
    if (el === null || el.classList.contains('disabled')) return;
    el.addEventListener('click', () => {
      dismissDashboardTileContextMenu();
      handler();
    });
  };

  bind('close', () => { void closeDashboardTile(entry, secret, isDynamic, opts.onTileMutated); });
  bind('rename', () => { openDashboardTileRename(entry); });
  bind('hide', () => { setTerminalHidden(DASHBOARD_SCOPE, secret, entry.id, true); });

  document.body.appendChild(menu);
  // Clamp to viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  setTimeout(() => {
    const close = (ev: MouseEvent): void => {
      if (!menu.contains(ev.target as Node)) {
        dismissDashboardTileContextMenu();
        document.removeEventListener('click', close, true);
        document.removeEventListener('contextmenu', close, true);
      }
    };
    document.addEventListener('click', close, true);
    document.addEventListener('contextmenu', close, true);
  }, 0);
}

export function dismissDashboardTileContextMenu(): void {
  document.querySelector('.terminal-dashboard-tile-context-menu')?.remove();
}

async function closeDashboardTile(
  entry: TileEntry,
  secret: string,
  isDynamic: boolean,
  onSuccess: () => void,
): Promise<void> {
  if (!isDynamic) return;
  const meta = entry.metadata as TerminalListEntry | undefined;
  const isAlive = (meta?.state ?? 'not_spawned') === 'alive';
  if (isAlive) {
    const { confirmDialog } = await import('./confirm.js');
    const confirmed = await confirmDialog({
      title: 'Close Terminal?',
      message: `Close terminal "${entry.label}"? Its running process will be stopped.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!confirmed) return;
  }
  try {
    await destroyTerminal(entry.id, secret);
  } catch (err) {
    console.error('terminalDashboard: close terminal failed', err);
    return;
  }
  onSuccess();
}

export function openDashboardTileRename(entry: TileEntry): void {
  openRenameDialog({
    initialValue: entry.label,
    onApply: (next) => {
      const resolved = next === '' ? entry.label : next;
      // Update the tile DOM directly via data-terminal-id; cheaper than asking
      // the shared module for a rename-API and still works because
      // refreshDashboardGrid would clobber the rename anyway on next refresh.
      // HS-7662 — write to the inner `.terminal-dashboard-tile-name` span so
      // the project badge + project-name prefix (in flow mode) survive the
      // rename. Older sectioned-mode tiles without the wrapper still work
      // because the fallback overwrites the whole label.
      const labelEl = document.querySelector<HTMLElement>(
        `.terminal-dashboard-tile[data-terminal-id="${CSS.escape(entry.id)}"] .terminal-dashboard-tile-label`,
      );
      if (labelEl !== null) {
        const nameEl = labelEl.querySelector<HTMLElement>('.terminal-dashboard-tile-name');
        if (nameEl !== null) nameEl.textContent = resolved;
        else labelEl.textContent = resolved;
        labelEl.setAttribute('title', resolved);
      }
    },
  });
}
