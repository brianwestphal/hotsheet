import { subscribeToBellState } from './bellPoll.js';
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
  if (toggleBtn === null || gridEl === null) return;

  toggleBtn.style.display = '';
  toggleBtn.addEventListener('click', () => {
    if (toggleBtn?.disabled === true) return;
    const project = getActiveProject();
    if (project === null) return;
    if (getProjectGridActive(project.secret)) exitGridModeInternal();
    else enterGridModeInternal();
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
  if (gridHandle !== null) gridHandle.rebuild(entries.map(toTileEntry(project.secret)));
  updateToggleEnabledState();
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
  if (gridHandle !== null) gridHandle.rebuild(lastKnownEntries.map(toTileEntry(project.secret)));
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
  hideGridChrome();
  detachResizeHandlers();
  detachBellSubscription();
  updateToggleEnabledState();
  try { onExitGrid(); } catch { /* swallow — caller wiring is advisory */ }
}

function ensureGridHandle(): void {
  if (gridHandle !== null) return;
  if (gridEl === null) return;
  gridHandle = mountTileGrid({
    container: gridEl,
    cssPrefix: 'drawer-terminal-grid',
    centerSizeFrac: 0.9,
    centerScope: 'container',
    centerReferenceEl: gridEl,
    getSliderValue: () => {
      const project = getActiveProject();
      return project === null ? 33 : getProjectGridSliderValue(project.secret);
    },
    // HS-7659 / HS-7660 — when a tile is enlarged (centered or opened in
    // dedicated view) the user expects the maximized terminal to use the
    // whole app surface, not just the drawer's narrow band. We auto-expand
    // the drawer to full height on enlarge and restore the prior expanded
    // state on shrink. The expand button + size slider hide alongside (via
    // the body.drawer-grid-tile-enlarged class) so the chrome doesn't read
    // as "you can still expand more" when we've already done it.
    onTileEnlarge: () => { void enterDrawerEnlargedState(); },
    onTileShrink: () => { void exitDrawerEnlargedState(); },
  });
}

/** Pre-enlarge expanded state, captured so we can restore it on shrink.
 *  Null when no enlargement is active. */
let priorDrawerExpandedState: boolean | null = null;

async function enterDrawerEnlargedState(): Promise<void> {
  // Save state once (the user could chain center → dedicated → exit, and we
  // want to track only the first enlarge → last shrink boundary).
  if (priorDrawerExpandedState !== null) return;
  try {
    const { isDrawerExpanded, setDrawerExpanded } = await import('./commandLog.js');
    priorDrawerExpandedState = isDrawerExpanded();
    if (!priorDrawerExpandedState) setDrawerExpanded(true);
  } catch { /* swallow — best-effort */ }
  document.body.classList.add('drawer-grid-tile-enlarged');
}

async function exitDrawerEnlargedState(): Promise<void> {
  if (priorDrawerExpandedState === null) return;
  // Defer the body-class flip until any subsequent enlarge can short-circuit
  // the import dance. The shrink callback fires both on uncenter AND on
  // exit-from-dedicated; if the user goes center → dedicated → back-to-center,
  // we shouldn't restore the drawer mid-flow. Detect a still-active enlarge
  // by checking the grid handle's reported state.
  if (gridHandle !== null && (gridHandle.isCentered() || gridHandle.isDedicatedOpen())) {
    return;
  }
  const restore = priorDrawerExpandedState;
  priorDrawerExpandedState = null;
  try {
    const { setDrawerExpanded } = await import('./commandLog.js');
    setDrawerExpanded(restore);
  } catch { /* swallow */ }
  document.body.classList.remove('drawer-grid-tile-enlarged');
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
  if (sizeSlider !== null) {
    const project = getActiveProject();
    sizeSlider.value = String(project === null ? 33 : getProjectGridSliderValue(project.secret));
  }
  refreshSnapPointIndicators();
  if (toggleBtn !== null) toggleBtn.classList.add('active');
}

function hideGridChrome(): void {
  if (gridEl !== null) {
    gridEl.style.display = 'none';
    gridEl.replaceChildren();
  }
  if (sizerContainer !== null) sizerContainer.style.display = 'none';
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
  for (const pt of currentSnapPoints) {
    const tick = document.createElement('span');
    tick.className = 'drawer-grid-sizer-tick';
    tick.style.left = `${pt.sliderValue}%`;
    tick.title = `${pt.perRow} per row`;
    ticksEl.appendChild(tick);
  }
}
