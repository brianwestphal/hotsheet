import { raw } from '../jsx-runtime.js';
import { confirmDialog } from './confirm.js';
import {
  addGroupingForProjectWithId,
  deleteGroupingForProject,
  filterVisible,
  generateGroupingIdAcrossProjects,
  getActiveGroupingId,
  getGroupings,
  isTerminalHiddenInGrouping,
  renameGroupingForProject,
  reorderGroupingsForProject,
  setActiveGroupingForProject,
  setTerminalHiddenInGrouping,
  unhideAllInGrouping,
} from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';
import { ICON_PENCIL, ICON_TRASH } from './icons.js';
import { DEFAULT_GROUPING_ID, type VisibilityGrouping } from './visibilityGroupings.js';

/**
 * HS-7661 / HS-7826 — "Show / Hide Terminals" dialog.
 *
 * Renders a list of terminals across one or more projects with a row
 * treatment that flips between visible / hidden. HS-7826 layers a tab bar
 * on top: each tab is a named *visibility grouping* with its own hiddenIds.
 *
 * Two presentation modes:
 * - `'global'` — every project's terminals grouped by project name.
 *   Used by the Terminal Dashboard's eye icon (§25). The grouping tabs
 *   apply per-project, so for global mode the dialog scopes to the
 *   project whose tab the user clicked. For now we use the FIRST group's
 *   secret as the canonical project for the grouping tabs (group order is
 *   the registered-project order).
 * - `'single-project'` — just the active project. Used by the
 *   drawer-grid's eye icon (§36).
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
  groups: HideTerminalProjectGroup[];
  onChange?: () => void;
}

let openOverlay: HTMLElement | null = null;
let openOpts: ShowDialogOptions | null = null;
let dragFromGroupingId: string | null = null;

export function showHideTerminalDialog(opts: ShowDialogOptions): void {
  closeHideTerminalDialog();
  openOpts = opts;
  const overlay = buildOverlay(opts);
  openOverlay = overlay;
  document.body.appendChild(overlay);
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

/** HS-7826 — secret used to render the grouping tab bar. The dialog reads
 *  the tab list + the active id from this project. Grouping mutations
 *  (add/rename/delete/reorder/activate) and visibility toggles fan out
 *  across every scope returned by `dialogScopes(opts)` so the per-project
 *  state stays aligned across all groups in the dialog. */
function dialogSecret(opts: ShowDialogOptions): string {
  return opts.groups[0]?.secret ?? '';
}

/** HS-7826 follow-up — the deduplicated list of project secrets the dialog
 *  operates on. In `'global'` mode this is every group's secret; in
 *  `'single-project'` mode it's just the one. Used for fan-out: a grouping
 *  created / renamed / deleted / reordered / activated in the dialog has
 *  to be applied to every per-project state, otherwise the dashboard's
 *  per-project filter (each project reads its OWN active grouping) drifts
 *  away from what the dialog displays. */
function dialogScopes(opts: ShowDialogOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const g of opts.groups) {
    if (g.secret === '' || seen.has(g.secret)) continue;
    seen.add(g.secret);
    out.push(g.secret);
  }
  return out;
}

function buildOverlay(opts: ShowDialogOptions): HTMLElement {
  const overlay = toElement(
    <div className="hide-terminal-dialog-overlay" style="z-index:2700">
      <div className="hide-terminal-dialog">
        <div className="hide-terminal-dialog-header">
          <span>{opts.mode === 'global' ? 'Show / Hide Terminals' : 'Show / Hide Terminals (this project)'}</span>
          <button className="detail-close" type="button" data-action="close" title="Close">{'×'}</button>
        </div>
        <div className="hide-terminal-dialog-tabs" data-role="tabs"></div>
        <div className="hide-terminal-dialog-body" data-role="body"></div>
        <div className="hide-terminal-dialog-footer">
          <button type="button" className="hide-terminal-show-all" data-action="show-all">Show all in this grouping</button>
        </div>
      </div>
    </div>
  );
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeHideTerminalDialog();
  });
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', () => closeHideTerminalDialog());
  overlay.querySelector('[data-action="show-all"]')?.addEventListener('click', () => {
    // HS-7826 follow-up — fan out across every dialog scope so "Show all in
    // this grouping" empties the active grouping in EVERY project, not just
    // the first one.
    const scopes = dialogScopes(opts);
    if (scopes.length === 0) return;
    const activeId = getActiveGroupingId(scopes[0]);
    for (const s of scopes) unhideAllInGrouping(s, activeId);
    rerenderBody(overlay, opts);
    if (opts.onChange) opts.onChange();
  });
  rerenderTabs(overlay, opts);
  rerenderBody(overlay, opts);
  return overlay;
}

function rerenderTabs(overlay: HTMLElement, opts: ShowDialogOptions): void {
  const tabsEl = overlay.querySelector<HTMLElement>('[data-role="tabs"]');
  if (tabsEl === null) return;
  tabsEl.replaceChildren();
  const secret = dialogSecret(opts);
  if (secret === '') return;
  const groupings = getGroupings(secret);
  const activeId = getActiveGroupingId(secret);

  // Tab strip is horizontally scrollable when contents overflow — done
  // via CSS. The trailing `+` button sits inside the same scroll container
  // so it scrolls with the tabs.
  for (const grouping of groupings) {
    tabsEl.appendChild(buildTab(overlay, opts, grouping, activeId));
  }
  tabsEl.appendChild(buildAddTabButton(overlay, opts));
}

function buildTab(
  overlay: HTMLElement,
  opts: ShowDialogOptions,
  grouping: VisibilityGrouping,
  activeId: string,
): HTMLElement {
  const isActive = grouping.id === activeId;
  const tab = toElement(
    <button
      type="button"
      className={`hide-terminal-tab${isActive ? ' is-active' : ''}`}
      data-grouping-id={grouping.id}
      draggable="true"
      title={grouping.id === DEFAULT_GROUPING_ID ? 'Default grouping (cannot be deleted)' : 'Right-click to rename or delete'}
    >
      <span className="hide-terminal-tab-label">{grouping.name}</span>
    </button>
  ) as HTMLButtonElement;
  tab.addEventListener('click', () => {
    // HS-7826 follow-up — set the active grouping in EVERY scope so the
    // dashboard's per-project filter and the dialog's view agree.
    const scopes = dialogScopes(opts);
    if (scopes.length === 0) return;
    for (const s of scopes) setActiveGroupingForProject(s, grouping.id);
    rerenderTabs(overlay, opts);
    rerenderBody(overlay, opts);
    if (opts.onChange) opts.onChange();
  });
  tab.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showTabContextMenu(overlay, opts, grouping, e);
  });
  // Drag-to-reorder. Default CAN be moved (its name is the only invariant
  // that matters; users can prefer a different ordering).
  tab.addEventListener('dragstart', (e) => {
    dragFromGroupingId = grouping.id;
    if (e.dataTransfer !== null) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', grouping.id);
    }
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragend', () => {
    dragFromGroupingId = null;
    tab.classList.remove('dragging');
    overlay.querySelectorAll('.hide-terminal-tab.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  tab.addEventListener('dragover', (e) => {
    if (dragFromGroupingId === null || dragFromGroupingId === grouping.id) return;
    e.preventDefault();
    if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'move';
    tab.classList.add('drag-over');
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
  tab.addEventListener('drop', (e) => {
    e.preventDefault();
    tab.classList.remove('drag-over');
    if (dragFromGroupingId === null || dragFromGroupingId === grouping.id) return;
    // HS-7826 follow-up — fan out the reorder so every project's grouping
    // list ends up in the same order. Skipping this drift means the
    // dashboard's dropdown order disagrees with the dialog's tab order.
    const scopes = dialogScopes(opts);
    if (scopes.length > 0) {
      for (const s of scopes) reorderGroupingsForProject(s, dragFromGroupingId, grouping.id);
      rerenderTabs(overlay, opts);
      if (opts.onChange) opts.onChange();
    }
    dragFromGroupingId = null;
  });
  return tab;
}

function buildAddTabButton(overlay: HTMLElement, opts: ShowDialogOptions): HTMLElement {
  // Lucide `plus` glyph.
  const btn = toElement(
    <button type="button" className="hide-terminal-tab-add" title="Create a new visibility grouping">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
    </button>
  ) as HTMLButtonElement;
  btn.addEventListener('click', () => {
    void promptAddGrouping(overlay, opts);
  });
  return btn;
}

async function promptAddGrouping(overlay: HTMLElement, opts: ShowDialogOptions): Promise<void> {
  const scopes = dialogScopes(opts);
  if (scopes.length === 0) return;
  const name = await promptForName('New grouping', '');
  if (name === null) return;
  // HS-7826 follow-up — generate ONE id that's safe across every scope, so
  // the same grouping ends up under the same id in every per-project state.
  // Without the shared id, switching tabs would only affect the project the
  // grouping was originally created in.
  const id = generateGroupingIdAcrossProjects(scopes);
  for (const s of scopes) addGroupingForProjectWithId(s, id, name);
  for (const s of scopes) setActiveGroupingForProject(s, id);
  rerenderTabs(overlay, opts);
  rerenderBody(overlay, opts);
  if (opts.onChange) opts.onChange();
}

function showTabContextMenu(
  overlay: HTMLElement,
  opts: ShowDialogOptions,
  grouping: VisibilityGrouping,
  e: MouseEvent,
): void {
  document.querySelectorAll('.note-context-menu, .hide-terminal-tab-menu').forEach(m => m.remove());
  const isDefault = grouping.id === DEFAULT_GROUPING_ID;
  // HS-7835 — Lucide pencil + trash glyphs.
  const menu = toElement(
    <div className="hide-terminal-tab-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px;z-index:2800`}>
      <div className="context-menu-item" data-action="rename">
        <span className="dropdown-icon">{raw(ICON_PENCIL)}</span>
        <span className="context-menu-label">Rename…</span>
      </div>
      <div className={`context-menu-item${isDefault ? ' is-disabled' : ' danger'}`} data-action="delete" data-disabled={isDefault ? 'true' : 'false'}>
        <span className="dropdown-icon">{raw(ICON_TRASH)}</span>
        <span className="context-menu-label">{isDefault ? 'Delete (Default cannot be deleted)' : 'Delete'}</span>
      </div>
    </div>
  );
  menu.querySelector('[data-action="rename"]')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.remove();
    void promptRenameGrouping(overlay, opts, grouping);
  });
  menu.querySelector('[data-action="delete"]')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (isDefault) return;
    menu.remove();
    void confirmDeleteGrouping(overlay, opts, grouping);
  });
  document.body.appendChild(menu);
  const close = (): void => { menu.remove(); document.removeEventListener('click', close); };
  setTimeout(() => document.addEventListener('click', close), 0);
}

async function promptRenameGrouping(
  overlay: HTMLElement,
  opts: ShowDialogOptions,
  grouping: VisibilityGrouping,
): Promise<void> {
  const scopes = dialogScopes(opts);
  if (scopes.length === 0) return;
  const name = await promptForName('Rename grouping', grouping.name);
  if (name === null) return;
  for (const s of scopes) renameGroupingForProject(s, grouping.id, name);
  rerenderTabs(overlay, opts);
  if (opts.onChange) opts.onChange();
}

async function confirmDeleteGrouping(
  overlay: HTMLElement,
  opts: ShowDialogOptions,
  grouping: VisibilityGrouping,
): Promise<void> {
  const scopes = dialogScopes(opts);
  if (scopes.length === 0) return;
  const ok = await confirmDialog({
    title: 'Delete grouping?',
    message: `Delete the "${grouping.name}" visibility grouping? Any hidden-state in this grouping will be lost. The Default grouping will become active.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  for (const s of scopes) deleteGroupingForProject(s, grouping.id);
  rerenderTabs(overlay, opts);
  rerenderBody(overlay, opts);
  if (opts.onChange) opts.onChange();
}

/** Tiny in-app prompt for a name string. Returns trimmed name or null when
 *  the user cancelled. Built inline to avoid pulling in a large overlay
 *  helper for a one-line input. */
function promptForName(title: string, initial: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const overlay = toElement(
      <div className="grouping-prompt-overlay" style="z-index:2900">
        <div className="grouping-prompt-dialog">
          <div className="grouping-prompt-header">{title}</div>
          <input className="grouping-prompt-input" type="text" value={initial} placeholder="Grouping name" />
          <div className="grouping-prompt-footer">
            <button type="button" className="btn btn-sm" data-action="cancel">Cancel</button>
            <button type="button" className="btn btn-sm btn-primary" data-action="ok">OK</button>
          </div>
        </div>
      </div>
    );
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); finish(null); }
      if (e.key === 'Enter') { e.preventDefault(); finish(readValue()); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', () => finish(null));
    overlay.querySelector('[data-action="ok"]')?.addEventListener('click', () => finish(readValue()));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(null); });
    document.body.appendChild(overlay);
    const input = overlay.querySelector<HTMLInputElement>('.grouping-prompt-input');
    function readValue(): string | null {
      const v = (input?.value ?? '').trim();
      return v === '' ? null : v;
    }
    input?.focus();
    input?.select();
  });
}

function rerenderBody(overlay: HTMLElement, opts: ShowDialogOptions): void {
  const body = overlay.querySelector<HTMLElement>('[data-role="body"]');
  if (body === null) return;
  body.replaceChildren();
  const dialogScope = dialogSecret(opts);
  const activeGroupingId = dialogScope !== '' ? getActiveGroupingId(dialogScope) : DEFAULT_GROUPING_ID;
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
    void visibleCount;
    for (const term of group.terminals) {
      // HS-7826 follow-up — read / write against the terminal's OWN project
      // (group.secret) under the dialog's active grouping id (which is
      // kept aligned across every scope by `dialogScopes` fan-out — see
      // promptAddGrouping / setActiveGroupingForProject calls). Pre-fix this
      // used dialogScope for every terminal, so toggling visibility on a
      // terminal in any project but the first one wrote to the wrong
      // project's state — the dashboard's per-project filter then ignored
      // the change and the dialog said "hidden" while the dashboard kept
      // showing the tile.
      const groupingSecret = group.secret;
      const isHidden = isTerminalHiddenInGrouping(groupingSecret, activeGroupingId, term.id);
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
        setTerminalHiddenInGrouping(groupingSecret, activeGroupingId, term.id,
          !isTerminalHiddenInGrouping(groupingSecret, activeGroupingId, term.id));
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
  if (openOverlay !== null && openOpts !== null) {
    rerenderTabs(openOverlay, openOpts);
    rerenderBody(openOverlay, openOpts);
  }
}
