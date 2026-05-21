/**
 * Paint orchestration extracted out of `terminalDashboard.tsx` per
 * HS-8395 Phase 3c. The shared dashboard state lives in
 * `terminalDashboardState.ts` (Phase 3b); this module imports the
 * `dashboardState` slot + `gridHandles` map directly and writes through
 * them, mirroring how `terminalDashboardLayout.ts` and
 * `terminalDashboardSlider.ts` work against their own private slots.
 *
 * Cross-module side effects that point BACK to the main lifecycle
 * module (`refreshDashboardGrid`, `refreshDashboardGroupingSelect`,
 * `exitDashboard`, `createDashboardTerminal`) flow through a small
 * `PaintHooks` object set via `initDashboardPaint(hooks)` once during
 * `initTerminalDashboard`. Without the hook indirection, a direct
 * `import { exitDashboard } from './terminalDashboard.js'` would create
 * a circular import chain (paint ↔ main) that bites the moment a
 * module-init-time reference creeps in.
 *
 * Functions owned here:
 * - `applyAllSizing` / `applyAllSizingIfActive` — gridHandles iteration.
 * - `refreshSnapPointIndicators` — HS-7271 slider snap-point ticks.
 * - `setFlowChromeVisibility` — chrome show/hide for the flow-mode dedicated view.
 * - `paintDashboardSections` — top-level paint dispatcher (sectioned vs flow).
 * - `paintSectionedLayout` / `paintFlowLayout` — the two layout paths.
 * - `buildSectionEl` / `mountSectionGrid` / `renderProjectSection` — sectioned-mode building blocks.
 * - `buildFlowDedicatedBarMount` / `buildSectionedDedicatedBarMount` — dedicated-view top-bar callbacks.
 * - `FLOW_HANDLE_KEY` — sentinel key for the single flow-mode handle in `gridHandles`.
 */

import type { Terminal } from '@xterm/xterm';

import { DASHBOARD_SCOPE, filterVisible as filterVisibleEntriesScoped } from './dashboardHiddenTerminals.js';
import { toElement } from './dom.js';
import { switchProject } from './projectTabs.js';
import type { ProjectInfo } from './state.js';
import { getLayoutMode, setLayoutToggleVisible } from './terminalDashboardLayout.js';
import {
  attachDedicatedBarSearch,
  buildSectionProjectLookup,
  fillDedicatedLabel,
  flattenSectionsToTiles,
  resolveTileEntryProject,
} from './terminalDashboardPaintHelpers.js';
import {
  computeColumnSnapPoints,
  innerContentWidth,
  MAX_TILES_PER_ROW,
  MIN_TILES_PER_ROW,
  tickLeftPx,
} from './terminalDashboardSizing.js';
import { getColumnCount } from './terminalDashboardSlider.js';
import {
  dashboardState,
  gridHandles,
  type ProjectSectionData,
  type TerminalListEntry,
} from './terminalDashboardState.js';
import { onTileContextMenu, toTileEntry } from './terminalDashboardTiles.js';
import { mountTileGrid, type TileEntry } from './terminalTileGrid.js';

/** HS-7662 — sentinel key for the single flow-mode tile-grid handle in
 *  the shared `gridHandles` map. Distinguishes from per-project secrets
 *  so the bell fan-out + cross-handle iteration in `enterDashboard` can
 *  recognize the flow-mode handle and pass it the union of every
 *  project's pending bells (rather than treating it like a per-project
 *  handle that only cares about its own secret). */
export const FLOW_HANDLE_KEY = '__flow_handle__';

/** Cross-module callbacks the paint code needs to point at the
 *  lifecycle code without introducing a circular import. Set once at
 *  `initTerminalDashboard` time via `initDashboardPaint`. */
export interface PaintHooks {
  refreshDashboardGroupingSelect: () => void;
  refreshDashboardGrid: () => void;
  exitDashboard: () => void;
  createDashboardTerminal: (secret: string, terminals: TerminalListEntry[]) => Promise<void>;
}

let hooks: PaintHooks | null = null;

/** Initialize the paint module with its cross-module callbacks. Must be
 *  called once before any paint function fires (the main module wires
 *  this up at the top of `initTerminalDashboard`). */
export function initDashboardPaint(h: PaintHooks): void {
  hooks = h;
}

function requireHooks(): PaintHooks {
  if (hooks === null) throw new Error('initDashboardPaint must be called before any paint function');
  return hooks;
}

// -----------------------------------------------------------------------------
// Sizing
// -----------------------------------------------------------------------------

export function applyAllSizing(): void {
  for (const handle of gridHandles.values()) handle.applySizing();
}

/** HS-8395 Phase 2b — sizing-reapply callback for both `loadSliderValue`
 *  (after the server-persisted column count is restored) and
 *  `bindSizeSliderInput` (after the user drags the slider). Both fire
 *  unconditionally; the active-state gate lives here. */
export function applyAllSizingIfActive(): void {
  if (dashboardState.active) applyAllSizing();
}

/** HS-7271 — render the slider's snap-point tick marks. Each tick lives
 *  in the sizer container's `.terminal-dashboard-sizer-ticks` strip,
 *  positioned by converting the snap point's LTR slider value into a
 *  0..100 percentage and then to a px offset that accounts for the
 *  thumb width. */
export function refreshSnapPointIndicators(): void {
  if (dashboardState.sizerContainer === null || dashboardState.rootElement === null || dashboardState.sizeSlider === null) return;
  // HS-8442 — use `innerContentWidth` so the dashboard outer's actual
  // padding (currently 20 px each side) is read from the live computed
  // style, not the hard-coded `ROOT_PADDING` constant. Keeps the snap-
  // point compute in lockstep with `applySizing`'s width math.
  const rootWidth = innerContentWidth(dashboardState.rootElement);
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
  ticksEl.replaceChildren();
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

// -----------------------------------------------------------------------------
// Chrome visibility (flow-mode dedicated view)
// -----------------------------------------------------------------------------

export function setFlowChromeVisibility(visible: boolean): void {
  const display = visible ? '' : 'none';
  if (dashboardState.sizerContainer !== null) dashboardState.sizerContainer.style.display = display;
  setLayoutToggleVisible(visible);
  if (dashboardState.hideButton !== null) dashboardState.hideButton.style.display = display;
  if (dashboardState.groupingSelect !== null) dashboardState.groupingSelect.style.display = display;
}

// -----------------------------------------------------------------------------
// Paint dispatcher + layout-mode paths
// -----------------------------------------------------------------------------

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
export function paintDashboardSections(root: HTMLElement, sections: ProjectSectionData[]): void {
  // Dispose existing handles + clear the root before re-painting.
  for (const handle of gridHandles.values()) handle.dispose();
  gridHandles.clear();
  root.replaceChildren();

  if (sections.length === 0) {
    root.appendChild(toElement(<div className="terminal-dashboard-empty">No registered projects.</div>));
    return;
  }

  if (getLayoutMode() === 'flow') {
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

  // HS-8399 — defensive third pass after the browser has had a chance to
  // settle layout. The synchronous `applyAllSizing()` above reads
  // `container.clientWidth`; in real browsers (Chromium, WKWebView)
  // accessing `clientWidth` normally forces layout, but when this paint
  // runs in response to the hidden-change subscription (visibility-grouping
  // switch, hide/show via the §39 dialog) `replaceChildren()` + the
  // `appendChild()` calls inside the layout paths can leave the grid
  // container reporting `clientWidth === 0` even after attachment until
  // the next style-recompute. The `applySizing` early-bail then leaves
  // every tile without an inline width, and the user-reported "all tiles
  // very small / 0×0" symptom appears because the CSS for
  // `.terminal-dashboard-tile` has no width fallback (width is applied
  // inline by `applyTileSizing()`, per the comment at styles.scss:1207).
  // A `requestAnimationFrame` callback fires after the browser settles
  // layout — by then `clientWidth` reports the real value, so the second
  // applyAllSizing rescues every tile. Idempotent + cheap; the same
  // pattern is already used by the window-resize handler. Guarded by
  // `typeof requestAnimationFrame` so the unit-test happy-dom path
  // (which the HS-8399 regression test in `terminalTileGrid.test.ts`
  // exercises) keeps its synchronous-only semantics.
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => { applyAllSizing(); });
  }
}

function paintSectionedLayout(root: HTMLElement, sections: ProjectSectionData[]): void {
  let renderedAny = false;
  let totalVisible = 0;
  for (const section of sections) {
    const visible = filterVisibleEntriesScoped(DASHBOARD_SCOPE, section.project.secret, section.terminals);
    totalVisible += visible.length;
  }
  for (const section of sections) {
    const visible = filterVisibleEntriesScoped(DASHBOARD_SCOPE, section.project.secret, section.terminals);
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

/** HS-8104 — extracted from `paintFlowLayout` to keep it readable. The
 *  callback hides flow-grid chrome on enter, mounts a search widget into
 *  the dedicated toolbar, and the returned cleanup restores the chrome on
 *  exit (only when the dashboard is still active — `exitDashboard` will
 *  tear things down separately). */
function buildFlowDedicatedBarMount(
  projectFor: (entry: TileEntry) => ProjectInfo | null,
): (bar: HTMLElement, entry: TileEntry, term: Terminal) => () => void {
  return (bar, entry, term) => {
    setFlowChromeVisibility(false);
    const label = bar.querySelector<HTMLElement>('.terminal-dashboard-dedicated-label');
    const project = projectFor(entry);
    if (label !== null && project !== null) fillDedicatedLabel(label, project, entry.label);
    const { handle: handleLocal, dispose: disposeSearch } = attachDedicatedBarSearch(bar, term, entry.label);
    dashboardState.dedicatedSearchHandle = handleLocal;
    return () => {
      disposeSearch();
      dashboardState.dedicatedSearchHandle = null;
      if (dashboardState.active) {
        setFlowChromeVisibility(true);
        // HS-7826 — restore the grouping selector if it should be visible
        // (>1 grouping). refreshDashboardGroupingSelect handles the count
        // check; setFlowChromeVisibility above unconditionally shows it.
        requireHooks().refreshDashboardGroupingSelect();
      }
    };
  };
}

/** HS-7662 — flow layout: one grid container, one tile-grid handle, flat
 *  list of tiles in registered-project order. Empty projects (zero
 *  terminals OR every terminal hidden) are dropped entirely (per user
 *  feedback #5).
 *
 *  HS-7967 — every tile gets the project name as a `{ProjectName} ›` label
 *  prefix; see `terminalDashboardPaintHelpers.flattenSectionsToTiles` for
 *  the wrapping. No `+` button, no terminal-count headings, no per-
 *  section chrome (per user feedback #7 + §25.10.5 spec). */
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

  // Build a lookup from project-secret → project so the per-tile callbacks
  // (right-click, dedicated-bar mount, project-badge click, etc.) can
  // recover the originating project from a `TileEntry` without a fresh
  // /projects fetch. Flow mode collapses the per-project handle map down
  // to one global handle, so we need this side table.
  //
  // HS-8489 — keyed by `secret` (not `entry.id`). Pre-fix the map keyed
  // on terminal id, which collided whenever two projects had terminals
  // sharing an id (e.g. the default `default` terminal); whichever
  // project was inserted last won, and project-badge clicks on the
  // collision-id tile routed to the wrong project (the "previously
  // selected" one the user came from). See `buildSectionProjectLookup`
  // in `terminalDashboardPaintHelpers.tsx` for the full root-cause
  // history + unit tests.
  const tileProjectLookup = buildSectionProjectLookup(sections);
  const projectFor = (entry: TileEntry): ProjectInfo | null => resolveTileEntryProject(entry, tileProjectLookup);

  const handle = mountTileGrid({
    container: flowGrid,
    cssPrefix: 'terminal-dashboard',
    centerSizeFrac: 0.7,
    centerScope: 'viewport',
    centerReferenceEl: dashboardState.rootElement ?? undefined,
    getColumnCount: () => getColumnCount(),
    onContextMenu: (entry, e) => {
      const project = projectFor(entry);
      if (project === null) return;
      onTileContextMenu(entry, project.secret, e, { onTileMutated: requireHooks().refreshDashboardGrid });
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
      requireHooks().exitDashboard();
      void switchProject(project);
    },
    onDedicatedBarMount: buildFlowDedicatedBarMount(projectFor),
  });
  // Sentinel "flow" key so the bell long-poll fan-out treats it uniformly.
  // The bell-poll subscription iterates per-secret, but in flow mode every
  // project's pending bells need to land on the same handle — see
  // `enterDashboard`'s subscription block.
  gridHandles.set(FLOW_HANDLE_KEY, handle);
  handle.rebuild(flat.map(f => f.entry));
}

// -----------------------------------------------------------------------------
// Sectioned-mode building blocks
// -----------------------------------------------------------------------------

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
    const { handle: handleLocal, dispose: disposeSearch } = attachDedicatedBarSearch(bar, term, entry.label);
    dashboardState.dedicatedSearchHandle = handleLocal;
    return () => {
      disposeSearch();
      dashboardState.dedicatedSearchHandle = null;
      if (dashboardState.sizerContainer !== null && dashboardState.active) dashboardState.sizerContainer.style.display = '';
      // HS-7826 — restore the grouping selector visibility (count-aware).
      if (dashboardState.active) requireHooks().refreshDashboardGroupingSelect();
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
    getColumnCount: () => getColumnCount(),
    onContextMenu: (entry, e) => { onTileContextMenu(entry, data.project.secret, e, { onTileMutated: requireHooks().refreshDashboardGrid }); },
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
    requireHooks().exitDashboard();
    void switchProject(data.project);
  });

  const grid = section.querySelector<HTMLElement>('.terminal-dashboard-grid');
  if (grid !== null) mountSectionGrid(grid, data, visible);

  const addBtn = section.querySelector<HTMLButtonElement>('.terminal-dashboard-add-terminal-btn');
  addBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void requireHooks().createDashboardTerminal(data.project.secret, data.terminals);
  });
  return section;
}
