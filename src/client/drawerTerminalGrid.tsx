import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import { api, apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import { toElement } from './dom.js';
import {
  getActiveProject,
  getProjectGridActive,
  getProjectGridSliderValue,
  setProjectGridActive,
  setProjectGridSliderValue,
} from './state.js';
import { getTauriInvoke, openExternalUrl } from './tauriIntegration.js';
import {
  applyAppearanceToTerm,
  getProjectDefault,
  getSessionOverride,
  resolveAppearance,
} from './terminalAppearance.js';
import {
  computeSliderSnapPoints,
  computeTileScale,
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
  maybeSnapSliderValue,
  ROOT_PADDING,
  type SnapPoint,
  TILE_ASPECT,
  tileNativeGridFromCellMetrics,
  tileWidthFromSlider,
} from './terminalDashboardSizing.js';
import { applyDedicatedHistoryFrame, replayHistoryToTerm } from './terminalReplay.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';

/**
 * Drawer terminal grid view (HS-6311, docs/36-drawer-terminal-grid.md).
 *
 * This is a project-scoped version of the global Terminal Dashboard (§25).
 * The user toggles it on via a drawer-toolbar button and the drawer body
 * switches from the per-terminal tab stack to a grid of scaled-down live
 * tiles showing every terminal in the CURRENT project only. Tiles share
 * interaction semantics with the dashboard: single-click = centered overlay,
 * double-click = dedicated full-drawer view.
 *
 * State is per-project (session-only). Entering / exiting toggles visibility
 * of the grid container + drawer panes; it does NOT destroy the normal
 * drawer-tab terminal instances — each grid tile opens its own WebSocket as
 * an additional subscriber against the existing TerminalSession.
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

interface DrawerGridTile {
  id: string;
  secret: string;
  label: string;
  state: 'alive' | 'exited' | 'not_spawned';
  exitCode: number | null;
  root: HTMLElement;
  preview: HTMLElement;
  labelEl: HTMLElement;
  term: XTerm | null;
  xtermRoot: HTMLElement | null;
  ws: WebSocket | null;
  gridPreviewWidth: number;
  gridPreviewHeight: number;
  targetCols: number;
  targetRows: number;
  /** HS-6867 — while centered, a placeholder sits in the tile's grid slot so
   *  the rest of the grid doesn't reflow. */
  slotPlaceholder: HTMLElement | null;
  /** HS-7097 — observer on `.xterm-screen` so the tile's scale re-applies on
   *  every xterm render (initial mount, post-resize, font-load reflow). */
  screenObserver: ResizeObserver | null;
  /** Original entry preserved so the dedicated view resolves appearance from
   *  the same three-layer stack (project default \> config \> session override). */
  entry: DrawerGridTileEntry;
}

interface DedicatedView {
  tile: DrawerGridTile;
  overlay: HTMLElement;
  term: XTerm;
  fit: FitAddon;
  ws: WebSocket | null;
  bodyResizeObserver: ResizeObserver | null;
  priorCenteredTile: DrawerGridTile | null;
}

const liveTiles = new Map<string, DrawerGridTile>();
let centeredTile: DrawerGridTile | null = null;
let centerBackdrop: HTMLElement | null = null;
let dedicatedView: DedicatedView | null = null;

let gridEl: HTMLElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let sizerContainer: HTMLElement | null = null;
let sizeSlider: HTMLInputElement | null = null;

let currentSnapPoints: SnapPoint[] = [];
let resizeRaf: number | null = null;
let resizeListener: (() => void) | null = null;
let drawerResizeObserver: ResizeObserver | null = null;
let bellUnsubscribe: (() => void) | null = null;

const TILE_INITIAL_COLS = DASHBOARD_FALLBACK_COLS;
const TILE_INITIAL_ROWS = DASHBOARD_FALLBACK_ROWS;
const CENTER_ANIMATION_MS = 260;
const SINGLE_CLICK_DELAY_MS = 220;
/** The centered overlay occupies this fraction of the drawer body (both axes,
 *  clamped by 4:3). 0.9 rather than the dashboard's 0.7 because the drawer is
 *  already short — a 70 % centered tile leaves too little text to read. */
const CENTER_SIZE_FRAC = 0.9;

let pendingSingleClickTimer: number | null = null;

/** Most recent list of entries passed into enterGridMode / renderGrid. Used
 *  by the toggle-button disable logic so we can re-evaluate without a
 *  server round-trip. */
let lastKnownEntries: DrawerGridTileEntry[] = [];

export interface GridInitOptions {
  /** Callback invoked when the grid wants to return to the normal drawer
   *  tabs view (user clicked the toggle off, dropped below the 2-terminal
   *  minimum, or pressed Esc on the bare grid). The terminal module owns
   *  tabs-mode UI, so we delegate the actual tab restore to it. */
  onExitGrid: () => void;
}

let onExitGrid: () => void = () => { /* replaced in initDrawerTerminalGrid */ };

/** One-time DOM setup + listeners. Safe to call before the drawer opens. */
export function initDrawerTerminalGrid(opts: GridInitOptions): void {
  onExitGrid = opts.onExitGrid;
  // Tauri-only — per §22.11 / §36.8. In a plain browser the toggle button
  // isn't revealed, so grid mode is physically unreachable.
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

  // HS-7271-style slider snap + live resize.
  sizeSlider?.addEventListener('input', () => {
    if (sizeSlider === null) return;
    const parsed = Number.parseFloat(sizeSlider.value);
    const rawValue = Number.isFinite(parsed) ? parsed : 33;
    const snapped = maybeSnapSliderValue(rawValue, currentSnapPoints);
    const project = getActiveProject();
    if (project !== null) setProjectGridSliderValue(project.secret, snapped);
    if (snapped !== rawValue) sizeSlider.value = String(snapped);
    if (gridEl !== null) applyTileSizing(gridEl);
  });

  // Esc routing — mirrors §25 dashboard's capture-phase handler, but only
  // fires while the grid is the active drawer view. Dedicated view → grid;
  // centered → grid; bare grid → exit grid mode.
  document.addEventListener('keydown', (e) => {
    const project = getActiveProject();
    if (project === null || !getProjectGridActive(project.secret)) return;
    if (e.key !== 'Escape') return;
    if (dedicatedView !== null) {
      e.preventDefault();
      e.stopPropagation();
      exitDedicatedView();
      return;
    }
    if (centeredTile !== null) {
      e.preventDefault();
      e.stopPropagation();
      uncenterTile();
      return;
    }
    // Only exit grid mode if focus is NOT inside an input — we don't want the
    // user's Esc-to-blur-field habit (HS-7393) to also drop them out of grid
    // mode. If an input is focused, Esc falls through to the global handler
    // which just blurs it.
    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl !== null && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    exitGridModeInternal();
  }, true);
}

/** Called by terminal.tsx after every `/terminal/list` load. Updates the
 *  toggle's enabled state and — if grid mode is currently active (either
 *  just entered or persisted from a prior project switch) — refreshes the
 *  tile list so new terminals appear / removed terminals disappear. Also
 *  handles re-showing the grid chrome when switching TO a project whose
 *  saved state is grid-on. */
export function onTerminalListUpdated(entries: DrawerGridTileEntry[]): void {
  lastKnownEntries = entries;
  updateToggleEnabledState();
  const project = getActiveProject();
  if (project === null) return;
  const isActive = getProjectGridActive(project.secret);
  if (!isActive) {
    // This project wants tabs mode — make sure the grid chrome is hidden.
    // No-op if already hidden; covers the project-switch case where the
    // previous project was in grid mode and the new one isn't.
    hideGridChrome();
    teardownGrid();
    return;
  }
  if (gridEl === null) return;
  // Drop to tabs automatically if the project fell below the 2-terminal
  // minimum while grid mode was active — a grid of one tile is strictly
  // worse than the tabs view, and leaving users stuck "in grid with the
  // toggle disabled" is confusing (see §36.7).
  if (entries.length < 2) {
    exitGridModeInternal();
    return;
  }
  // Full rebuild — the list response is the source of truth for which
  // terminals exist and their current state / bell / exit code.
  showGridChrome();
  attachResizeHandlers();
  attachBellSubscription();
  rebuildGrid(entries);
  updateToggleEnabledState();
}

/** True while the current project is in drawer-grid mode. */
export function isDrawerGridActive(): boolean {
  const project = getActiveProject();
  if (project === null) return false;
  return getProjectGridActive(project.secret);
}

/** Exposed so terminal.tsx can exit grid mode before activating a drawer tab
 *  (per §36.3: tab clicks auto-exit grid mode, mirroring §25.3 rule 3). */
export function exitDrawerGridMode(): void {
  if (!isDrawerGridActive()) return;
  exitGridModeInternal();
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
  // Sync pressed/active visual state with grid-mode status.
  toggleBtn.classList.toggle('active', isDrawerGridActive());
}

// -----------------------------------------------------------------------------
// Enter / exit
// -----------------------------------------------------------------------------

function enterGridModeInternal(): void {
  const project = getActiveProject();
  if (project === null || gridEl === null) return;
  if (lastKnownEntries.length < 2) return; // disabled-state guard
  setProjectGridActive(project.secret, true);
  showGridChrome();
  rebuildGrid(lastKnownEntries);
  attachResizeHandlers();
  attachBellSubscription();
  updateToggleEnabledState();
}

function exitGridModeInternal(): void {
  const project = getActiveProject();
  if (project !== null) setProjectGridActive(project.secret, false);
  teardownGrid();
  hideGridChrome();
  detachResizeHandlers();
  detachBellSubscription();
  updateToggleEnabledState();
  // Hand control back to whatever drawer tab was active before grid mode —
  // terminal.tsx owns tab-activation state, so we delegate.
  try { onExitGrid(); } catch { /* swallow — caller wiring is advisory */ }
}

function showGridChrome(): void {
  if (gridEl === null) return;
  // Hide every other drawer-tab-content panel (Commands Log + per-terminal
  // panes). The tab buttons + tab strip stay visible per §36.3.
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
      if (gridEl !== null) applyTileSizing(gridEl);
      refreshSnapPointIndicators();
      if (centeredTile !== null) recenterTile(centeredTile);
    });
  };
  window.addEventListener('resize', resizeListener);
  // Also observe the drawer panel itself — the drawer can resize without a
  // window-level resize event (user drags the top edge, or expand button
  // toggles full-drawer height). Mirrors the HS-6502 pattern in terminal.tsx.
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
    const project = getActiveProject();
    if (project === null) return;
    const entry = state.get(project.secret);
    const pendingIds = new Set(entry?.terminalIds ?? []);
    for (const tile of liveTiles.values()) {
      const want = pendingIds.has(tile.id);
      const has = tile.root.classList.contains('has-bell');
      if (want && !has) tile.root.classList.add('has-bell');
      else if (!want && has) tile.root.classList.remove('has-bell');
    }
  });
}

function detachBellSubscription(): void {
  if (bellUnsubscribe !== null) {
    bellUnsubscribe();
    bellUnsubscribe = null;
  }
}

// -----------------------------------------------------------------------------
// Grid rendering
// -----------------------------------------------------------------------------

function teardownGrid(): void {
  if (dedicatedView !== null) {
    dedicatedView.bodyResizeObserver?.disconnect();
    try { dedicatedView.ws?.close(); } catch { /* already closed */ }
    try { dedicatedView.term.dispose(); } catch { /* no-op */ }
    dedicatedView.overlay.remove();
    dedicatedView = null;
  }
  if (centeredTile !== null) {
    if (centeredTile.slotPlaceholder !== null) centeredTile.slotPlaceholder.remove();
    centeredTile.root.classList.remove('centered');
    centeredTile.root.style.transition = '';
    centeredTile.root.style.transform = '';
    centeredTile = null;
  }
  removeCenterBackdrop();
  for (const tile of liveTiles.values()) disposeTile(tile);
  liveTiles.clear();
  if (pendingSingleClickTimer !== null) {
    window.clearTimeout(pendingSingleClickTimer);
    pendingSingleClickTimer = null;
  }
}

function disposeTile(tile: DrawerGridTile): void {
  tile.screenObserver?.disconnect();
  tile.screenObserver = null;
  if (tile.ws !== null) {
    try { tile.ws.close(); } catch { /* already closed */ }
    tile.ws = null;
  }
  if (tile.term !== null) {
    try { tile.term.dispose(); } catch { /* double-dispose is fine */ }
    tile.term = null;
  }
  tile.xtermRoot = null;
}

function rebuildGrid(entries: DrawerGridTileEntry[]): void {
  if (gridEl === null) return;
  teardownGrid();
  const project = getActiveProject();
  if (project === null) return;
  gridEl.replaceChildren();
  for (const entry of entries) {
    gridEl.appendChild(renderTile(project.secret, entry));
  }
  applyTileSizing(gridEl);
}

function renderTile(secret: string, entry: DrawerGridTileEntry): HTMLElement {
  const label = tileLabel(entry);
  const state: 'alive' | 'exited' | 'not_spawned' = entry.state ?? 'not_spawned';
  const exitCode = entry.exitCode ?? null;
  const initialBell = entry.bellPending === true;
  const tileRoot = toElement(
    <div
      className={`drawer-terminal-grid-tile drawer-terminal-grid-tile-${state}${initialBell ? ' has-bell' : ''}`}
      data-terminal-id={entry.id}
    >
      <div className="drawer-terminal-grid-tile-preview">
        {renderPreviewContent(state, exitCode)}
      </div>
      <div className="drawer-terminal-grid-tile-label" title={label}>{label}</div>
    </div>
  );
  const preview = tileRoot.querySelector<HTMLElement>('.drawer-terminal-grid-tile-preview');
  const labelEl = tileRoot.querySelector<HTMLElement>('.drawer-terminal-grid-tile-label');
  if (preview === null || labelEl === null) return tileRoot;

  const tile: DrawerGridTile = {
    id: entry.id,
    secret,
    label,
    state,
    exitCode,
    root: tileRoot,
    preview,
    labelEl,
    term: null,
    xtermRoot: null,
    ws: null,
    gridPreviewWidth: 0,
    gridPreviewHeight: 0,
    targetCols: TILE_INITIAL_COLS,
    targetRows: TILE_INITIAL_ROWS,
    slotPlaceholder: null,
    screenObserver: null,
    entry,
  };
  liveTiles.set(entry.id, tile);

  if (state === 'alive') {
    mountTileXterm(tile);
    connectTileSocket(tile);
  }

  tileRoot.addEventListener('click', (e) => { onTileClick(tile, e); });
  tileRoot.addEventListener('dblclick', (e) => { onTileDblClick(tile, e); });

  return tileRoot;
}

function renderPreviewContent(state: 'alive' | 'exited' | 'not_spawned', exitCode: number | null) {
  if (state === 'alive') {
    return <div className="drawer-terminal-grid-tile-placeholder"></div>;
  }
  const status = state === 'exited'
    ? (exitCode === null ? 'Exited' : `Exited (code ${exitCode})`)
    : 'Not yet started';
  return (
    <div className="drawer-terminal-grid-tile-placeholder drawer-terminal-grid-tile-placeholder-cold">
      <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
      <span className="drawer-terminal-grid-tile-placeholder-status">{status}</span>
    </div>
  );
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
// Tile xterm mount + WebSocket
// -----------------------------------------------------------------------------

function resolveTileAppearance(tile: DrawerGridTile) {
  const configOverride: { theme?: string; fontFamily?: string; fontSize?: number } = {};
  if (tile.entry.theme !== undefined) configOverride.theme = tile.entry.theme;
  if (tile.entry.fontFamily !== undefined) configOverride.fontFamily = tile.entry.fontFamily;
  if (tile.entry.fontSize !== undefined) configOverride.fontSize = tile.entry.fontSize;
  return resolveAppearance({
    projectDefault: getProjectDefault(),
    configOverride,
    sessionOverride: getSessionOverride(tile.id),
  });
}

function mountTileXterm(tile: DrawerGridTile): void {
  const xtermRoot = document.createElement('div');
  xtermRoot.className = 'drawer-terminal-grid-tile-xterm';
  tile.preview.replaceChildren(xtermRoot);

  const appearance = resolveTileAppearance(tile);
  const themeData = getThemeById(appearance.theme) ?? getThemeById('default')!;

  const term = new XTerm({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: false,
    scrollback: 0,
    allowProposedApi: true,
    cols: TILE_INITIAL_COLS,
    rows: TILE_INITIAL_ROWS,
    theme: themeToXtermOptions(themeData),
    linkHandler: {
      activate: (_event, text) => { openExternalUrl(text); },
    },
  });
  term.open(xtermRoot);
  void applyAppearanceToTerm(term, appearance);

  tile.targetCols = term.cols;
  tile.targetRows = term.rows;

  const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  if (screen !== null) {
    const observer = new ResizeObserver(() => { reapplyTileScaleFromPreview(tile); });
    observer.observe(screen);
    tile.screenObserver = observer;
  }
  requestAnimationFrame(() => {
    if (tile.term !== null && tile.xtermRoot !== null) {
      const native = tileNativeDimsFromXterm(tile.term, tile.xtermRoot);
      if (native !== null) {
        try { tile.term.resize(native.cols, native.rows); } catch { /* xterm disposed */ }
        tile.targetCols = native.cols;
        tile.targetRows = native.rows;
      }
    }
    reapplyTileScaleFromPreview(tile);
  });

  const encoder = new TextEncoder();
  term.onData((data) => {
    if (tile.ws !== null && tile.ws.readyState === WebSocket.OPEN) {
      tile.ws.send(encoder.encode(data));
    }
  });
  term.onBell(() => { tile.root.classList.add('has-bell'); });

  tile.term = term;
  tile.xtermRoot = xtermRoot;
}

function tileNativeDimsFromXterm(term: XTerm, xtermRoot: HTMLElement): { cols: number; rows: number } | null {
  const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  if (screen === null) return null;
  if (term.cols <= 0 || term.rows <= 0) return null;
  const cellW = screen.offsetWidth / term.cols;
  const cellH = screen.offsetHeight / term.rows;
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return null;
  return tileNativeGridFromCellMetrics(cellW, cellH);
}

function connectTileSocket(tile: DrawerGridTile): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/terminal/ws`
    + `?project=${encodeURIComponent(tile.secret)}`
    + `&terminal=${encodeURIComponent(tile.id)}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  tile.ws = ws;

  ws.addEventListener('message', (ev) => {
    if (tile.term === null) return;
    const data: unknown = ev.data;
    if (data instanceof ArrayBuffer) {
      tile.term.write(new Uint8Array(data));
      return;
    }
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as { type?: string; bytes?: string; cols?: number; rows?: number };
        if (msg.type === 'history' && typeof msg.bytes === 'string'
            && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          replayHistoryToTerm(tile.term, { bytes: msg.bytes, cols: msg.cols, rows: msg.rows });
          // HS-7097 follow-up: resize the local xterm AND the server-side
          // PTY to tile-native 4:3 so a running TUI redraws to fill the tile.
          if (tile.xtermRoot !== null) {
            const native = tileNativeDimsFromXterm(tile.term, tile.xtermRoot);
            if (native !== null) {
              try { tile.term.resize(native.cols, native.rows); } catch { /* disposed */ }
              tile.targetCols = native.cols;
              tile.targetRows = native.rows;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols: native.cols, rows: native.rows }));
              }
            }
          }
        }
      } catch { /* non-JSON frame */ }
    }
  });
  ws.addEventListener('close', () => { tile.ws = null; });
  ws.addEventListener('error', () => { tile.ws = null; });
}

// -----------------------------------------------------------------------------
// Sizing + scale
// -----------------------------------------------------------------------------

function applyTileSizing(root: HTMLElement): void {
  const rootWidth = Math.max(0, root.clientWidth - ROOT_PADDING * 2);
  if (rootWidth <= 0) return;
  const project = getActiveProject();
  const sliderValue = project === null ? 33 : getProjectGridSliderValue(project.secret);
  const tileWidth = tileWidthFromSlider(sliderValue, rootWidth);
  const tileHeight = Math.round(tileWidth / TILE_ASPECT);

  for (const tile of root.querySelectorAll<HTMLElement>('.drawer-terminal-grid-tile')) {
    if (!tile.classList.contains('centered')) {
      tile.style.width = `${tileWidth}px`;
    }
    const preview = tile.querySelector<HTMLElement>('.drawer-terminal-grid-tile-preview');
    if (preview !== null && !tile.classList.contains('centered')) {
      preview.style.width = `${tileWidth}px`;
      preview.style.height = `${tileHeight}px`;
    }
    const xtermRoot = tile.querySelector<HTMLElement>('.drawer-terminal-grid-tile-xterm');
    if (xtermRoot !== null && !tile.classList.contains('centered')) {
      applyTileScale(xtermRoot, tileWidth, tileHeight);
    }
    const tid = tile.dataset.terminalId ?? '';
    const live = liveTiles.get(tid);
    if (live !== undefined) {
      live.gridPreviewWidth = tileWidth;
      live.gridPreviewHeight = tileHeight;
    }
  }
}

function reapplyTileScaleFromPreview(tile: DrawerGridTile): void {
  if (tile.xtermRoot === null) return;
  const pw = tile.preview.offsetWidth;
  const ph = tile.preview.offsetHeight;
  if (pw <= 0 || ph <= 0) return;
  applyTileScale(tile.xtermRoot, pw, ph);
}

function applyTileScale(xtermRoot: HTMLElement, tileWidth: number, tileHeight: number): void {
  xtermRoot.style.transform = '';
  xtermRoot.style.transformOrigin = 'top left';
  xtermRoot.style.width = '';
  xtermRoot.style.height = '';
  xtermRoot.style.position = '';
  xtermRoot.style.left = '';
  xtermRoot.style.top = '';

  const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  const naturalWidth = screen?.offsetWidth ?? 0;
  const naturalHeight = screen?.offsetHeight ?? 0;
  const scale = computeTileScale(tileWidth, tileHeight, naturalWidth, naturalHeight);
  if (scale === null) return;

  xtermRoot.style.position = 'absolute';
  xtermRoot.style.left = `${scale.left}px`;
  xtermRoot.style.top = `${scale.top}px`;
  xtermRoot.style.width = `${scale.width}px`;
  xtermRoot.style.height = `${scale.height}px`;
  xtermRoot.style.transform = `scale(${scale.scale})`;
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

// -----------------------------------------------------------------------------
// Click → center / dbl-click → dedicated
// -----------------------------------------------------------------------------

function onTileClick(tile: DrawerGridTile, e: MouseEvent): void {
  e.stopPropagation();
  if (pendingSingleClickTimer !== null) window.clearTimeout(pendingSingleClickTimer);
  pendingSingleClickTimer = window.setTimeout(() => {
    pendingSingleClickTimer = null;
    if (tile.state !== 'alive') {
      void spawnAndEnlarge(tile, 'center');
      return;
    }
    if (centeredTile === tile) {
      uncenterTile();
      return;
    }
    if (centeredTile !== null) uncenterTile();
    centerTile(tile);
  }, SINGLE_CLICK_DELAY_MS);
}

function onTileDblClick(tile: DrawerGridTile, e: MouseEvent): void {
  e.stopPropagation();
  e.preventDefault();
  if (pendingSingleClickTimer !== null) {
    window.clearTimeout(pendingSingleClickTimer);
    pendingSingleClickTimer = null;
  }
  if (tile.state !== 'alive') {
    void spawnAndEnlarge(tile, 'dedicated');
    return;
  }
  const prior = centeredTile === tile ? null : centeredTile;
  if (centeredTile === tile) uncenterTile();
  try { enterDedicatedView(tile, prior); }
  catch (err) { console.error('drawerTerminalGrid: enterDedicatedView failed', err); }
}

async function spawnAndEnlarge(tile: DrawerGridTile, target: 'center' | 'dedicated'): Promise<void> {
  const wasExited = tile.state === 'exited';
  tile.preview.replaceChildren(toElement(
    <div className="drawer-terminal-grid-tile-placeholder drawer-terminal-grid-tile-placeholder-starting">
      <span>Starting…</span>
    </div>
  ));
  try {
    if (wasExited) {
      await apiWithSecret('/terminal/restart', tile.secret, {
        method: 'POST',
        body: { terminalId: tile.id },
      });
    }
    tile.state = 'alive';
    tile.exitCode = null;
    tile.root.classList.remove('drawer-terminal-grid-tile-not_spawned', 'drawer-terminal-grid-tile-exited');
    tile.root.classList.add('drawer-terminal-grid-tile-alive');
    mountTileXterm(tile);
    connectTileSocket(tile);
  } catch (err) {
    console.error('drawerTerminalGrid: spawn failed', err);
    tile.preview.replaceChildren(toElement(renderPreviewContent(tile.state, tile.exitCode)));
    return;
  }
  if (target === 'center') centerTile(tile);
  else enterDedicatedView(tile, null);
}

// -----------------------------------------------------------------------------
// Centered overlay (FLIP animation, §25.7 / HS-6867)
// -----------------------------------------------------------------------------

function centerTile(tile: DrawerGridTile): void {
  if (gridEl === null) return;
  centeredTile = tile;
  clearTileBell(tile);

  const origRect = tile.root.getBoundingClientRect();
  const placeholder = createSlotPlaceholder(origRect.width, origRect.height);
  tile.slotPlaceholder = placeholder;
  tile.root.parentElement?.insertBefore(placeholder, tile.root);

  const drawerBody = gridEl;
  const bodyRect = drawerBody.getBoundingClientRect();
  const availWidth = bodyRect.width * CENTER_SIZE_FRAC;
  const availHeight = bodyRect.height * CENTER_SIZE_FRAC;
  const previewWidth = Math.min(availWidth, availHeight * TILE_ASPECT);
  const previewHeight = previewWidth / TILE_ASPECT;
  const targetLeft = bodyRect.left + (bodyRect.width - previewWidth) / 2;
  const targetTop = bodyRect.top + (bodyRect.height - previewHeight) / 2;

  tile.root.classList.add('centered');
  tile.root.style.left = `${targetLeft}px`;
  tile.root.style.top = `${targetTop}px`;
  tile.root.style.width = `${previewWidth}px`;
  tile.preview.style.width = `${previewWidth}px`;
  tile.preview.style.height = `${previewHeight}px`;
  if (tile.xtermRoot !== null) applyTileScale(tile.xtermRoot, previewWidth, previewHeight);

  mountCenterBackdrop();

  const finalRect = tile.root.getBoundingClientRect();
  if (finalRect.width > 0 && finalRect.height > 0) {
    const dx = origRect.left - finalRect.left;
    const dy = origRect.top - finalRect.top;
    const sx = origRect.width / finalRect.width;
    const sy = origRect.height / finalRect.height;
    tile.root.style.transition = 'none';
    tile.root.style.transformOrigin = 'top left';
    tile.root.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void tile.root.offsetWidth;
    tile.root.style.transition = `transform ${CENTER_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
    tile.root.style.transform = '';
  }

  queueMicrotask(() => { tile.term?.focus(); });
}

function recenterTile(tile: DrawerGridTile): void {
  if (!tile.root.classList.contains('centered') || gridEl === null) return;
  const bodyRect = gridEl.getBoundingClientRect();
  const availWidth = bodyRect.width * CENTER_SIZE_FRAC;
  const availHeight = bodyRect.height * CENTER_SIZE_FRAC;
  const previewWidth = Math.min(availWidth, availHeight * TILE_ASPECT);
  const previewHeight = previewWidth / TILE_ASPECT;
  const targetLeft = bodyRect.left + (bodyRect.width - previewWidth) / 2;
  const targetTop = bodyRect.top + (bodyRect.height - previewHeight) / 2;

  const prev = tile.root.style.transition;
  tile.root.style.transition = 'none';
  tile.root.style.left = `${targetLeft}px`;
  tile.root.style.top = `${targetTop}px`;
  tile.root.style.width = `${previewWidth}px`;
  tile.preview.style.width = `${previewWidth}px`;
  tile.preview.style.height = `${previewHeight}px`;
  if (tile.xtermRoot !== null) applyTileScale(tile.xtermRoot, previewWidth, previewHeight);
  void tile.root.offsetWidth;
  tile.root.style.transition = prev;
}

function uncenterTile(): void {
  if (centeredTile === null) return;
  const tile = centeredTile;
  const placeholder = tile.slotPlaceholder;
  centeredTile = null;
  removeCenterBackdrop();

  if (placeholder === null) { finishUncenterTile(tile, null); return; }
  const targetRect = placeholder.getBoundingClientRect();
  const currentRect = tile.root.getBoundingClientRect();
  if (currentRect.width <= 0 || currentRect.height <= 0) { finishUncenterTile(tile, placeholder); return; }

  const dx = targetRect.left - currentRect.left;
  const dy = targetRect.top - currentRect.top;
  const sx = targetRect.width / currentRect.width;
  const sy = targetRect.height / currentRect.height;
  tile.root.style.transition = `transform ${CENTER_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
  tile.root.style.transformOrigin = 'top left';
  tile.root.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;

  const onEnd = (): void => {
    tile.root.removeEventListener('transitionend', onEnd);
    finishUncenterTile(tile, placeholder);
  };
  tile.root.addEventListener('transitionend', onEnd);
  window.setTimeout(() => {
    tile.root.removeEventListener('transitionend', onEnd);
    if (tile.slotPlaceholder === placeholder) finishUncenterTile(tile, placeholder);
  }, CENTER_ANIMATION_MS + 80);
}

function finishUncenterTile(tile: DrawerGridTile, placeholder: HTMLElement | null): void {
  tile.root.classList.remove('centered');
  tile.root.style.transition = '';
  tile.root.style.transform = '';
  tile.root.style.transformOrigin = '';
  tile.root.style.left = '';
  tile.root.style.top = '';
  if (tile.gridPreviewWidth > 0) tile.root.style.width = `${tile.gridPreviewWidth}px`;
  tile.preview.style.width = `${tile.gridPreviewWidth}px`;
  tile.preview.style.height = `${tile.gridPreviewHeight}px`;
  if (tile.xtermRoot !== null && tile.gridPreviewWidth > 0 && tile.gridPreviewHeight > 0) {
    applyTileScale(tile.xtermRoot, tile.gridPreviewWidth, tile.gridPreviewHeight);
  }
  if (placeholder !== null && placeholder.parentElement !== null) {
    placeholder.parentElement.insertBefore(tile.root, placeholder);
    placeholder.remove();
  }
  tile.slotPlaceholder = null;
}

function createSlotPlaceholder(width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'drawer-terminal-grid-tile-slot';
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  return el;
}

function mountCenterBackdrop(): void {
  if (centerBackdrop !== null || gridEl === null) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'drawer-terminal-grid-center-backdrop';
  backdrop.addEventListener('click', () => { uncenterTile(); });
  // Scope the backdrop to the drawer body, not the whole document — the
  // grid mode is contained in the drawer, and a full-screen backdrop would
  // unnecessarily dim the ticket list / project tabs above.
  const panel = document.getElementById('command-log-panel');
  (panel ?? document.body).appendChild(backdrop);
  centerBackdrop = backdrop;
}

function removeCenterBackdrop(): void {
  if (centerBackdrop === null) return;
  centerBackdrop.remove();
  centerBackdrop = null;
}

function clearTileBell(tile: DrawerGridTile): void {
  if (!tile.root.classList.contains('has-bell')) return;
  tile.root.classList.remove('has-bell');
  void api('/terminal/clear-bell', {
    method: 'POST',
    body: { terminalId: tile.id },
  }).catch(() => { /* server restart / network blip — long-poll resyncs */ });
}

// -----------------------------------------------------------------------------
// Dedicated full-drawer view (§25.8 / HS-7063 / HS-7098 equivalents)
// -----------------------------------------------------------------------------

function enterDedicatedView(tile: DrawerGridTile, priorCenteredTile: DrawerGridTile | null): void {
  if (gridEl === null) return;
  if (dedicatedView !== null) exitDedicatedView();
  clearTileBell(tile);

  const overlay = toElement(
    <div className="drawer-terminal-grid-dedicated" data-terminal-id={tile.id}>
      <div className="drawer-terminal-grid-dedicated-bar">
        <button className="drawer-terminal-grid-dedicated-back" title="Back to grid">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
          <span>Back</span>
        </button>
        <div className="drawer-terminal-grid-dedicated-label">{tile.label}</div>
      </div>
      <div className="drawer-terminal-grid-dedicated-body">
        <div className="drawer-terminal-grid-dedicated-pane"></div>
      </div>
    </div>
  );
  gridEl.appendChild(overlay);

  const pane = overlay.querySelector<HTMLElement>('.drawer-terminal-grid-dedicated-pane');
  const backBtn = overlay.querySelector<HTMLElement>('.drawer-terminal-grid-dedicated-back');
  if (pane === null || backBtn === null) return;
  backBtn.addEventListener('click', () => { exitDedicatedView(); });

  const appearance = resolveTileAppearance(tile);
  const themeData = getThemeById(appearance.theme) ?? getThemeById('default')!;
  const term = new XTerm({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    theme: themeToXtermOptions(themeData),
    linkHandler: {
      activate: (_event, text) => { openExternalUrl(text); },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
  term.open(pane);
  void applyAppearanceToTerm(term, appearance);

  const runFit = (): void => { try { fit.fit(); } catch { /* not ready */ } };
  requestAnimationFrame(runFit);
  const bodyResizeObserver = new ResizeObserver(runFit);
  bodyResizeObserver.observe(pane);

  const encoder = new TextEncoder();
  term.onData((data) => {
    if (dedicatedView?.ws !== null && dedicatedView?.ws.readyState === WebSocket.OPEN) {
      dedicatedView.ws.send(encoder.encode(data));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (dedicatedView?.ws !== null && dedicatedView?.ws.readyState === WebSocket.OPEN) {
      dedicatedView.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/terminal/ws`
    + `?project=${encodeURIComponent(tile.secret)}`
    + `&terminal=${encodeURIComponent(tile.id)}`
    + `&cols=${term.cols}&rows=${term.rows}`;
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  });
  ws.addEventListener('message', (ev) => {
    const data: unknown = ev.data;
    if (data instanceof ArrayBuffer) { term.write(new Uint8Array(data)); return; }
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data) as { type?: string; bytes?: string; cols?: number; rows?: number };
        if (msg.type === 'history' && typeof msg.bytes === 'string'
            && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          applyDedicatedHistoryFrame(term, fit, { bytes: msg.bytes, cols: msg.cols, rows: msg.rows });
        }
      } catch { /* non-JSON frame */ }
    }
  });

  dedicatedView = { tile, overlay, term, fit, ws, bodyResizeObserver, priorCenteredTile };
  queueMicrotask(() => { term.focus(); });
}

function exitDedicatedView(): void {
  if (dedicatedView === null) return;
  const view = dedicatedView;
  dedicatedView = null;
  view.bodyResizeObserver?.disconnect();
  if (view.ws !== null) { try { view.ws.close(); } catch { /* closed */ } }
  try { view.term.dispose(); } catch { /* no-op */ }
  view.overlay.remove();

  // HS-7097: re-claim the tile PTY at tile-native dims so the tile shows
  // bytes formatted for its own geometry rather than the dedicated pane's.
  if (view.tile.ws !== null && view.tile.ws.readyState === WebSocket.OPEN
      && view.tile.targetCols > 0 && view.tile.targetRows > 0) {
    try {
      view.tile.ws.send(JSON.stringify({
        type: 'resize',
        cols: view.tile.targetCols,
        rows: view.tile.targetRows,
      }));
    } catch { /* ws closed */ }
  }

  if (gridEl !== null) applyTileSizing(gridEl);
  if (view.priorCenteredTile !== null) centerTile(view.priorCenteredTile);
}
