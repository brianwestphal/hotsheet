import { subscribeToBellState } from './bellPoll.js';
import {
  applyHideButtonBadge,
  countHiddenForProject,
  filterVisible as filterVisibleEntries,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import { showHideTerminalDialog } from './hideTerminalDialog.js';
import { shouldEscapeBypassHotsheet } from './shortcuts.js';
import {
  getActiveProject,
  getProjectGridActive,
  getProjectGridSliderValue,
  setProjectGridActive,
  setProjectGridSliderValue,
} from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import {
  computeSliderSnapPoints,
  maybeSnapSliderValue,
  ROOT_PADDING,
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

let gridEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let sizerContainer: HTMLElement | null = null;
let sizeSlider: HTMLInputElement | null = null;
let hideBtn: HTMLButtonElement | null = null;
/** HS-7826 — visibility-grouping `<select>` next to the eye icon. */
let groupingSelect: HTMLSelectElement | null = null;
/** HS-7661 — unsubscribe from hidden-terminal change events. Set when grid
 *  mode is entered, cleared on exit. */
let hiddenChangeUnsubscribe: (() => void) | null = null;
/** HS-7661 — empty-state placeholder rendered inside the grid when every
 *  terminal in the project is hidden. Kept as a separate node so we can
 *  add/remove it without disturbing other grid children. */
let allHiddenPlaceholder: HTMLElement | null = null;

let gridHandle: TileGridHandle | null = null;
let currentSnapPoints: SnapPoint[] = [];
let resizeRaf: number | null = null;
let resizeListener: (() => void) | null = null;
let drawerResizeObserver: ResizeObserver | null = null;
let bellUnsubscribe: (() => void) | null = null;

let lastKnownEntries: DrawerGridTileEntry[] = [];
let onExitGrid: () => void = () => { /* replaced in initDrawerTerminalGrid */ };

export interface GridInitOptions {
  /** Restores whatever drawer tab was active before grid mode was entered. */
  onExitGrid: () => void;
}

export function initDrawerTerminalGrid(opts: GridInitOptions): void {
  onExitGrid = opts.onExitGrid;
  // Tauri-only — per §22.11 / §36.8.
  if (getTauriInvoke() === null) return;

  gridEl = document.getElementById('drawer-terminal-grid');
  toggleBtn = document.getElementById('drawer-grid-toggle') as HTMLButtonElement | null;
  sizerContainer = document.getElementById('drawer-grid-sizer');
  sizeSlider = document.getElementById('drawer-grid-size-slider') as HTMLInputElement | null;
  hideBtn = document.getElementById('drawer-grid-hide-btn') as HTMLButtonElement | null;
  groupingSelect = document.getElementById('drawer-grid-grouping-select') as HTMLSelectElement | null;
  if (groupingSelect !== null) {
    void import('./visibilityGroupingSelect.js').then(({ wireGroupingSelectChange }) => {
      wireGroupingSelectChange({
        selectEl: groupingSelect!,
        getSecret: () => getActiveProject()?.secret ?? null,
      });
    });
  }
  if (toggleBtn === null || gridEl === null) return;

  toggleBtn.style.display = '';
  toggleBtn.addEventListener('click', () => {
    if (toggleBtn?.disabled === true) return;
    const project = getActiveProject();
    if (project === null) return;
    if (getProjectGridActive(project.secret)) exitGridModeInternal();
    else enterGridModeInternal();
  });

  // HS-7661 — Show / Hide Terminals dialog opener. Single-project mode:
  // show only the active project's terminals, no grouping.
  hideBtn?.addEventListener('click', () => {
    const project = getActiveProject();
    if (project === null) return;
    showHideTerminalDialog({
      mode: 'single-project',
      groups: [{
        secret: project.secret,
        name: project.name,
        terminals: lastKnownEntries.map(e => ({
          id: e.id,
          name: tileLabel(e),
        })),
      }],
      onChange: () => {
        // Rebuild + repaint when state mutates so the user sees the
        // dashboard reflect the toggle without closing the dialog.
        if (gridHandle !== null && getProjectGridActive(project.secret)) {
          rebuildVisibleTiles();
        }
      },
    });
  });

  sizeSlider?.addEventListener('input', () => {
    if (sizeSlider === null) return;
    const parsed = Number.parseFloat(sizeSlider.value);
    const rawValue = Number.isFinite(parsed) ? parsed : 33;
    const snapped = maybeSnapSliderValue(rawValue, currentSnapPoints);
    const project = getActiveProject();
    if (project !== null) setProjectGridSliderValue(project.secret, snapped);
    if (snapped !== rawValue) sizeSlider.value = String(snapped);
    if (gridHandle !== null) gridHandle.applySizing();
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
    if (gridHandle !== null && gridHandle.isDedicatedOpen()) {
      e.preventDefault();
      e.stopPropagation();
      gridHandle.exitDedicatedView();
      return;
    }
    if (gridHandle !== null && gridHandle.isCentered()) {
      e.preventDefault();
      e.stopPropagation();
      gridHandle.uncenterTile();
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
  lastKnownEntries = entries;
  updateToggleEnabledState();
  const project = getActiveProject();
  if (project === null) return;
  const isActive = getProjectGridActive(project.secret);
  if (!isActive) {
    // Project not in grid mode — make sure chrome is hidden + tiles disposed.
    hideGridChrome();
    if (gridHandle !== null) {
      gridHandle.dispose();
      gridHandle = null;
    }
    return;
  }
  if (gridEl === null) return;
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

/** HS-7661 — rebuild the grid handle's tiles from `lastKnownEntries`,
 *  filtered to non-hidden terminals only. When ALL terminals are hidden
 *  but there are some configured, render the "All Terminals Hidden"
 *  placeholder inside the grid container so the user can see the state
 *  reflected without empty space. The placeholder is hidden/torn down by
 *  `hideGridChrome` and recreated on every rebuild that needs it. */
function rebuildVisibleTiles(): void {
  const project = getActiveProject();
  if (project === null || gridHandle === null) return;
  const visible = filterVisibleEntries(project.secret, lastKnownEntries);
  gridHandle.rebuild(visible.map(toTileEntry(project.secret)));
  // Show / hide the all-hidden placeholder. We render it as a sibling of
  // the tiles inside `gridEl` because mountTileGrid owns the tile children
  // but doesn't touch other elements in the container.
  if (gridEl === null) return;
  if (allHiddenPlaceholder !== null) {
    allHiddenPlaceholder.remove();
    allHiddenPlaceholder = null;
  }
  if (visible.length === 0 && lastKnownEntries.length > 0) {
    allHiddenPlaceholder = document.createElement('div');
    allHiddenPlaceholder.className = 'drawer-terminal-grid-all-hidden';
    allHiddenPlaceholder.textContent = 'All Terminals Hidden';
    gridEl.appendChild(allHiddenPlaceholder);
  }
}

/** HS-7661 — subscribe to hidden-state changes so the grid rebuilds
 *  when the user toggles a row in the dialog. Idempotent.
 *  HS-7823 — also refreshes the eye-icon hidden-count badge.
 *  HS-7826 — also refreshes the grouping selector dropdown. */
function attachHiddenSubscription(): void {
  if (hiddenChangeUnsubscribe !== null) return;
  hiddenChangeUnsubscribe = subscribeToHiddenChanges(() => {
    refreshHideBtnBadge();
    refreshDrawerGroupingSelect();
    if (gridHandle !== null) rebuildVisibleTiles();
  });
}

/** HS-7826 — repaint the drawer-grid grouping selector from the active
 *  project's groupings. Called from the change subscription + on grid
 *  chrome show. Hides the select when only Default exists. */
function refreshDrawerGroupingSelect(): void {
  if (groupingSelect === null) return;
  void import('./visibilityGroupingSelect.js').then(({ refreshGroupingSelect }) => {
    refreshGroupingSelect({
      selectEl: groupingSelect!,
      getSecret: () => getActiveProject()?.secret ?? null,
    });
  });
}

/** HS-7823 — repaint the drawer-grid eye-icon badge from the active
 *  project's hidden count. Called from the hidden-change subscription
 *  + when grid chrome shows so a project switch reflects immediately. */
function refreshHideBtnBadge(): void {
  if (hideBtn === null) return;
  const project = getActiveProject();
  const count = project === null ? 0 : countHiddenForProject(project.secret);
  applyHideButtonBadge(hideBtn, count);
}

function detachHiddenSubscription(): void {
  if (hiddenChangeUnsubscribe === null) return;
  hiddenChangeUnsubscribe();
  hiddenChangeUnsubscribe = null;
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
  if (toggleBtn === null) return;
  const enabled = lastKnownEntries.length >= 2;
  toggleBtn.disabled = !enabled;
  toggleBtn.title = enabled
    ? 'Terminal grid view'
    : 'Terminal grid view (add a second terminal to enable)';
  toggleBtn.classList.toggle('active', isDrawerGridActive());
}

// -----------------------------------------------------------------------------
// Enter / exit
// -----------------------------------------------------------------------------

function enterGridModeInternal(): void {
  const project = getActiveProject();
  if (project === null || gridEl === null) return;
  if (lastKnownEntries.length < 2) return;
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
  // `lastKnownEntries` is whatever was captured by the most recent call to
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
  if (gridHandle !== null) {
    gridHandle.dispose();
    gridHandle = null;
  }
  if (allHiddenPlaceholder !== null) {
    allHiddenPlaceholder.remove();
    allHiddenPlaceholder = null;
  }
  hideGridChrome();
  detachResizeHandlers();
  detachBellSubscription();
  detachHiddenSubscription();
  updateToggleEnabledState();
  try { onExitGrid(); } catch { /* swallow — caller wiring is advisory */ }
}

function ensureGridHandle(): void {
  if (gridHandle !== null) return;
  if (gridEl === null) return;
  gridHandle = mountTileGrid({
    container: gridEl,
    cssPrefix: 'drawer-terminal-grid',
    centerSizeFrac: 0.7,
    // HS-7659 — when a tile is enlarged (centered or in dedicated view) the
    // overlay should cover the whole app, not just the narrow drawer band.
    // We use viewport-scope: the centered tile + backdrop are positioned
    // against the visual viewport (matching §25's behaviour) and the
    // dedicated overlay's CSS is `position: fixed; inset: 0` so it pops out
    // of the drawer's stacking context. The drawer panel itself stays in
    // whatever expanded state the user had set — we never touch it. The
    // bell + body-class chrome flips that earlier versions used to hide
    // the expand button + slider are gone.
    centerScope: 'viewport',
    // Pass document.body as the centerReferenceEl so the dedicated overlay
    // attaches there (rather than inside the drawer's gridEl) — combined
    // with `position: fixed` it covers the whole window cleanly. The
    // centered-tile positioning is computed against the visual viewport
    // anyway when centerScope === 'viewport', so this only affects where
    // the dedicated overlay + backdrop are mounted in the DOM.
    centerReferenceEl: document.body,
    getSliderValue: () => {
      const project = getActiveProject();
      return project === null ? 33 : getProjectGridSliderValue(project.secret);
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
  const { raw } = await import('../jsx-runtime.js');
  const { ICON_EYE_OFF } = await import('./icons.js');
  const menu = toElement(
    <div className="terminal-tile-context-menu context-menu" style={`top:${e.clientY}px;left:${e.clientX}px`}>
      {/* HS-7835 — Lucide icon prefix for the single hide action. */}
      <div className="context-menu-item">
        <span className="dropdown-icon">{raw(ICON_EYE_OFF)}</span>
        <span className="context-menu-label">Hide in Dashboard</span>
      </div>
    </div>
  );
  menu.querySelector('.context-menu-item')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    menu.remove();
    setTerminalHidden(secret, terminalId, true);
  });
  document.body.appendChild(menu);
  setTimeout(() => {
    const close = (): void => { menu.remove(); document.removeEventListener('click', close); };
    document.addEventListener('click', close);
  }, 0);
}

function showGridChrome(): void {
  if (gridEl === null) return;
  const panel = document.getElementById('command-log-panel');
  if (panel !== null) {
    for (const child of panel.querySelectorAll<HTMLElement>('.drawer-tab-content')) {
      child.style.display = 'none';
    }
  }
  gridEl.style.display = '';
  if (sizerContainer !== null) sizerContainer.style.display = '';
  if (hideBtn !== null) hideBtn.style.display = '';
  if (sizeSlider !== null) {
    const project = getActiveProject();
    sizeSlider.value = String(project === null ? 33 : getProjectGridSliderValue(project.secret));
  }
  refreshSnapPointIndicators();
  // HS-7823 — keep the eye-icon badge in sync when chrome shows (covers
  // the project-switch case where the count was for a different project).
  refreshHideBtnBadge();
  // HS-7826 — keep the grouping selector dropdown in sync (visibility
  // depends on the active project's grouping count).
  refreshDrawerGroupingSelect();
  if (toggleBtn !== null) toggleBtn.classList.add('active');
}

function hideGridChrome(): void {
  if (gridEl !== null) {
    gridEl.style.display = 'none';
    gridEl.replaceChildren();
  }
  if (sizerContainer !== null) sizerContainer.style.display = 'none';
  if (hideBtn !== null) hideBtn.style.display = 'none';
  if (groupingSelect !== null) groupingSelect.style.display = 'none';
  if (toggleBtn !== null) toggleBtn.classList.remove('active');
}

// -----------------------------------------------------------------------------
// Resize + bell
// -----------------------------------------------------------------------------

function attachResizeHandlers(): void {
  if (resizeListener !== null) return;
  resizeListener = (): void => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (gridHandle !== null) {
        gridHandle.applySizing();
        gridHandle.recenterTile();
      }
      refreshSnapPointIndicators();
    });
  };
  window.addEventListener('resize', resizeListener);
  const drawerPanel = document.getElementById('command-log-panel');
  if (drawerPanel !== null && typeof ResizeObserver !== 'undefined') {
    drawerResizeObserver = new ResizeObserver(() => {
      if (resizeListener !== null) resizeListener();
    });
    drawerResizeObserver.observe(drawerPanel);
  }
}

function detachResizeHandlers(): void {
  if (resizeListener !== null) {
    window.removeEventListener('resize', resizeListener);
    resizeListener = null;
  }
  if (drawerResizeObserver !== null) {
    drawerResizeObserver.disconnect();
    drawerResizeObserver = null;
  }
}

function attachBellSubscription(): void {
  if (bellUnsubscribe !== null) return;
  bellUnsubscribe = subscribeToBellState((state) => {
    if (gridHandle === null) return;
    const project = getActiveProject();
    if (project === null) return;
    const entry = state.get(project.secret);
    const pendingIds = new Set(entry?.terminalIds ?? []);
    gridHandle.syncBellState(pendingIds);
  });
}

function detachBellSubscription(): void {
  if (bellUnsubscribe !== null) {
    bellUnsubscribe();
    bellUnsubscribe = null;
  }
}

// -----------------------------------------------------------------------------
// Slider snap-point indicators (mirror §25 / HS-7271)
// -----------------------------------------------------------------------------

function refreshSnapPointIndicators(): void {
  if (sizerContainer === null || gridEl === null || sizeSlider === null) return;
  const rootWidth = gridEl.clientWidth - 2 * ROOT_PADDING;
  currentSnapPoints = computeSliderSnapPoints(rootWidth);

  let ticksEl = sizerContainer.querySelector<HTMLElement>('.drawer-grid-sizer-ticks');
  if (ticksEl === null) {
    ticksEl = document.createElement('div');
    ticksEl.className = 'drawer-grid-sizer-ticks';
    ticksEl.setAttribute('aria-hidden', 'true');
    sizerContainer.appendChild(ticksEl);
  }
  const sliderRect = sizeSlider.getBoundingClientRect();
  const containerRect = sizerContainer.getBoundingClientRect();
  ticksEl.style.left = `${sliderRect.left - containerRect.left}px`;
  ticksEl.style.width = `${sliderRect.width}px`;
  ticksEl.innerHTML = '';
  // HS-7950 — see the dashboard sizer's matching block for context. Same
  // thumb-width hint, same `tickLeftPx` shift to keep ticks centred under
  // the thumb at every snap value.
  const thumbWidthPx = parseFloat(getComputedStyle(sizeSlider).getPropertyValue('--range-thumb-w')) || 16;
  for (const pt of currentSnapPoints) {
    const tick = document.createElement('span');
    tick.className = 'drawer-grid-sizer-tick';
    tick.style.left = `${tickLeftPx(pt.sliderValue, sliderRect.width, thumbWidthPx)}px`;
    tick.title = `${pt.perRow} per row`;
    ticksEl.appendChild(tick);
  }
}
