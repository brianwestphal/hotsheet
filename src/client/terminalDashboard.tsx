import { api, apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import {
  applyHideButtonBadge,
  countHiddenAcrossAllProjects,
  pruneHiddenForProject,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import { restoreTicketList } from './dashboardMode.js';
import { closeDetail } from './detail.js';
import { byIdOrNull, toElement } from './dom.js';
import { showHideTerminalDialog } from './hideTerminalDialog.js';
import { shouldEscapeBypassHotsheet } from './shortcuts.js';
import type { ProjectInfo } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { loadProjectDefaultAppearance, subscribeToDefaultAppearanceChanges } from './terminalAppearance.js';
import {
  _resetLayoutStateForTesting,
  bindLayoutToggle,
  loadLayoutMode,
  setLayoutToggleVisible,
} from './terminalDashboardLayout.js';
import {
  applyAllSizing,
  applyAllSizingIfActive,
  FLOW_HANDLE_KEY,
  initDashboardPaint,
  paintDashboardSections,
  refreshSnapPointIndicators,
} from './terminalDashboardPaint.js';
import { attachDedicatedBarSearch } from './terminalDashboardPaintHelpers.js';
import {
  _resetSliderStateForTesting,
  bindSizeSliderInput,
  loadSliderValue,
  parsePersistedColumnCount,
  syncSliderElementValue,
} from './terminalDashboardSlider.js';
import {
  _resetCommonStateForTesting,
  dashboardState,
  gridHandles,
  type ProjectSectionData,
  type TerminalListEntry,
} from './terminalDashboardState.js';
import { pickInheritedCwd, tileEntryLabel } from './terminalDashboardTiles.js';

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
 *   `onDedicatedBarMount` hook — the widget is now appended directly to
 *   the dedicated bar (HS-8341), right-aligned via a CSS rule on
 *   `.terminal-dashboard-dedicated-bar > .terminal-search-box`. Pre-fix
 *   it mounted into a `#terminal-dashboard-search-slot` slot in the
 *   app-header, which was always occluded by the fixed-position overlay.
 * - Cross-section centered-tile coordination (only one tile across all
 *   project sections is centered at a time).
 * - The right-click context menu (Close Tab + Rename for dynamic
 *   terminals) and the rename overlay.
 */

const BODY_CLASS = 'terminal-dashboard-active';

// HS-8395 Phase 3b — module-level state (`dashboardState`, `gridHandles`),
// the `DashboardState` interface, the `TerminalListEntry` /
// `ProjectSectionData` types, and `freshDashboardState()` moved to
// `terminalDashboardState.ts`. Re-exported here so existing consumers
// (e.g. `terminalDashboardTiles.tsx` imports `TerminalListEntry`) keep
// their `from './terminalDashboard.js'` shape.
export type { ProjectSectionData, TerminalListEntry, TerminalSessionState } from './terminalDashboardState.js';

// HS-8395 Phase 3a — `attachDedicatedBarSearch` lives in
// `terminalDashboardPaintHelpers.tsx`. Re-exported here so the existing
// HS-8341 DOM-level test file keeps its `from './terminalDashboard.js'`
// import shape unchanged.
export { attachDedicatedBarSearch };

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
      // HS-8341 — the widget moved from the app-header slot into the
      // dedicated bar itself; recover it via the `dedicatedSearchHandle`
      // state slot (set by `buildFlowDedicatedBarMount` /
      // `buildSectionedDedicatedBarMount`) rather than a fixed DOM id.
      const activeEl = document.activeElement as HTMLElement | null;
      const searchRoot = dashboardState.dedicatedSearchHandle?.root ?? null;
      const inSearch = activeEl !== null && searchRoot !== null && searchRoot.contains(activeEl)
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

  // HS-8395 Phase 3c — wire the paint module's cross-module callbacks
  // before any paint function can fire. The hooks pattern keeps the
  // paint↔lifecycle dependency one-way: paint imports state directly,
  // calls back into lifecycle via this slot.
  initDashboardPaint({
    refreshDashboardGroupingSelect,
    refreshDashboardGrid,
    exitDashboard,
    createDashboardTerminal,
  });

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
  const layoutToggleBtn = byIdOrNull<HTMLButtonElement>('terminal-dashboard-layout-toggle');

  bindGroupingSelect();
  // HS-7662 + HS-7948 — fire-and-forget eagerly load persisted layout mode +
  // slider value so the first dashboard open paints with restored state and
  // no flicker. The fetches share /file-settings caching with other on-load
  // callers.
  void loadLayoutMode();
  void loadSliderValue({
    sliderEl: dashboardState.sizeSlider,
    onColumnCountApplied: applyAllSizingIfActive,
  });
  if (layoutToggleBtn !== null) {
    bindLayoutToggle({
      toggleButton: layoutToggleBtn,
      onChanged: repaintWithCachedSectionData,
    });
  }
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
  if (dashboardState.sizeSlider !== null) {
    bindSizeSliderInput({
      sliderEl: dashboardState.sizeSlider,
      onColumnCountChanged: applyAllSizingIfActive,
    });
  }

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
  setLayoutToggleVisible(false);
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
// Layout mode (HS-7662) — extracted to terminalDashboardLayout.ts under
// HS-8395 Phase 2a. The functions `parseLayoutMode`, `loadLayoutMode`,
// `setLayoutMode`, `applyLayoutToggleVisualState`, `bindLayoutToggle`,
// `setLayoutToggleVisible` + the `LayoutMode` type live in that module
// now. The main file reads the current mode via `getLayoutMode()`.
// -----------------------------------------------------------------------------

// HS-8395 Phase 2b — `parsePersistedColumnCount`, `loadSliderValue`,
// `schedulePersistSliderValue` moved to `terminalDashboardSlider.ts`.
// `parsePersistedColumnCount` is re-exported below so existing
// `from './terminalDashboard.js'` consumers (including the test file)
// keep their import shape.
export { parsePersistedColumnCount };

/** HS-8395 Phase 2a — repaint the dashboard using the cached section data,
 *  used as the `onChanged` callback for layout-mode flips so we don't
 *  re-fetch /projects + /terminal/list on every toggle. No-op when the
 *  dashboard isn't active or no data has been loaded yet. */
function repaintWithCachedSectionData(): void {
  if (dashboardState.active && dashboardState.rootElement !== null && dashboardState.lastSectionData.length > 0) {
    paintDashboardSections(dashboardState.rootElement, dashboardState.lastSectionData);
  }
}

function teardownAllHandles(): void {
  for (const handle of gridHandles.values()) handle.dispose();
  gridHandles.clear();
  dashboardState.centeredHandle = null;
  // HS-8341 — the dedicated bar's search widget is owned by the per-bar
  // disposer returned from `buildFlowDedicatedBarMount` /
  // `buildSectionedDedicatedBarMount`; when each tile-grid handle is
  // disposed above, its `exitDedicatedView` fires the disposer which
  // removes the widget. Clear the reference defensively in case a handle
  // had been torn down out of band.
  if (dashboardState.dedicatedSearchHandle !== null) {
    try { dashboardState.dedicatedSearchHandle.dispose(); } catch { /* ignore */ }
    dashboardState.dedicatedSearchHandle = null;
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
  setLayoutToggleVisible(true);
  if (dashboardState.sizeSlider !== null) syncSliderElementValue(dashboardState.sizeSlider);
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
  const [sections] = await Promise.all([
    fetchProjectSections(),
    loadLayoutMode(),
    loadSliderValue({
      sliderEl: dashboardState.sizeSlider,
      onColumnCountApplied: applyAllSizingIfActive,
    }),
  ]);
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

// -----------------------------------------------------------------------------
// Per-project section fetch + refresh + create helpers — kept in the main
// module so the paint module can call them via the HS-8395 Phase 3c hook
// context without a circular import. `refreshDashboardGrid` calls
// `renderDashboardGrid` which lives here; `createDashboardTerminal` calls
// `refreshDashboardGrid`.
// -----------------------------------------------------------------------------

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

function refreshDashboardGrid(): void {
  if (!dashboardState.active || dashboardState.rootElement === null) return;
  teardownAllHandles();
  void renderDashboardGrid(dashboardState.rootElement);
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

// -----------------------------------------------------------------------------
// Per-tile context menu — moved into `terminalDashboardTiles.tsx` under HS-8395
// Phase 1. Paint orchestrators (`paintDashboardSections`, the layout-mode
// paths, the section builders, the dedicated-bar mount callbacks,
// `setFlowChromeVisibility`, `refreshSnapPointIndicators`, `applyAllSizing`,
// `applyAllSizingIfActive`) moved to `terminalDashboardPaint.tsx` under
// HS-8395 Phase 3c.
// -----------------------------------------------------------------------------
//
// HS-8395 Phase 1 — moved into `terminalDashboardTiles.tsx`. Re-exported from
// the bottom of this file for back-compat. The context menu's
// `onTileContextMenu` takes a `{ onTileMutated }` callback so it can refresh
// the dashboard grid without the helper module reaching back into this file.

/** **TEST ONLY** — reset every module-level state slot back to its boot
 *  default so consecutive tests don't leak. Mirrors the HS-8190 convention
 *  in `permissionOverlay.tsx::_resetStateForTesting`: runs disposers BEFORE
 *  swapping in a fresh state so an in-flight RAF, debounce timeout, or
 *  long-poll subscription doesn't leak past the swap. HS-8395 Phase 3b —
 *  the common dashboard state (RAF / observers / handle map) is reset by
 *  `_resetCommonStateForTesting` in the state module; this function is now
 *  a thin orchestrator that ALSO resets the sibling sub-module slots. */
export function _resetStateForTesting(): void {
  _resetCommonStateForTesting();
  // HS-8395 Phase 2a + 2b — also reset the per-concern sub-module
  // state slots so consecutive tests don't leak across them either.
  _resetLayoutStateForTesting();
  _resetSliderStateForTesting();
}
