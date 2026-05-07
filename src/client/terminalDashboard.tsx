import { SearchAddon } from '@xterm/addon-search';
import type { Terminal } from '@xterm/xterm';

import { raw } from '../jsx-runtime.js';
import { api, apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import {
  applyHideButtonBadge,
  countHiddenAcrossAllProjects,
  filterVisible as filterVisibleEntries,
  pruneHiddenForProject,
  setTerminalHidden,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import { restoreTicketList } from './dashboardMode.js';
import { closeDetail } from './detail.js';
import { byIdOrNull, toElement } from './dom.js';
import { showHideTerminalDialog } from './hideTerminalDialog.js';
import { ICON_EYE_OFF, ICON_PENCIL, ICON_X } from './icons.js';
import { switchProject } from './projectTabs.js';
import { shouldEscapeBypassHotsheet } from './shortcuts.js';
import type { ProjectInfo } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { openRenameDialog } from './terminal/renameDialog.js';
import { loadProjectDefaultAppearance, subscribeToDefaultAppearanceChanges } from './terminalAppearance.js';
import {
  computeColumnSnapPoints,
  DEFAULT_TILES_PER_ROW,
  MAX_TILES_PER_ROW,
  MIN_TILES_PER_ROW,
  perRowToSliderPosition,
  ROOT_PADDING,
  sliderPositionToPerRow,
  type SnapPoint,
  tickLeftPx,
} from './terminalDashboardSizing.js';
import { formatCwdLabel, getCachedHomeDir } from './terminalOsc7.js';
import { mountTerminalSearch, type TerminalSearchHandle } from './terminalSearch.js';
import { mountTileGrid, type TileEntry, type TileGridHandle } from './terminalTileGrid.js';

/**
 * Terminal Dashboard — a second top-level client view that shows every
 * configured terminal across every registered project as a grid of live
 * tiles. See docs/25-terminal-dashboard.md.
 *
 * Since HS-7595 the per-tile lifecycle (mount xterm, attach WebSocket,
 * click-to-center, dedicated view, bell indicators) lives in the shared
 * `terminalTileGrid.tsx` module. This file owns the cross-project chrome:
 *
 * - The toolbar toggle button (`#terminal-dashboard-toggle`) + the size
 *   slider (`#terminal-dashboard-sizer`).
 * - The `body.terminal-dashboard-active` body class that hides the rest of
 *   the app while the dashboard is up.
 * - The per-project `<section>` rendering (heading + `+` add-terminal
 *   button + the grid container that hosts a per-project TileGrid handle).
 * - The slider snap-point ticks.
 * - The cross-project bell long-poll subscription, fanned out to each
 *   per-project grid handle as a filtered pendingIds set.
 * - The dedicated-view search widget integration via the shared module's
 *   `onDedicatedBarMount` hook (which also hides the sizer + reveals the
 *   `#terminal-dashboard-search-slot`).
 * - Cross-section centered-tile coordination (only one tile across all
 *   project sections is centered at a time).
 * - The right-click context menu (Close Tab + Rename for dynamic
 *   terminals) and the rename overlay.
 */

const BODY_CLASS = 'terminal-dashboard-active';

export type TerminalSessionState = 'alive' | 'exited' | 'not_spawned';

export interface TerminalListEntry {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  lazy?: boolean;
  bellPending?: boolean;
  state?: TerminalSessionState;
  exitCode?: number | null;
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  /** HS-7278 — server-tracked OSC 7 CWD; rendered as a tile-level chip below
   *  the label so cold tiles still show where the shell was working. */
  currentCwd?: string | null;
  /** HS-7065 — true for dynamic terminals (created ad-hoc), false for
   *  configured terminals from settings.json. Decides Close-Tab availability
   *  in the right-click context menu. */
  dynamic?: boolean;
}

export interface ProjectSectionData {
  project: ProjectInfo;
  terminals: TerminalListEntry[];
}

/** Per-project grid handle map keyed by project secret. Each section that has
 *  ≥1 terminal gets one TileGrid mount; cross-section operations (recenter on
 *  resize, syncBellState, rebuild on list refresh) walk this map. */
const gridHandles = new Map<string, TileGridHandle>();

const SLIDER_PERSIST_DEBOUNCE_MS = 250;

/** HS-7662 — layout mode for the dashboard grid. `'sectioned'` renders one
 *  `<section>` per project (the default §25.4 behaviour); `'flow'` renders
 *  every project's terminals as a single flat grid in registered-project
 *  order, with project-color badges to mark project boundaries. Persisted
 *  to `/file-settings` under `dashboard_layout_mode`. Default `'sectioned'`. */
type LayoutMode = 'sectioned' | 'flow';

/**
 * HS-8222 — bundled module-level lifecycle state, mirroring the HS-8190
 * pattern landed in `permissionOverlay.tsx`. The toolbar buttons, async
 * load promises, debounce handles, cross-handle centered-tile pointer,
 * and active-state flag all live here in a single named container so a
 * future audit can spot stale handles immediately.
 *
 * The local var is named `dashboardState` (not `state`) to avoid shadowing
 * the imported `state` module surface should one ever be added — matches
 * the precedent set in HS-8190 where shadowing `./state.js` was hit and
 * reverted.
 */
interface DashboardState {
  /** Cross-section centered-tile coordination: which handle currently has
   *  a centered tile? When the user clicks a tile in section B while
   *  section A has one centered, we uncenter A first via `onTileEnlarge`. */
  centeredHandle: TileGridHandle | null;
  /** Search widget mounted in the app-header `#terminal-dashboard-search-slot`
   *  while a dedicated view is open. Disposed via the `onDedicatedBarMount`
   *  return-value disposer pattern. */
  dedicatedSearchHandle: TerminalSearchHandle | null;
  active: boolean;
  toggleButton: HTMLButtonElement | null;
  rootElement: HTMLElement | null;
  resizeHandler: (() => void) | null;
  resizeRaf: number | null;
  bellUnsubscribe: (() => void) | null;
  appearanceUnsubscribe: (() => void) | null;
  sizerContainer: HTMLElement | null;
  sizeSlider: HTMLInputElement | null;
  currentSnapPoints: SnapPoint[];
  /** HS-7661 — Show / Hide Terminals dialog opener for the global dashboard. */
  hideButton: HTMLButtonElement | null;
  /** HS-7826 — visibility-grouping `<select>` next to the eye icon. */
  groupingSelect: HTMLSelectElement | null;
  /** HS-7661 — last-fetched per-project section data, retained so the
   *  hide-state subscription can re-render without re-fetching `/projects`
   *  + per-project `/terminal/list` round-trips. */
  lastSectionData: ProjectSectionData[];
  /** HS-7661 — unsubscribe from hidden-state changes. Set on
   *  `enterDashboard`, cleared on `exitDashboard`. */
  hiddenChangeUnsubscribe: (() => void) | null;
  /** Module-level column count persists across enter / exit calls. HS-8176
   *  default = `DEFAULT_TILES_PER_ROW` (4). Hydrated from `/file-settings`
   *  (`dashboard_columns_per_row`) on app boot and persisted (debounced)
   *  on every input change. Legacy `dashboard_slider_value` (0..100) is
   *  migrated on read by `legacySliderValueToColumnCount`. */
  columnCount: number;
  sliderValueLoadPromise: Promise<void> | null;
  sliderPersistTimeout: ReturnType<typeof setTimeout> | null;
  /** HS-7662 — current layout mode. */
  layoutMode: LayoutMode;
  layoutToggleButton: HTMLButtonElement | null;
  /** HS-7662 — cached layoutMode load promise, awaited inside
   *  `renderDashboardGrid` so the first paint always reflects the
   *  persisted mode. */
  layoutModeLoadPromise: Promise<void> | null;
}

function freshDashboardState(): DashboardState {
  return {
    centeredHandle: null,
    dedicatedSearchHandle: null,
    active: false,
    toggleButton: null,
    rootElement: null,
    resizeHandler: null,
    resizeRaf: null,
    bellUnsubscribe: null,
    appearanceUnsubscribe: null,
    sizerContainer: null,
    sizeSlider: null,
    currentSnapPoints: [],
    hideButton: null,
    groupingSelect: null,
    lastSectionData: [],
    hiddenChangeUnsubscribe: null,
    columnCount: DEFAULT_TILES_PER_ROW,
    sliderValueLoadPromise: null,
    sliderPersistTimeout: null,
    layoutMode: 'sectioned',
    layoutToggleButton: null,
    layoutModeLoadPromise: null,
  };
}

let dashboardState: DashboardState = freshDashboardState();

function refreshDashboardGroupingSelect(): void {
  if (dashboardState.groupingSelect === null) return;
  void import('./visibilityGroupingSelect.js').then(({ refreshGroupingSelect }) => {
    refreshGroupingSelect({ selectEl: dashboardState.groupingSelect! });
  });
}

function bindGroupingSelect(): void {
  if (dashboardState.groupingSelect === null) return;
  // HS-7826 → HS-8290 — wire the grouping selector. Post-HS-8290 the
  // groupings are global, so a single read + write covers every project.
  void import('./visibilityGroupingSelect.js').then(({ wireGroupingSelectChange }) => {
    wireGroupingSelectChange({ selectEl: dashboardState.groupingSelect! });
  });
}

function bindSizeSliderInput(): void {
  dashboardState.sizeSlider?.addEventListener('input', () => {
    if (dashboardState.sizeSlider === null) return;
    // HS-8176 — slider value is the LTR position (1=leftmost,
    // MAX=rightmost). The user's mental model is left=many small,
    // right=one big, so the column count is the inverse.
    const parsed = Number.parseInt(dashboardState.sizeSlider.value, 10);
    const sliderPos = Number.isFinite(parsed) ? parsed : perRowToSliderPosition(DEFAULT_TILES_PER_ROW);
    dashboardState.columnCount = sliderPositionToPerRow(sliderPos);
    if (dashboardState.active) applyAllSizing();
    schedulePersistSliderValue();
  });
}

function handleDashboardEscape(e: KeyboardEvent): void {
  if (!dashboardState.active) return;
  if (e.key !== 'Escape') return;
  // HS-8011 — when a terminal is focused, plain Esc must reach the running
  // program; Opt+Esc still exits dedicated → centered → dashboard.
  if (shouldEscapeBypassHotsheet(e.target, e.altKey)) return;
  // HS-7661 — let the hide-terminal dialog consume Esc when open.
  if (document.querySelector('.hide-terminal-dialog-overlay') !== null) return;
  // Dedicated view active in any handle?
  for (const handle of gridHandles.values()) {
    if (handle.isDedicatedOpen()) {
      // HS-7526 — if focus is in the search input, blur it instead of
      // exiting; after blurring, focus the dedicated xterm so a SECOND Esc
      // lands on the terminal-side keypress target and exits the view
      // normally. See docs/25-terminal-dashboard.md §25.8.
      const activeEl = document.activeElement as HTMLElement | null;
      const searchSlot = byIdOrNull('terminal-dashboard-search-slot');
      const inSearch = activeEl !== null && searchSlot !== null && searchSlot.contains(activeEl)
        && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA');
      if (inSearch) {
        e.preventDefault();
        e.stopPropagation();
        activeEl.blur();
        handle.focusDedicatedTerm();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      handle.exitDedicatedView();
      return;
    }
  }
  if (dashboardState.centeredHandle !== null) {
    e.preventDefault();
    e.stopPropagation();
    dashboardState.centeredHandle.uncenterTile();
    return;
  }
  e.preventDefault();
  exitDashboard();
}

export function initTerminalDashboard(): void {
  if (getTauriInvoke() === null) return;

  dashboardState.toggleButton = byIdOrNull<HTMLButtonElement>('terminal-dashboard-toggle');
  dashboardState.rootElement = byIdOrNull('terminal-dashboard-root');
  if (dashboardState.toggleButton === null || dashboardState.rootElement === null) return;

  dashboardState.toggleButton.style.display = '';
  dashboardState.toggleButton.addEventListener('click', () => {
    if (dashboardState.active) exitDashboard();
    else enterDashboard();
  });

  dashboardState.sizerContainer = byIdOrNull('terminal-dashboard-sizer');
  dashboardState.sizeSlider = byIdOrNull<HTMLInputElement>('terminal-dashboard-size-slider');
  dashboardState.hideButton = byIdOrNull<HTMLButtonElement>('terminal-dashboard-hide-btn');
  dashboardState.groupingSelect = byIdOrNull<HTMLSelectElement>('terminal-dashboard-grouping-select');
  dashboardState.layoutToggleButton = byIdOrNull<HTMLButtonElement>('terminal-dashboard-layout-toggle');

  bindGroupingSelect();
  // HS-7662 + HS-7948 — fire-and-forget eagerly load persisted layout mode +
  // slider value so the first dashboard open paints with restored state and
  // no flicker. The fetches share /file-settings caching with other on-load
  // callers.
  void loadLayoutMode();
  void loadSliderValue();
  dashboardState.layoutToggleButton?.addEventListener('click', () => {
    setLayoutMode(dashboardState.layoutMode === 'sectioned' ? 'flow' : 'sectioned');
  });
  // HS-7661 — open the "Show / Hide Terminals" dialog in global mode (every
  // project grouped). State changes fire the hidden-changes subscription
  // (registered on `enterDashboard`) which re-runs `applyHiddenFiltering`
  // so tiles disappear / reappear without a fetch round-trip.
  dashboardState.hideButton?.addEventListener('click', () => {
    showHideTerminalDialog({
      mode: 'global',
      groups: dashboardState.lastSectionData.map(s => ({
        secret: s.project.secret,
        name: s.project.name,
        terminals: s.terminals.map(t => ({ id: t.id, name: tileEntryLabel(t) })),
      })),
    });
  });
  bindSizeSliderInput();

  // Esc routing: dedicated → centered → bare-grid → exit. Capture phase so
  // we beat xterm's helper-textarea Escape handler.
  document.addEventListener('keydown', handleDashboardEscape, true);
}

export function isDashboardActive(): boolean {
  return dashboardState.active;
}

export function exitDashboard(): void {
  if (!dashboardState.active) return;
  dashboardState.active = false;
  document.body.classList.remove(BODY_CLASS);
  teardownAllHandles();
  if (dashboardState.rootElement !== null) {
    dashboardState.rootElement.style.display = 'none';
    dashboardState.rootElement.replaceChildren();
  }
  if (dashboardState.toggleButton !== null) dashboardState.toggleButton.classList.remove('active');
  if (dashboardState.sizerContainer !== null) dashboardState.sizerContainer.style.display = 'none';
  if (dashboardState.hideButton !== null) dashboardState.hideButton.style.display = 'none';
  if (dashboardState.groupingSelect !== null) dashboardState.groupingSelect.style.display = 'none';
  if (dashboardState.layoutToggleButton !== null) dashboardState.layoutToggleButton.style.display = 'none';
  if (dashboardState.hiddenChangeUnsubscribe !== null) {
    dashboardState.hiddenChangeUnsubscribe();
    dashboardState.hiddenChangeUnsubscribe = null;
  }
  if (dashboardState.resizeHandler !== null) {
    window.removeEventListener('resize', dashboardState.resizeHandler);
    dashboardState.resizeHandler = null;
  }
  if (dashboardState.bellUnsubscribe !== null) {
    dashboardState.bellUnsubscribe();
    dashboardState.bellUnsubscribe = null;
  }
  if (dashboardState.appearanceUnsubscribe !== null) {
    dashboardState.appearanceUnsubscribe();
    dashboardState.appearanceUnsubscribe = null;
  }
  // HS-7592 — re-claim the drawer terminal's PTY at drawer dims after the
  // dashboard's dedicated view may have resized it.
  void import('./terminal.js').then(({ resyncActiveTerminalPtySize }) => {
    resyncActiveTerminalPtySize();
  });
}

// -----------------------------------------------------------------------------
// Layout mode (HS-7662)
// -----------------------------------------------------------------------------

/** Coerces an arbitrary settings value to a valid LayoutMode, defaulting to
 *  `'sectioned'` when missing or unrecognized. */
function parseLayoutMode(raw: unknown): LayoutMode {
  return raw === 'flow' ? 'flow' : 'sectioned';
}

/** HS-7662 → HS-8290 — load the persisted layout mode from
 *  `/global-config` once and cache the resulting promise.
 *  Resolves silently on error so the dashboard still works when the
 *  endpoint is briefly unavailable. Pre-HS-8290 this read from
 *  `/file-settings.dashboard_layout_mode`; the key moved to global config
 *  because the dashboard is inherently cross-project. */
function loadLayoutMode(): Promise<void> {
  if (dashboardState.layoutModeLoadPromise !== null) return dashboardState.layoutModeLoadPromise;
  dashboardState.layoutModeLoadPromise = (async () => {
    try {
      const cfg = await api<{ dashboard?: { layoutMode?: string } }>('/global-config');
      dashboardState.layoutMode = parseLayoutMode(cfg.dashboard?.layoutMode);
    } catch {
      dashboardState.layoutMode = 'sectioned';
    }
    applyLayoutToggleVisualState();
  })();
  return dashboardState.layoutModeLoadPromise;
}

/** HS-7948 / HS-8176 / HS-8290 — pure: parse a value from
 *  `dashboard.columnsPerRow` (integer 1..10) into the column count. Returns
 *  `null` for any malformed input. Pre-HS-8290 this also handled the
 *  legacy `dashboard_slider_value` 0..100 shape; that key was never
 *  promoted to global config (per user direction "delete old data
 *  automatically") so the legacy fallback was removed. Exported for unit
 *  testing — DOM- and fetch-free. */
export function parsePersistedColumnCount(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  const parsed = typeof raw === 'number' ? raw : (typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN);
  if (Number.isFinite(parsed) && parsed >= MIN_TILES_PER_ROW && parsed <= MAX_TILES_PER_ROW) {
    return Math.round(parsed);
  }
  return null;
}

/** HS-7948 / HS-8176 / HS-8290 — load the persisted column count from
 *  `/global-config` once and cache the resulting promise. */
function loadSliderValue(): Promise<void> {
  if (dashboardState.sliderValueLoadPromise !== null) return dashboardState.sliderValueLoadPromise;
  dashboardState.sliderValueLoadPromise = (async () => {
    try {
      const cfg = await api<{ dashboard?: { columnsPerRow?: number } }>('/global-config');
      const parsed = parsePersistedColumnCount(cfg.dashboard?.columnsPerRow);
      if (parsed !== null) {
        dashboardState.columnCount = parsed;
        if (dashboardState.sizeSlider !== null) dashboardState.sizeSlider.value = String(perRowToSliderPosition(dashboardState.columnCount));
        if (dashboardState.active) applyAllSizing();
      }
    } catch {
      // Keep the default — silent failure matches `loadLayoutMode`.
    }
  })();
  return dashboardState.sliderValueLoadPromise;
}

/** HS-7948 / HS-8176 / HS-8290 — debounced persistence of the column count
 *  to global config under `dashboard.columnsPerRow`. */
function schedulePersistSliderValue(): void {
  if (dashboardState.sliderPersistTimeout !== null) clearTimeout(dashboardState.sliderPersistTimeout);
  dashboardState.sliderPersistTimeout = setTimeout(() => {
    dashboardState.sliderPersistTimeout = null;
    void api('/global-config', {
      method: 'PATCH',
      body: { dashboard: { columnsPerRow: dashboardState.columnCount } },
    }).catch(() => { /* swallow — UI already reflects the new value */ });
  }, SLIDER_PERSIST_DEBOUNCE_MS);
}

/** HS-7662 / HS-8290 — flip the layout mode and persist to global config. */
function setLayoutMode(next: LayoutMode): void {
  if (next === dashboardState.layoutMode) return;
  dashboardState.layoutMode = next;
  applyLayoutToggleVisualState();
  // Persist in the background — don't block the re-render on the network.
  void api('/global-config', {
    method: 'PATCH',
    body: { dashboard: { layoutMode: next } },
  }).catch(() => { /* swallow — UI flip already happened */ });
  // Re-render with the cached section data when active so we don't
  // re-fetch /projects + /terminal/list on every toggle.
  if (dashboardState.active && dashboardState.rootElement !== null && dashboardState.lastSectionData.length > 0) {
    paintDashboardSections(dashboardState.rootElement, dashboardState.lastSectionData);
  }
}

function applyLayoutToggleVisualState(): void {
  if (dashboardState.layoutToggleButton === null) return;
  dashboardState.layoutToggleButton.classList.toggle('active', dashboardState.layoutMode === 'flow');
  dashboardState.layoutToggleButton.title = dashboardState.layoutMode === 'flow'
    ? 'Switch to sectioned layout'
    : 'Switch to flow layout';
}

function teardownAllHandles(): void {
  for (const handle of gridHandles.values()) handle.dispose();
  gridHandles.clear();
  dashboardState.centeredHandle = null;
  // Clear search slot if dedicated view was open at exit time.
  if (dashboardState.dedicatedSearchHandle !== null) {
    try { dashboardState.dedicatedSearchHandle.dispose(); } catch { /* ignore */ }
    dashboardState.dedicatedSearchHandle = null;
  }
  const searchSlot = byIdOrNull('terminal-dashboard-search-slot');
  if (searchSlot !== null) {
    searchSlot.replaceChildren();
    searchSlot.style.display = 'none';
  }
}

function enterDashboard(): void {
  if (dashboardState.active) return;
  restoreTicketList();
  closeDetail();
  dashboardState.active = true;
  document.body.classList.add(BODY_CLASS);
  if (dashboardState.toggleButton !== null) dashboardState.toggleButton.classList.add('active');
  if (dashboardState.sizerContainer !== null) dashboardState.sizerContainer.style.display = '';
  if (dashboardState.hideButton !== null) dashboardState.hideButton.style.display = '';
  if (dashboardState.layoutToggleButton !== null) dashboardState.layoutToggleButton.style.display = '';
  applyLayoutToggleVisualState();
  if (dashboardState.sizeSlider !== null) dashboardState.sizeSlider.value = String(perRowToSliderPosition(dashboardState.columnCount));
  if (dashboardState.rootElement !== null) {
    dashboardState.rootElement.style.display = '';
    void renderDashboardGrid(dashboardState.rootElement);
  }
  dashboardState.resizeHandler = (): void => {
    if (dashboardState.resizeRaf !== null) return;
    dashboardState.resizeRaf = requestAnimationFrame(() => {
      dashboardState.resizeRaf = null;
      applyAllSizing();
      refreshSnapPointIndicators();
      // Re-center any centered tile against the new viewport.
      for (const handle of gridHandles.values()) handle.recenterTile();
    });
  };
  window.addEventListener('resize', dashboardState.resizeHandler);
  refreshSnapPointIndicators();

  // Cross-project bell long-poll subscription — forward filtered pending sets
  // to each per-project grid handle. Tiles whose terminalId is in the set
  // gain `.has-bell` (bounce + outline); others have it cleared. The
  // FLOW_HANDLE_KEY sentinel (HS-7662) gets the union of every project's
  // pending bells since flow mode renders one handle for every project's
  // tiles in a single grid.
  dashboardState.bellUnsubscribe = subscribeToBellState((state) => {
    // HS-8285 follow-up — `syncBellState` now keys on composite
    // `${secret}::${id}` so two projects sharing a terminal id (e.g.
    // `default`) don't cross-light each other's tiles in flow mode. Build
    // the per-handle pending set with secret-scoped keys.
    for (const [secret, handle] of gridHandles.entries()) {
      if (secret === FLOW_HANDLE_KEY) {
        const allPending = new Set<string>();
        for (const [projectSecret, entry] of state.entries()) {
          for (const id of entry.terminalIds) allPending.add(`${projectSecret}::${id}`);
        }
        handle.syncBellState(allPending);
        continue;
      }
      const entry = state.get(secret);
      const pendingTileKeys = new Set<string>();
      for (const id of entry?.terminalIds ?? []) pendingTileKeys.add(`${secret}::${id}`);
      handle.syncBellState(pendingTileKeys);
    }
  });

  // HS-6307 — re-render every tile when the project default appearance
  // changes. The shared module re-resolves appearance on next mount; for
  // already-mounted tiles we'd need a re-resolve hook on the handle. Simplest
  // is to dispose + rebuild the handle's tiles, which preserves the user's
  // centered / dedicated state because `rebuild` resets that anyway and the
  // user is changing project-default appearance from the Settings dialog
  // (which they wouldn't do mid-zoom). For now we just trigger a refresh.
  // HS-8283 — only refresh when the changed project is one we're showing.
  // Pre-fix this fired for every project switch / new-project add (which
  // calls setProjectDefault for the active project), tearing down every
  // tile across every project — and because the cache was global, tiles
  // from other projects re-rendered against the wrong default and flashed
  // to FALLBACK_APPEARANCE. Now that the cache is per-secret, the dedup
  // gate inside setProjectDefault handles unchanged values, and we
  // additionally check that the changed secret belongs to a project the
  // dashboard is currently displaying before doing any expensive work.
  dashboardState.appearanceUnsubscribe = subscribeToDefaultAppearanceChanges((changedSecret) => {
    // HS-8288 — skip when the initial paint hasn't populated lastSectionData
    // yet. Pre-fix, every project's first `loadProjectDefaultAppearance`
    // (called per-project from `fetchProjectSections`) fired this event,
    // and because lastSectionData was still empty during the initial fetch
    // we fell through to `refreshDashboardGrid()` — once per project. Each
    // refresh tore down every dashboard handle, started a fresh
    // `renderDashboardGrid`, and synchronously cleared the dashboard root
    // with a `<loading>` element. With multiple in-flight cascading
    // renderDashboardGrids, tiles were torn down mid-mount: an
    // IntersectionObserver callback from one paint would call
    // `mountTileViaCheckout` on a tile whose section was about to be
    // disposed, leaving the tile's `xtermRoot` div in `tile.preview` with
    // an empty body (no live xterm + no placeholder + no entry in the
    // checkout map) — the user-reported "Kerf goes blank, every other tile
    // renders normally" symptom. The initial paint already sees the right
    // appearance values because `setProjectDefault` writes the cache
    // BEFORE dispatching the event; by the time `paintDashboardSections`
    // runs, `getProjectDefault(secret)` returns the freshly loaded value
    // for every project.
    if (dashboardState.lastSectionData.length === 0) return;
    if (changedSecret !== '') {
      const showingThisProject = dashboardState.lastSectionData.some(
        (section) => section.project.secret === changedSecret,
      );
      if (!showingThisProject) return;
    }
    refreshDashboardGrid();
  });

  // HS-7661 — re-render the sections (using cached dashboardState.lastSectionData) when
  // hidden-terminal state changes. No fetch round-trip; the subscription
  // fires after every `setTerminalHidden` / `unhideAll*` call.
  // HS-7823 — refresh the eye-icon badge count alongside the re-render.
  // HS-7826 — refresh the grouping selector dropdown so adding / renaming
  // / deleting / switching groupings updates the chrome immediately.
  dashboardState.hiddenChangeUnsubscribe = subscribeToHiddenChanges(() => {
    applyHideButtonBadge(dashboardState.hideButton, countHiddenAcrossAllProjects());
    refreshDashboardGroupingSelect();
    if (!dashboardState.active || dashboardState.rootElement === null) return;
    paintDashboardSections(dashboardState.rootElement, dashboardState.lastSectionData);
  });
  refreshDashboardGroupingSelect();
  // HS-7823 — initial paint of the badge so the count is correct on first
  // dashboard open even when no toggle has fired this session yet.
  applyHideButtonBadge(dashboardState.hideButton, countHiddenAcrossAllProjects());
}

async function renderDashboardGrid(root: HTMLElement): Promise<void> {
  root.replaceChildren(toElement(<div className="terminal-dashboard-loading">Loading terminals…</div>));
  // HS-7662 — await both fetches in parallel. The layout-mode load is
  // typically resolved by initTerminalDashboard's eager call, so this is
  // usually instant.
  // HS-7948 — also await the persisted slider value so the very first
  // paint applies the user's saved scale rather than the default 33.
  const [sections] = await Promise.all([fetchProjectSections(), loadLayoutMode(), loadSliderValue()]);
  if (!dashboardState.active) return; // user exited during fetch
  dashboardState.lastSectionData = sections;
  paintDashboardSections(root, sections);
  // HS-7970 — refresh the grouping selector NOW that `dashboardState.lastSectionData` is
  // populated. `enterDashboard` ran `refreshDashboardGroupingSelect()` synchronously
  // before this fetch resolved, when `dashboardState.lastSectionData` was still empty —
  // which made the select think there was no scope project, so it hid
  // itself. Re-run with real data so a project that has multiple groupings
  // shows the dropdown next to the eye icon.
  refreshDashboardGroupingSelect();
}

/** HS-7661 — render the dashboard's project sections from cached
 *  section data, applying the current hidden-terminal filter. Sections
 *  whose terminals are ALL hidden are dropped entirely (per the user's
 *  feedback: "hide the whole project"); sections with 0 configured
 *  terminals still render their empty-state row per §25.10. When NO
 *  visible tiles exist anywhere AND no projects have a 0-terminal
 *  empty-state to show, the dashboard renders a centered "All Terminals
 *  Hidden" placeholder.
 *
 *  HS-7662 — branches on the persisted `dashboard_layout_mode`. Sectioned
 *  mode keeps the per-project section rendering. Flow mode renders a
 *  single grid container with one TileGrid handle and a flat TileEntry
 *  array spanning every project's terminals. */
function paintDashboardSections(root: HTMLElement, sections: ProjectSectionData[]): void {
  // Dispose existing handles + clear the root before re-painting.
  for (const handle of gridHandles.values()) handle.dispose();
  gridHandles.clear();
  root.replaceChildren();

  if (sections.length === 0) {
    root.appendChild(toElement(<div className="terminal-dashboard-empty">No registered projects.</div>));
    return;
  }

  if (dashboardState.layoutMode === 'flow') {
    paintFlowLayout(root, sections);
  } else {
    paintSectionedLayout(root, sections);
  }

  // Re-run sizing after the grid is populated — the per-handle `rebuild()`
  // call inside the section / flow paths runs `applySizing()` once but that
  // can land against a DETACHED grid container (clientWidth === 0) and
  // early-return, leaving tiles with no preview dims. Now that the grid is
  // attached to the document, walk all handles and size again.
  applyAllSizing();
}

function paintSectionedLayout(root: HTMLElement, sections: ProjectSectionData[]): void {
  let renderedAny = false;
  let totalVisible = 0;
  for (const section of sections) {
    const visible = filterVisibleEntries(section.project.secret, section.terminals);
    totalVisible += visible.length;
  }
  for (const section of sections) {
    const visible = filterVisibleEntries(section.project.secret, section.terminals);
    // Drop the section entirely when there are configured terminals but
    // ALL of them are hidden — per the HS-7661 user answer "hide the whole
    // project". Sections with zero CONFIGURED terminals fall through to
    // the existing §25.10 empty-state row.
    if (section.terminals.length > 0 && visible.length === 0) continue;
    renderedAny = true;
    root.appendChild(renderProjectSection(section, visible));
  }
  if (!renderedAny || totalVisible === 0) {
    root.appendChild(toElement(
      <div className="terminal-dashboard-all-hidden">All Terminals Hidden</div>
    ));
  }
}

/** HS-7662 — flow layout: one grid container, one tile-grid handle, flat
 *  list of tiles in registered-project order. Empty projects (zero
 *  terminals OR every terminal hidden) are dropped entirely (per user
 *  feedback #5).
 *
 *  HS-7967 — every tile gets the project name as a `{ProjectName} ›` label
 *  prefix, not just the first tile of each project's run. Originally the
 *  prefix was only on the run's first tile (the visual run was supposed to
 *  carry the grouping for subsequent tiles, after HS-7824 dropped the
 *  colored badge dots that originally marked them); the user reported back
 *  that "in flow mode" the lone first-tile prefix didn't reliably tell
 *  them which project a given subsequent tile belonged to. Always-prefix
 *  is unambiguous + symmetric, and the cost is just a few extra characters
 *  per tile label. No `+` button, no terminal-count headings, no per-
 *  section chrome (per user feedback #7 + §25.10.5 spec). */
interface FlowTile { secret: string; entry: TileEntry; project: ProjectInfo }

function flattenSectionsToTiles(sections: ProjectSectionData[]): FlowTile[] {
  const flat: FlowTile[] = [];
  for (const section of sections) {
    const visible = filterVisibleEntries(section.project.secret, section.terminals);
    if (visible.length === 0) continue;
    for (const terminal of visible) {
      const baseEntry = toTileEntry(section.project.secret)(terminal);
      flat.push({
        secret: section.project.secret,
        project: section.project,
        entry: { ...baseEntry, projectBadge: { name: section.project.name } },
      });
    }
  }
  return flat;
}

function setFlowChromeVisibility(visible: boolean): void {
  const display = visible ? '' : 'none';
  if (dashboardState.sizerContainer !== null) dashboardState.sizerContainer.style.display = display;
  if (dashboardState.layoutToggleButton !== null) dashboardState.layoutToggleButton.style.display = display;
  if (dashboardState.hideButton !== null) dashboardState.hideButton.style.display = display;
  if (dashboardState.groupingSelect !== null) dashboardState.groupingSelect.style.display = display;
}

function fillDedicatedLabel(label: HTMLElement, project: ProjectInfo, terminalLabel: string): void {
  label.replaceChildren();
  label.appendChild(toElement(
    <span className="terminal-dashboard-dedicated-project">{project.name}</span>
  ));
  label.appendChild(toElement(
    <span className="terminal-dashboard-dedicated-sep">{'›'}</span>
  ));
  label.appendChild(toElement(
    <span className="terminal-dashboard-dedicated-terminal">{terminalLabel}</span>
  ));
}

/** HS-8104 — extracted from `paintFlowLayout` to keep it readable. The
 *  callback hides flow-grid chrome on enter, mounts a search widget into the
 *  dedicated toolbar, and the returned cleanup restores the chrome on exit
 *  (only when the dashboard is still active — `exitDashboard` will tear
 *  things down separately). */
function buildFlowDedicatedBarMount(
  projectFor: (entry: TileEntry) => ProjectInfo | null,
): (bar: HTMLElement, entry: TileEntry, term: Terminal) => () => void {
  return (bar, entry, term) => {
    setFlowChromeVisibility(false);
    const label = bar.querySelector<HTMLElement>('.terminal-dashboard-dedicated-label');
    const project = projectFor(entry);
    if (label !== null && project !== null) fillDedicatedLabel(label, project, entry.label);
    const search = new SearchAddon();
    term.loadAddon(search);
    const searchSlot = byIdOrNull('terminal-dashboard-search-slot');
    let handleLocal: TerminalSearchHandle | null = null;
    if (searchSlot !== null) {
      handleLocal = mountTerminalSearch(term, search, { placeholder: `Search ${entry.label}` });
      searchSlot.replaceChildren(handleLocal.root);
      searchSlot.style.display = '';
      dashboardState.dedicatedSearchHandle = handleLocal;
    }
    return () => {
      try { handleLocal?.dispose(); } catch { /* ignore */ }
      if (searchSlot !== null) {
        searchSlot.replaceChildren();
        searchSlot.style.display = 'none';
      }
      dashboardState.dedicatedSearchHandle = null;
      if (dashboardState.active) {
        setFlowChromeVisibility(true);
        // HS-7826 — restore the grouping selector if it should be visible
        // (>1 grouping). refreshDashboardGroupingSelect handles the count
        // check; setFlowChromeVisibility above unconditionally shows it.
        refreshDashboardGroupingSelect();
      }
    };
  };
}

function paintFlowLayout(root: HTMLElement, sections: ProjectSectionData[]): void {
  const flat = flattenSectionsToTiles(sections);

  if (flat.length === 0) {
    root.appendChild(toElement(
      <div className="terminal-dashboard-all-hidden">All Terminals Hidden</div>
    ));
    return;
  }

  const flowGrid = toElement(<div className="terminal-dashboard-grid terminal-dashboard-grid-flow"></div>);
  root.appendChild(flowGrid);

  // Build a lookup from terminalId → project so the per-tile callbacks (right-
  // click, dedicated-bar mount, etc.) can recover the originating project
  // without a fresh /projects fetch. Flow mode collapses the per-project
  // handle map down to one global handle, so we need this side table.
  const tileProject = new Map<string, ProjectInfo>();
  for (const f of flat) tileProject.set(f.entry.id, f.project);
  const projectFor = (entry: TileEntry): ProjectInfo | null => tileProject.get(entry.id) ?? null;

  const handle = mountTileGrid({
    container: flowGrid,
    cssPrefix: 'terminal-dashboard',
    centerSizeFrac: 0.7,
    centerScope: 'viewport',
    centerReferenceEl: dashboardState.rootElement ?? undefined,
    getColumnCount: () => dashboardState.columnCount,
    onContextMenu: (entry, e) => {
      const project = projectFor(entry);
      if (project === null) return;
      onTileContextMenu(entry, project.secret, e);
    },
    onTileEnlarge: (_entry, target) => {
      if (target === 'center') dashboardState.centeredHandle = handle;
    },
    onTileShrink: () => {
      if (dashboardState.centeredHandle === handle && !handle.isCentered()) dashboardState.centeredHandle = null;
    },
    // HS-7943 — flow-mode project-badge click → route to that project's
    // tab. Mirrors the HS-6832 project-tab-while-in-dashboard pattern:
    // `exitDashboard()` first so the dashboard chrome tears down, then
    // `switchProject(project)` lands the user on the clicked project's
    // normal ticket view. The tile-grid module stops propagation so the
    // tile-center click handler doesn't ALSO fire.
    onProjectBadgeClick: (entry) => {
      const project = projectFor(entry);
      if (project === null) return;
      exitDashboard();
      void switchProject(project);
    },
    onDedicatedBarMount: buildFlowDedicatedBarMount(projectFor),
  });
  // Use a sentinel "flow" key so the bell long-poll fan-out treats it
  // uniformly. The bell-poll subscription iterates per-secret, but in flow
  // mode every project's pending bells need to land on the same handle —
  // we wrap the per-secret callback in the bell subscription path below
  // (handled by enterDashboard's subscription).
  gridHandles.set(FLOW_HANDLE_KEY, handle);
  handle.rebuild(flat.map(f => f.entry));
}

/** HS-7662 — sentinel key for the single flow-mode tile-grid handle in the
 *  shared `gridHandles` map. Distinguishes from per-project secrets so the
 *  bell fan-out + cross-handle iteration in enterDashboard can recognise
 *  the flow-mode handle and pass it the union of every project's pending
 *  bells (rather than treating it like a per-project handle that only
 *  cares about its own secret). */
const FLOW_HANDLE_KEY = '__flow_handle__';

async function fetchProjectSections(): Promise<ProjectSectionData[]> {
  let projects: ProjectInfo[] = [];
  try {
    projects = await api<ProjectInfo[]>('/projects');
  } catch { /* leave empty */ }

  const sections: ProjectSectionData[] = [];
  for (const project of projects) {
    let terminals: TerminalListEntry[] = [];
    try {
      const listed = await apiWithSecret<{ configured: TerminalListEntry[]; dynamic: TerminalListEntry[] }>(
        '/terminal/list', project.secret,
      );
      terminals = [
        ...listed.configured.map(t => ({ ...t, dynamic: false })),
        ...listed.dynamic.map(t => ({ ...t, dynamic: true })),
      ];
    } catch { /* project's terminal list unavailable */ }
    // HS-8283 — load each project's `terminal_default` into the per-secret
    // cache so this project's tiles resolve their appearance against their
    // OWN default (not whatever the active project's default happens to
    // be). Fire-and-forget; setProjectDefault dedups when the value
    // matches, and the change event is scope-filtered by subscribers.
    void loadProjectDefaultAppearance(project.secret);
    // HS-8016 — reconcile this project's hidden state against the live list
    // so the dashboard's `countHiddenAcrossAllProjects` badge stops counting
    // terminals that no longer exist. Pre-fix the count drifted whenever the
    // user closed a hidden terminal from a non-dashboard surface (drawer
    // X-button, Settings → delete) — the dashboard's notify chain only
    // re-paints when `subscribeToHiddenChanges` fires, and a plain destroy
    // never touched the hidden state.
    pruneHiddenForProject(project.secret, terminals.map(t => t.id));
    sections.push({ project, terminals });
  }
  return sections;
}

function buildSectionEl(data: ProjectSectionData): HTMLElement {
  const count = data.terminals.length;
  const headingText = count > 0
    ? `${data.project.name} (${count} ${count === 1 ? 'terminal' : 'terminals'})`
    : data.project.name;
  return toElement(
    <section className="terminal-dashboard-section" data-secret={data.project.secret}>
      <div className="terminal-dashboard-heading-row">
        {/* HS-7943 — heading is now clickable and routes to the project's
            tab. Title attribute mirrors the per-tile project-badge tooltip
            for affordance consistency. */}
        <h2 className="terminal-dashboard-heading is-clickable" title={`Switch to ${data.project.name}`}>{headingText}</h2>
        <button
          className="terminal-dashboard-add-terminal-btn"
          title="Add terminal to this project"
          aria-label={`Add terminal to ${data.project.name}`}
          data-secret={data.project.secret}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>
        </button>
      </div>
      {count === 0 ? (
        <div className="terminal-dashboard-empty-row">
          No terminals configured.
        </div>
      ) : (
        <div className="terminal-dashboard-grid"></div>
      )}
    </section>
  );
}

/** HS-8104 — extracted from `renderProjectSection`. Sectioned-mode dedicated-
 *  bar mount; structurally similar to flow-mode's variant but flips two chrome
 *  surfaces (sizer + grouping) instead of four. */
function buildSectionedDedicatedBarMount(
  project: ProjectInfo,
): (bar: HTMLElement, entry: TileEntry, term: Terminal) => () => void {
  return (bar, entry, term) => {
    if (dashboardState.sizerContainer !== null) dashboardState.sizerContainer.style.display = 'none';
    // HS-7826 — also hide the grouping selector while the dedicated view is
    // open; it shares the toolbar real estate with the sizer.
    if (dashboardState.groupingSelect !== null) dashboardState.groupingSelect.style.display = 'none';
    const label = bar.querySelector<HTMLElement>('.terminal-dashboard-dedicated-label');
    if (label !== null) fillDedicatedLabel(label, project, entry.label);
    const search = new SearchAddon();
    term.loadAddon(search);
    const searchSlot = byIdOrNull('terminal-dashboard-search-slot');
    let handleLocal: TerminalSearchHandle | null = null;
    if (searchSlot !== null) {
      handleLocal = mountTerminalSearch(term, search, { placeholder: `Search ${entry.label}` });
      searchSlot.replaceChildren(handleLocal.root);
      searchSlot.style.display = '';
      dashboardState.dedicatedSearchHandle = handleLocal;
    }
    return () => {
      try { handleLocal?.dispose(); } catch { /* ignore */ }
      if (searchSlot !== null) {
        searchSlot.replaceChildren();
        searchSlot.style.display = 'none';
      }
      dashboardState.dedicatedSearchHandle = null;
      if (dashboardState.sizerContainer !== null && dashboardState.active) dashboardState.sizerContainer.style.display = '';
      // HS-7826 — restore the grouping selector visibility (count-aware).
      if (dashboardState.active) refreshDashboardGroupingSelect();
    };
  };
}

function mountSectionGrid(grid: HTMLElement, data: ProjectSectionData, visible: TerminalListEntry[]): void {
  const handle = mountTileGrid({
    container: grid,
    cssPrefix: 'terminal-dashboard',
    centerSizeFrac: 0.7,
    centerScope: 'viewport',
    centerReferenceEl: dashboardState.rootElement ?? undefined,
    getColumnCount: () => dashboardState.columnCount,
    onContextMenu: (entry, e) => { onTileContextMenu(entry, data.project.secret, e); },
    onTileEnlarge: (_entry, target) => {
      // Cross-section coordination: only one tile centered globally.
      if (target === 'center') {
        for (const [otherSecret, otherHandle] of gridHandles.entries()) {
          if (otherSecret === data.project.secret) continue;
          if (otherHandle.isCentered()) otherHandle.uncenterTile();
        }
        dashboardState.centeredHandle = handle;
      }
    },
    onTileShrink: () => {
      if (dashboardState.centeredHandle === handle && !handle.isCentered()) dashboardState.centeredHandle = null;
    },
    onDedicatedBarMount: buildSectionedDedicatedBarMount(data.project),
  });
  gridHandles.set(data.project.secret, handle);
  handle.rebuild(visible.map(toTileEntry(data.project.secret)));
}

function renderProjectSection(data: ProjectSectionData, visibleTerminals?: TerminalListEntry[]): HTMLElement {
  // HS-7661 — `count` reflects all configured terminals; `visible` is the
  // filtered set used for the actual tile render. Default to the full list
  // so older callsites keep working.
  const visible = visibleTerminals ?? data.terminals;
  const section = buildSectionEl(data);

  // HS-7943 — sectioned-mode heading click routes to the project's tab.
  const headingEl = section.querySelector<HTMLElement>('.terminal-dashboard-heading');
  headingEl?.addEventListener('click', () => {
    exitDashboard();
    void switchProject(data.project);
  });

  const grid = section.querySelector<HTMLElement>('.terminal-dashboard-grid');
  if (grid !== null) mountSectionGrid(grid, data, visible);

  const addBtn = section.querySelector<HTMLButtonElement>('.terminal-dashboard-add-terminal-btn');
  addBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void createDashboardTerminal(data.project.secret, data.terminals);
  });
  return section;
}

function toTileEntry(secret: string) {
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

function tileLabel(terminal: TerminalListEntry): string {
  if (typeof terminal.name === 'string' && terminal.name !== '') return terminal.name;
  const word = terminal.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/** HS-7661 — alias used by the hide-dialog opener so the call site reads
 *  clearly. Returns the same display label the tile shows. */
function tileEntryLabel(terminal: TerminalListEntry): string {
  return tileLabel(terminal);
}

/**
 * Pick a CWD to pass as the new terminal's `cwd` so it opens where the user
 * is currently working in this project. HS-7277 — prefers dynamic-bucket
 * tiles (most-recent ad-hoc spawn) over configured ones (rarely-moving
 * defaults). Returns null when no tile has a server-tracked CWD yet.
 */
function pickInheritedCwd(terminals: TerminalListEntry[]): string | null {
  const dynamics = terminals.filter(t => t.dynamic === true);
  const statics = terminals.filter(t => t.dynamic !== true);
  for (const t of [...dynamics, ...statics]) {
    const cwd = t.currentCwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  }
  return null;
}

async function createDashboardTerminal(secret: string, terminals: TerminalListEntry[]): Promise<void> {
  const inheritedCwd = pickInheritedCwd(terminals);
  const body: { spawn: boolean; cwd?: string } = { spawn: true };
  if (inheritedCwd !== null) body.cwd = inheritedCwd;
  try {
    await apiWithSecret<{ config: { id: string } }>('/terminal/create', secret, {
      method: 'POST',
      body,
    });
  } catch (err) {
    console.error('terminalDashboard: create terminal failed', err);
    return;
  }
  refreshDashboardGrid();
}

function refreshDashboardGrid(): void {
  if (!dashboardState.active || dashboardState.rootElement === null) return;
  teardownAllHandles();
  void renderDashboardGrid(dashboardState.rootElement);
}

// -----------------------------------------------------------------------------
// Slider snap-point indicators (HS-7271)
// -----------------------------------------------------------------------------

function refreshSnapPointIndicators(): void {
  if (dashboardState.sizerContainer === null || dashboardState.rootElement === null || dashboardState.sizeSlider === null) return;
  const rootWidth = dashboardState.rootElement.clientWidth - 2 * ROOT_PADDING;
  dashboardState.currentSnapPoints = computeColumnSnapPoints(rootWidth);

  let ticksEl = dashboardState.sizerContainer.querySelector<HTMLElement>('.terminal-dashboard-sizer-ticks');
  if (ticksEl === null) {
    ticksEl = toElement(
      <div className="terminal-dashboard-sizer-ticks" aria-hidden="true"></div>
    );
    dashboardState.sizerContainer.appendChild(ticksEl);
  }
  const sliderRect = dashboardState.sizeSlider.getBoundingClientRect();
  const containerRect = dashboardState.sizerContainer.getBoundingClientRect();
  ticksEl.style.left = `${sliderRect.left - containerRect.left}px`;
  ticksEl.style.width = `${sliderRect.width}px`;
  ticksEl.innerHTML = '';
  // HS-7950 — read the per-instance thumb-width hint from CSS so the tick
  // helper can shift each tick from its naive position to the thumb's
  // centre at that value. Falls back to 16 if the variable is missing.
  // HS-8176 — `pt.sliderValue` is the LTR slider position (1..MAX) per
  // `perRowToSliderPosition`; `tickLeftPx` works in 0..100 percentage
  // space, so convert via `(sliderValue - MIN) / (MAX - MIN) * 100`.
  const thumbWidthPx = parseFloat(getComputedStyle(dashboardState.sizeSlider).getPropertyValue('--range-thumb-w')) || 16;
  const sliderRange = MAX_TILES_PER_ROW - MIN_TILES_PER_ROW;
  for (const pt of dashboardState.currentSnapPoints) {
    const pctPosition = sliderRange === 0 ? 0 : ((pt.sliderValue - MIN_TILES_PER_ROW) / sliderRange) * 100;
    ticksEl.appendChild(toElement(
      <span className="terminal-dashboard-sizer-tick"
            style={`left:${tickLeftPx(pctPosition, sliderRect.width, thumbWidthPx)}px;`}
            title={`${pt.perRow} per row`}></span>
    ));
  }
}

function applyAllSizing(): void {
  for (const handle of gridHandles.values()) handle.applySizing();
}

// -----------------------------------------------------------------------------
// Right-click context menu (HS-7065) + rename overlay
// -----------------------------------------------------------------------------

function onTileContextMenu(entry: TileEntry, secret: string, e: MouseEvent): void {
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
        <span className="dropdown-icon">{raw(ICON_X)}</span>
        <span className="context-menu-label">Close Terminal</span>
      </div>
      {/* HS-7661 — hide this terminal from the dashboard. Session-only;
          state lives in dashboardHiddenTerminals.ts. The hidden-state
          subscription rebuilds the dashboard so the tile disappears
          immediately. */}
      <div className="context-menu-item" data-action="hide">
        <span className="dropdown-icon">{raw(ICON_EYE_OFF)}</span>
        <span className="context-menu-label">Hide in Dashboard</span>
      </div>
      <div className="context-menu-separator"></div>
      <div className="context-menu-item" data-action="rename">
        <span className="dropdown-icon">{raw(ICON_PENCIL)}</span>
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

  bind('close', () => { void closeDashboardTile(entry, secret, isDynamic); });
  bind('rename', () => { openDashboardTileRename(entry); });
  bind('hide', () => { setTerminalHidden(secret, entry.id, true); });

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

function dismissDashboardTileContextMenu(): void {
  document.querySelector('.terminal-dashboard-tile-context-menu')?.remove();
}

async function closeDashboardTile(entry: TileEntry, secret: string, isDynamic: boolean): Promise<void> {
  if (!isDynamic) return;
  const meta = entry.metadata as TerminalListEntry | undefined;
  const isAlive = (meta?.state ?? 'not_spawned') === 'alive';
  if (isAlive) {
    const { confirmDialog } = await import('./confirm.js');
    const confirmed = await confirmDialog({
      title: 'Close terminal?',
      message: `Close terminal "${entry.label}"? Its running process will be stopped.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!confirmed) return;
  }
  try {
    await apiWithSecret('/terminal/destroy', secret, {
      method: 'POST',
      body: { terminalId: entry.id },
    });
  } catch (err) {
    console.error('terminalDashboard: close terminal failed', err);
    return;
  }
  refreshDashboardGrid();
}

function openDashboardTileRename(entry: TileEntry): void {
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

/** **TEST ONLY** — reset every module-level state slot back to its boot
 *  default so consecutive tests don't leak. Mirrors the HS-8190 convention
 *  in `permissionOverlay.tsx::_resetStateForTesting`: runs disposers BEFORE
 *  swapping in a fresh state so an in-flight RAF, debounce timeout, or
 *  long-poll subscription doesn't leak past the swap. The const collection
 *  state (`gridHandles`) is cleared explicitly because it is a separate
 *  container, not part of the bundled state object. */
export function _resetStateForTesting(): void {
  if (dashboardState.resizeRaf !== null) cancelAnimationFrame(dashboardState.resizeRaf);
  if (dashboardState.resizeHandler !== null) window.removeEventListener('resize', dashboardState.resizeHandler);
  if (dashboardState.bellUnsubscribe !== null) {
    try { dashboardState.bellUnsubscribe(); } catch { /* ignore */ }
  }
  if (dashboardState.appearanceUnsubscribe !== null) {
    try { dashboardState.appearanceUnsubscribe(); } catch { /* ignore */ }
  }
  if (dashboardState.hiddenChangeUnsubscribe !== null) {
    try { dashboardState.hiddenChangeUnsubscribe(); } catch { /* ignore */ }
  }
  if (dashboardState.sliderPersistTimeout !== null) clearTimeout(dashboardState.sliderPersistTimeout);
  for (const handle of gridHandles.values()) {
    try { handle.dispose(); } catch { /* ignore */ }
  }
  gridHandles.clear();
  dashboardState = freshDashboardState();
}
