import { subscribeToBellState } from './bellPoll.js';
import {
  applyHideButtonBadge,
  countHiddenForProject,
  filterVisible as filterVisibleEntries,
  projectScope,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import { byIdOrNull, toElement } from './dom.js';
import { showHideTerminalDialog } from './hideTerminalDialog.js';
import { shouldEscapeBypassHotsheet } from './shortcuts.js';
import {
  getActiveProject,
  getProjectGridActive,
  getProjectGridColumnCount,
  setProjectGridActive,
  setProjectGridColumnCount,
} from './state.js';
import {
  computeColumnSnapPoints,
  DEFAULT_TILES_PER_ROW,
  innerContentWidth,
  MAX_TILES_PER_ROW,
  MIN_TILES_PER_ROW,
  perRowToSliderPosition,
  sliderPositionToPerRow,
  type SnapPoint,
  tickLeftPx,
} from './terminalDashboardSizing.js';
import { mountTileGrid, type TileEntry, type TileGridHandle } from './terminalTileGrid.js';

/**
 * Drawer terminal grid view (HS-6311, docs/36-drawer-terminal-grid.md).
 *
 * Per-project tile grid mounted inside the bottom drawer. Conceptually a
 * project-scoped version of the global Terminal Dashboard (§25); the actual
 * per-tile lifecycle (mount xterm, attach WebSocket, click-to-center,
 * dedicated view, bell indicators) lives in the shared `terminalTileGrid.tsx`
 * module since HS-7595. This file owns:
 *
 * - The drawer-toolbar toggle button (`#drawer-grid-toggle`) + the size
 *   slider (`#drawer-grid-sizer`) — both Tauri-only, both wired here.
 * - The per-project session-only state (`projectGridActive` /
 *   `projectGridSliderValue` Maps in `state.tsx`).
 * - The "swap drawer body from tabs view to grid view" lifecycle — hiding
 *   every `.drawer-tab-content` and revealing `#drawer-terminal-grid`.
 * - The list-update hook called by `terminal.tsx` on every /terminal/list
 *   refresh — updates the toggle's enabled state (≥2 terminals required),
 *   auto-exits if the project drops below the minimum, and rebuilds the
 *   shared grid's tiles when grid mode is on.
 * - Esc routing while grid mode is active.
 *
 * Everything inside the tiles themselves is `mountTileGrid()`'s job.
 */

export interface DrawerGridTileEntry {
  id: string;
  name?: string;
  command: string;
  bellPending?: boolean;
  state?: 'alive' | 'exited' | 'not_spawned';
  exitCode?: number | null;
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  dynamic?: boolean;
}

/**
 * HS-8223 — bundled module-level lifecycle state, mirroring the HS-8190
 * pattern landed in `permissionOverlay.tsx` and the HS-8222 follow-up
 * applied to `terminalDashboard.tsx`. Every mutable lifecycle ref (toolbar
 * buttons, RAF + resize handles, long-poll subscriptions, the
 * cached-entries snapshot) lives in one named container so a future audit
 * can spot stale handles immediately.
 *
 * The local var is named `drawerGridState` (not `state`) to avoid
 * shadowing the imported `state` module surface — matches the precedent
 * set in HS-8190 where shadowing `./state.js` was hit and reverted.
 */
interface DrawerGridState {
  gridEl: HTMLElement | null;
  toggleBtn: HTMLButtonElement | null;
  sizerContainer: HTMLElement | null;
  sizeSlider: HTMLInputElement | null;
  hideBtn: HTMLButtonElement | null;
  /** HS-7826 — visibility-grouping `<select>` next to the eye icon. */
  groupingSelect: HTMLSelectElement | null;
  /** HS-7661 — unsubscribe from hidden-terminal change events. Set when
   *  grid mode is entered, cleared on exit. */
  hiddenChangeUnsubscribe: (() => void) | null;
  /** HS-7661 — empty-state placeholder rendered inside the grid when every
   *  terminal in the project is hidden. Kept as a separate node so we can
   *  add/remove it without disturbing other grid children. */
  allHiddenPlaceholder: HTMLElement | null;
  gridHandle: TileGridHandle | null;
  currentSnapPoints: SnapPoint[];
  resizeRaf: number | null;
  resizeListener: (() => void) | null;
  drawerResizeObserver: ResizeObserver | null;
  bellUnsubscribe: (() => void) | null;
  lastKnownEntries: DrawerGridTileEntry[];
  onExitGrid: () => void;
}

function freshDrawerGridState(): DrawerGridState {
  return {
    gridEl: null,
    toggleBtn: null,
    sizerContainer: null,
    sizeSlider: null,
    hideBtn: null,
    groupingSelect: null,
    hiddenChangeUnsubscribe: null,
    allHiddenPlaceholder: null,
    gridHandle: null,
    currentSnapPoints: [],
    resizeRaf: null,
    resizeListener: null,
    drawerResizeObserver: null,
    bellUnsubscribe: null,
    lastKnownEntries: [],
    onExitGrid: () => { /* replaced in initDrawerTerminalGrid */ },
  };
}

let drawerGridState: DrawerGridState = freshDrawerGridState();

export interface GridInitOptions {
  /** Restores whatever drawer tab was active before grid mode was entered. */
  onExitGrid: () => void;
}

export function initDrawerTerminalGrid(opts: GridInitOptions): void {
  drawerGridState.onExitGrid = opts.onExitGrid;
  // HS-8624 — terminals work in the browser too now; no Tauri gate.

  drawerGridState.gridEl = byIdOrNull('drawer-terminal-grid');
  drawerGridState.toggleBtn = byIdOrNull<HTMLButtonElement>('drawer-grid-toggle');
  drawerGridState.sizerContainer = byIdOrNull('drawer-grid-sizer');
  drawerGridState.sizeSlider = byIdOrNull<HTMLInputElement>('drawer-grid-size-slider');
  drawerGridState.hideBtn = byIdOrNull<HTMLButtonElement>('drawer-grid-hide-btn');
  drawerGridState.groupingSelect = byIdOrNull<HTMLSelectElement>('drawer-grid-grouping-select');
  if (drawerGridState.groupingSelect !== null) {
    // HS-8406 — drawer-grid select reads/writes the per-project scope so
    // each project tracks its own active grouping independent of the
    // dashboard. The scope key resolves on every read+write so a project
    // switch picks up the new secret without a re-wire.
    void import('./visibilityGroupingSelect.js').then(({ wireGroupingSelectChange }) => {
      wireGroupingSelectChange({
        selectEl: drawerGridState.groupingSelect!,
        getScopeKey: () => projectScope(getActiveProject()?.secret ?? ''),
        // HS-8589 — only show while drawer-grid mode is active (gridHandle set).
        isActive: () => drawerGridState.gridHandle !== null,
      });
    });
  }
  if (drawerGridState.toggleBtn === null || drawerGridState.gridEl === null) return;

  drawerGridState.toggleBtn.style.display = '';
  drawerGridState.toggleBtn.addEventListener('click', () => {
    if (drawerGridState.toggleBtn?.disabled === true) return;
    const project = getActiveProject();
    if (project === null) return;
    if (getProjectGridActive(project.secret)) exitGridModeInternal();
    else enterGridModeInternal();
  });

  // HS-7661 — Show / Hide Terminals dialog opener. Single-project mode:
  // show only the active project's terminals, no grouping.
  drawerGridState.hideBtn?.addEventListener('click', () => {
    const project = getActiveProject();
    if (project === null) return;
    showHideTerminalDialog({
      mode: 'single-project',
      scopeKey: projectScope(project.secret),
      groups: [{
        secret: project.secret,
        name: project.name,
        terminals: drawerGridState.lastKnownEntries.map(e => ({
          id: e.id,
          name: tileLabel(e),
        })),
      }],
      onChange: () => {
        // Rebuild + repaint when state mutates so the user sees the
        // dashboard reflect the toggle without closing the dialog.
        if (drawerGridState.gridHandle !== null && getProjectGridActive(project.secret)) {
          rebuildVisibleTiles();
        }
      },
    });
  });

  drawerGridState.sizeSlider?.addEventListener('input', () => {
    if (drawerGridState.sizeSlider === null) return;
    // HS-8176 — slider position is LTR (left=many, right=few); convert
    // to the user-facing column count via `sliderPositionToPerRow`
    // before persisting to state.
    const parsed = Number.parseInt(drawerGridState.sizeSlider.value, 10);
    const sliderPos = Number.isFinite(parsed) ? parsed : perRowToSliderPosition(DEFAULT_TILES_PER_ROW);
    const project = getActiveProject();
    if (project !== null) setProjectGridColumnCount(project.secret, sliderPositionToPerRow(sliderPos));
    if (drawerGridState.gridHandle !== null) drawerGridState.gridHandle.applySizing();
  });

  // Esc routing — dedicated view → centered → bare-grid → exit grid mode.
  document.addEventListener('keydown', (e) => {
    const project = getActiveProject();
    if (project === null || !getProjectGridActive(project.secret)) return;
    if (e.key !== 'Escape') return;
    // HS-8011 — when a terminal is focused, plain Esc must reach the
    // running program; Opt+Esc still walks dedicated → centered → exit.
    if (shouldEscapeBypassHotsheet(e.target, e.altKey)) return;
    // HS-7661 — when the hide-terminal dialog is open, let it consume the
    // Esc itself. Without this, the drawer-grid handler runs first (it's
    // registered earlier on the document) and would exit grid mode entirely
    // before the dialog has a chance to close.
    if (document.querySelector('.hide-terminal-dialog-overlay') !== null) return;
    if (drawerGridState.gridHandle !== null && drawerGridState.gridHandle.isDedicatedOpen()) {
      e.preventDefault();
      e.stopPropagation();
      drawerGridState.gridHandle.exitDedicatedView();
      return;
    }
    if (drawerGridState.gridHandle !== null && drawerGridState.gridHandle.isCentered()) {
      e.preventDefault();
      e.stopPropagation();
      drawerGridState.gridHandle.uncenterTile();
      return;
    }
    // Don't exit grid mode when an input is focused — Esc-to-blur (HS-7393)
    // shouldn't accidentally drop the user out of grid mode.
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl !== null && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    exitGridModeInternal();
  }, true);
}

export function onTerminalListUpdated(entries: DrawerGridTileEntry[]): void {
  drawerGridState.lastKnownEntries = entries;
  updateToggleEnabledState();
  const project = getActiveProject();
  if (project === null) return;
  const isActive = getProjectGridActive(project.secret);
  if (!isActive) {
    // Project not in grid mode — make sure chrome is hidden + tiles disposed.
    hideGridChrome();
    if (drawerGridState.gridHandle !== null) {
      drawerGridState.gridHandle.dispose();
      drawerGridState.gridHandle = null;
    }
    return;
  }
  if (drawerGridState.gridEl === null) return;
  if (entries.length < 2) {
    // Auto-exit if the project dropped below the 2-terminal minimum
    // mid-session — see §36.7.
    exitGridModeInternal();
    return;
  }
  showGridChrome();
  ensureGridHandle();
  attachResizeHandlers();
  attachBellSubscription();
  attachHiddenSubscription();
  rebuildVisibleTiles();
  updateToggleEnabledState();
}

/** HS-7661 — rebuild the grid handle's tiles from `drawerGridState.lastKnownEntries`,
 *  filtered to non-hidden terminals only. When ALL terminals are hidden
 *  but there are some configured, render the "All Terminals Hidden"
 *  placeholder inside the grid container so the user can see the state
 *  reflected without empty space. The placeholder is hidden/torn down by
 *  `hideGridChrome` and recreated on every rebuild that needs it. */
function rebuildVisibleTiles(): void {
  const project = getActiveProject();
  if (project === null || drawerGridState.gridHandle === null) return;
  const visible = filterVisibleEntries(projectScope(project.secret), project.secret, drawerGridState.lastKnownEntries);
  drawerGridState.gridHandle.rebuild(visible.map(toTileEntry(project.secret)));
  // Show / hide the all-hidden placeholder. We render it as a sibling of
  // the tiles inside `drawerGridState.gridEl` because mountTileGrid owns the tile children
  // but doesn't touch other elements in the container.
  if (drawerGridState.gridEl === null) return;
  if (drawerGridState.allHiddenPlaceholder !== null) {
    drawerGridState.allHiddenPlaceholder.remove();
    drawerGridState.allHiddenPlaceholder = null;
  }
  if (visible.length === 0 && drawerGridState.lastKnownEntries.length > 0) {
    drawerGridState.allHiddenPlaceholder = toElement(
      <div className="drawer-terminal-grid-all-hidden">All Terminals Hidden</div>
    );
    drawerGridState.gridEl.appendChild(drawerGridState.allHiddenPlaceholder);
  }
}

/** HS-7661 — subscribe to hidden-state changes so the grid rebuilds
 *  when the user toggles a row in the dialog. Idempotent.
 *  HS-7823 — also refreshes the eye-icon hidden-count badge.
 *  HS-7826 — also refreshes the grouping selector dropdown. */
function attachHiddenSubscription(): void {
  if (drawerGridState.hiddenChangeUnsubscribe !== null) return;
  drawerGridState.hiddenChangeUnsubscribe = subscribeToHiddenChanges(() => {
    refreshHideBtnBadge();
    refreshDrawerGroupingSelect();
    if (drawerGridState.gridHandle !== null) rebuildVisibleTiles();
  });
}

/** HS-7826 — repaint the drawer-grid grouping selector from the active
 *  project's groupings. Called from the change subscription + on grid
 *  chrome show. Hides the select when only Default exists.
 *
 *  HS-8314 — capture `selectEl` SYNCHRONOUSLY before the dynamic import
 *  resolves. Pre-fix the `drawerGridState.groupingSelect!` lookup ran
 *  inside the `.then()` callback, so a project teardown / reset that
 *  ran between the import dispatch and its resolution turned the
 *  closure target into `null` and crashed inside `refreshGroupingSelect`
 *  with "Cannot read properties of null (reading 'style')". Surfaced
 *  by the HS-8314 unit-test additions; the bug is pre-existing and
 *  could fire in production during a fast project switch. */
function refreshDrawerGroupingSelect(): void {
  const selectEl = drawerGridState.groupingSelect;
  if (selectEl === null) return;
  void import('./visibilityGroupingSelect.js').then(({ refreshGroupingSelect }) => {
    refreshGroupingSelect({ selectEl, getScopeKey: () => projectScope(getActiveProject()?.secret ?? ''), isActive: () => drawerGridState.gridHandle !== null });
  });
}

/** HS-7823 — repaint the drawer-grid eye-icon badge from the active
 *  project's hidden count. Called from the hidden-change subscription
 *  + when grid chrome shows so a project switch reflects immediately. */
function refreshHideBtnBadge(): void {
  if (drawerGridState.hideBtn === null) return;
  const project = getActiveProject();
  const count = project === null ? 0 : countHiddenForProject(projectScope(project.secret), project.secret);
  applyHideButtonBadge(drawerGridState.hideBtn, count);
}

function detachHiddenSubscription(): void {
  if (drawerGridState.hiddenChangeUnsubscribe === null) return;
  drawerGridState.hiddenChangeUnsubscribe();
  drawerGridState.hiddenChangeUnsubscribe = null;
}

export function isDrawerGridActive(): boolean {
  const project = getActiveProject();
  if (project === null) return false;
  return getProjectGridActive(project.secret);
}

export function exitDrawerGridMode(): void {
  if (!isDrawerGridActive()) return;
  exitGridModeInternal();
}

function toTileEntry(secret: string) {
  return (entry: DrawerGridTileEntry): TileEntry => ({
    id: entry.id,
    secret,
    label: tileLabel(entry),
    state: entry.state ?? 'not_spawned',
    exitCode: entry.exitCode ?? null,
    bellPending: entry.bellPending,
    theme: entry.theme,
    fontFamily: entry.fontFamily,
    fontSize: entry.fontSize,
    metadata: entry,
  });
}

function tileLabel(entry: DrawerGridTileEntry): string {
  if (typeof entry.name === 'string' && entry.name !== '') return entry.name;
  const word = entry.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

// -----------------------------------------------------------------------------
// Toggle enable state
// -----------------------------------------------------------------------------

function updateToggleEnabledState(): void {
  if (drawerGridState.toggleBtn === null) return;
  const enabled = drawerGridState.lastKnownEntries.length >= 2;
  drawerGridState.toggleBtn.disabled = !enabled;
  drawerGridState.toggleBtn.title = enabled
    ? 'Terminal grid view'
    : 'Terminal grid view (add a second terminal to enable)';
  drawerGridState.toggleBtn.classList.toggle('active', isDrawerGridActive());
}

// -----------------------------------------------------------------------------
// Enter / exit
// -----------------------------------------------------------------------------

function enterGridModeInternal(): void {
  const project = getActiveProject();
  if (project === null || drawerGridState.gridEl === null) return;
  if (drawerGridState.lastKnownEntries.length < 2) return;
  setProjectGridActive(project.secret, true);
  showGridChrome();
  ensureGridHandle();
  attachResizeHandlers();
  attachBellSubscription();
  attachHiddenSubscription();
  rebuildVisibleTiles();
  updateToggleEnabledState();
  // HS-7657: refresh the terminal list so a dynamic terminal that was
  // spawned (via tab-strip click → WS attach → server lazy-spawn) AFTER the
  // last `/terminal/list` call is reflected in the tile state. Without this,
  // `drawerGridState.lastKnownEntries` is whatever was captured by the most recent call to
  // `loadAndRenderTerminalTabs`, which doesn't fire on WS-driven lazy spawn
  // — the grid would show the dynamic as "Not yet started" even though the
  // user had been using it in the drawer's tab view. The list call refreshes
  // every tile's state via `onTerminalListUpdated` → grid rebuild.
  void refreshTerminalListForGrid();
}

/** Trigger a fresh `/terminal/list` fetch via the existing
 *  `loadAndRenderTerminalTabs` path so `onTerminalListUpdated` fires with
 *  current server state. Dynamic-import to avoid the circular dep
 *  (terminal.tsx → drawerTerminalGrid.tsx). HS-7657 fix. */
async function refreshTerminalListForGrid(): Promise<void> {
  try {
    const { loadAndRenderTerminalTabs } = await import('./terminal.js');
    await loadAndRenderTerminalTabs();
  } catch { /* swallow — best-effort refresh */ }
}

function exitGridModeInternal(): void {
  const project = getActiveProject();
  if (project !== null) setProjectGridActive(project.secret, false);
  if (drawerGridState.gridHandle !== null) {
    drawerGridState.gridHandle.dispose();
    drawerGridState.gridHandle = null;
  }
  if (drawerGridState.allHiddenPlaceholder !== null) {
    drawerGridState.allHiddenPlaceholder.remove();
    drawerGridState.allHiddenPlaceholder = null;
  }
  hideGridChrome();
  detachResizeHandlers();
  detachBellSubscription();
  detachHiddenSubscription();
  updateToggleEnabledState();
  try { drawerGridState.onExitGrid(); } catch { /* swallow — caller wiring is advisory */ }
}

function ensureGridHandle(): void {
  if (drawerGridState.gridHandle !== null) return;
  if (drawerGridState.gridEl === null) return;
  drawerGridState.gridHandle = mountTileGrid({
    container: drawerGridState.gridEl,
    cssPrefix: 'drawer-terminal-grid',
    centerSizeFrac: 0.7,
    // HS-7659 — when a tile is enlarged (centered or in dedicated view) the
    // overlay should cover the whole app, not just the narrow drawer band.
    // We use viewport-scope: the centered tile + backdrop are positioned
    // against the visual viewport (matching §25's behavior) and the
    // dedicated overlay's CSS is `position: fixed; inset: 0` so it pops out
    // of the drawer's stacking context. The drawer panel itself stays in
    // whatever expanded state the user had set — we never touch it. The
    // bell + body-class chrome flips that earlier versions used to hide
    // the expand button + slider are gone.
    centerScope: 'viewport',
    // Pass document.body as the centerReferenceEl so the dedicated overlay
    // attaches there (rather than inside the drawer's drawerGridState.gridEl) — combined
    // with `position: fixed` it covers the whole window cleanly. The
    // centered-tile positioning is computed against the visual viewport
    // anyway when centerScope === 'viewport', so this only affects where
    // the dedicated overlay + backdrop are mounted in the DOM.
    centerReferenceEl: document.body,
    getColumnCount: () => {
      const project = getActiveProject();
      return project === null ? DEFAULT_TILES_PER_ROW : getProjectGridColumnCount(project.secret);
    },
    // HS-7661 — right-click on a tile opens a small context menu with
    // "Hide in Dashboard". Click sets the terminal hidden in the
    // session-only state; the hidden-change subscription rebuilds the
    // grid so the tile disappears immediately.
    onContextMenu: (entry, e) => {
      e.preventDefault();
      const project = getActiveProject();
      if (project === null) return;
      void showHideContextMenuAtPointer(e, project.secret, entry.id);
    },
  });
}

/** HS-7661 — small context menu rendered at the pointer with one "Hide in
 *  Dashboard" entry. Clicked → flip the entry to hidden via
 *  `setTerminalHidden`. The hidden-state change-subscription will rebuild
 *  the grid so the tile disappears. Other context menus (e.g. the
 *  dashboard's HS-7065 close-tab / rename) live in their own handlers; the
 *  drawer-grid only needs the hide entry in v1. */
async function showHideContextMenuAtPointer(e: MouseEvent, secret: string, terminalId: string): Promise<void> {
  document.querySelectorAll('.terminal-tile-context-menu').forEach(m => m.remove());
  const { setTerminalHidden } = await import('./dashboardHiddenTerminals.js');
  const { toElement } = await import('./dom.js');
  const { ICON_EYE_OFF } = await import('./icons.js');
  const menu = toElement(
    <div className="terminal-tile-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
      {/* HS-7835 — Lucide icon prefix for the single hide action. */}
      <div className="context-menu-item">
        <span className="dropdown-icon">{ICON_EYE_OFF}</span>
        <span className="context-menu-label">Hide in Dashboard</span>
      </div>
    </div>
  );
  menu.querySelector('.context-menu-item')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.remove();
    setTerminalHidden(projectScope(secret), secret, terminalId, true);
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = (): void => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
}

function showGridChrome(): void {
  if (drawerGridState.gridEl === null) return;
  const panel = byIdOrNull('command-log-panel');
  if (panel !== null) {
    for (const child of panel.querySelectorAll<HTMLElement>('.drawer-tab-content')) {
      child.style.display = 'none';
    }
  }
  drawerGridState.gridEl.style.display = '';
  if (drawerGridState.sizerContainer !== null) drawerGridState.sizerContainer.style.display = '';
  if (drawerGridState.hideBtn !== null) drawerGridState.hideBtn.style.display = '';
  if (drawerGridState.sizeSlider !== null) {
    const project = getActiveProject();
    const perRow = project === null ? DEFAULT_TILES_PER_ROW : getProjectGridColumnCount(project.secret);
    drawerGridState.sizeSlider.value = String(perRowToSliderPosition(perRow));
  }
  refreshSnapPointIndicators();
  // HS-7823 — keep the eye-icon badge in sync when chrome shows (covers
  // the project-switch case where the count was for a different project).
  refreshHideBtnBadge();
  // HS-7826 — keep the grouping selector dropdown in sync (visibility
  // depends on the active project's grouping count).
  refreshDrawerGroupingSelect();
  if (drawerGridState.toggleBtn !== null) drawerGridState.toggleBtn.classList.add('active');
}

function hideGridChrome(): void {
  if (drawerGridState.gridEl !== null) {
    drawerGridState.gridEl.style.display = 'none';
    drawerGridState.gridEl.replaceChildren();
  }
  if (drawerGridState.sizerContainer !== null) drawerGridState.sizerContainer.style.display = 'none';
  if (drawerGridState.hideBtn !== null) drawerGridState.hideBtn.style.display = 'none';
  if (drawerGridState.groupingSelect !== null) drawerGridState.groupingSelect.style.display = 'none';
  if (drawerGridState.toggleBtn !== null) drawerGridState.toggleBtn.classList.remove('active');
}

// -----------------------------------------------------------------------------
// Resize + bell
// -----------------------------------------------------------------------------

function attachResizeHandlers(): void {
  if (drawerGridState.resizeListener !== null) return;
  drawerGridState.resizeListener = (): void => {
    if (drawerGridState.resizeRaf !== null) return;
    drawerGridState.resizeRaf = requestAnimationFrame(() => {
      drawerGridState.resizeRaf = null;
      if (drawerGridState.gridHandle !== null) {
        drawerGridState.gridHandle.applySizing();
        drawerGridState.gridHandle.recenterTile();
      }
      refreshSnapPointIndicators();
    });
  };
  window.addEventListener('resize', drawerGridState.resizeListener);
  const drawerPanel = byIdOrNull('command-log-panel');
  if (drawerPanel !== null && typeof ResizeObserver !== 'undefined') {
    drawerGridState.drawerResizeObserver = new ResizeObserver(() => {
      if (drawerGridState.resizeListener !== null) drawerGridState.resizeListener();
    });
    drawerGridState.drawerResizeObserver.observe(drawerPanel);
  }
}

function detachResizeHandlers(): void {
  if (drawerGridState.resizeListener !== null) {
    window.removeEventListener('resize', drawerGridState.resizeListener);
    drawerGridState.resizeListener = null;
  }
  if (drawerGridState.drawerResizeObserver !== null) {
    drawerGridState.drawerResizeObserver.disconnect();
    drawerGridState.drawerResizeObserver = null;
  }
}

function attachBellSubscription(): void {
  if (drawerGridState.bellUnsubscribe !== null) return;
  drawerGridState.bellUnsubscribe = subscribeToBellState((state) => {
    if (drawerGridState.gridHandle === null) return;
    const project = getActiveProject();
    if (project === null) return;
    const entry = state.get(project.secret);
    // HS-8285 follow-up — composite tile-key shape.
    const pendingTileKeys = new Set<string>();
    for (const id of entry?.terminalIds ?? []) pendingTileKeys.add(`${project.secret}::${id}`);
    drawerGridState.gridHandle.syncBellState(pendingTileKeys);
  });
}

function detachBellSubscription(): void {
  if (drawerGridState.bellUnsubscribe !== null) {
    drawerGridState.bellUnsubscribe();
    drawerGridState.bellUnsubscribe = null;
  }
}

// -----------------------------------------------------------------------------
// Slider snap-point indicators (mirror §25 / HS-7271)
// -----------------------------------------------------------------------------

function refreshSnapPointIndicators(): void {
  if (drawerGridState.sizerContainer === null || drawerGridState.gridEl === null || drawerGridState.sizeSlider === null) return;
  // HS-8442 — use `innerContentWidth` so the drawer grid's actual 12 px
  // padding is read live instead of subtracting the dashboard's 20 px
  // `ROOT_PADDING * 2`, which was leaving a 16 px sliver of unused space
  // on the right of every drawer-grid row.
  const rootWidth = innerContentWidth(drawerGridState.gridEl);
  drawerGridState.currentSnapPoints = computeColumnSnapPoints(rootWidth);

  let ticksEl = drawerGridState.sizerContainer.querySelector<HTMLElement>('.drawer-grid-sizer-ticks');
  if (ticksEl === null) {
    ticksEl = toElement(
      <div className="drawer-grid-sizer-ticks" aria-hidden="true"></div>
    );
    drawerGridState.sizerContainer.appendChild(ticksEl);
  }
  const sliderRect = drawerGridState.sizeSlider.getBoundingClientRect();
  const containerRect = drawerGridState.sizerContainer.getBoundingClientRect();
  ticksEl.style.left = `${sliderRect.left - containerRect.left}px`;
  ticksEl.style.width = `${sliderRect.width}px`;
  ticksEl.innerHTML = '';
  // HS-7950 — see the dashboard sizer's matching block for context. Same
  // thumb-width hint, same `tickLeftPx` shift to keep ticks centred under
  // the thumb at every snap value. HS-8176 — sliderValue is a 1..MAX
  // integer position; convert to 0..100 percentage for tickLeftPx.
  const thumbWidthPx = parseFloat(getComputedStyle(drawerGridState.sizeSlider).getPropertyValue('--range-thumb-w')) || 16;
  const sliderRange = MAX_TILES_PER_ROW - MIN_TILES_PER_ROW;
  for (const pt of drawerGridState.currentSnapPoints) {
    const pctPosition = sliderRange === 0 ? 0 : ((pt.sliderValue - MIN_TILES_PER_ROW) / sliderRange) * 100;
    ticksEl.appendChild(toElement(
      <span className="drawer-grid-sizer-tick"
            style={`left:${tickLeftPx(pctPosition, sliderRect.width, thumbWidthPx)}px;`}
            title={`${pt.perRow} per row`}></span>
    ));
  }
}

/** **TEST ONLY** — reset every module-level state slot back to its boot
 *  default so consecutive tests don't leak. Mirrors the HS-8190 convention
 *  in `permissionOverlay.tsx::_resetStateForTesting`: runs disposers BEFORE
 *  swapping in a fresh state so an in-flight RAF, ResizeObserver, or
 *  long-poll subscription doesn't leak past the swap. */
export function _resetStateForTesting(): void {
  if (drawerGridState.resizeRaf !== null) cancelAnimationFrame(drawerGridState.resizeRaf);
  if (drawerGridState.resizeListener !== null) window.removeEventListener('resize', drawerGridState.resizeListener);
  if (drawerGridState.drawerResizeObserver !== null) {
    try { drawerGridState.drawerResizeObserver.disconnect(); } catch { /* ignore */ }
  }
  if (drawerGridState.bellUnsubscribe !== null) {
    try { drawerGridState.bellUnsubscribe(); } catch { /* ignore */ }
  }
  if (drawerGridState.hiddenChangeUnsubscribe !== null) {
    try { drawerGridState.hiddenChangeUnsubscribe(); } catch { /* ignore */ }
  }
  if (drawerGridState.gridHandle !== null) {
    try { drawerGridState.gridHandle.dispose(); } catch { /* ignore */ }
  }
  drawerGridState = freshDrawerGridState();
}
