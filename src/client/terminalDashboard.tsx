import { SearchAddon } from '@xterm/addon-search';

import { api, apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import {
  filterVisible as filterVisibleEntries,
  setTerminalHidden,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import { restoreTicketList } from './dashboardMode.js';
import { closeDetail } from './detail.js';
import { toElement } from './dom.js';
import { showHideTerminalDialog } from './hideTerminalDialog.js';
import type { ProjectInfo } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { subscribeToDefaultAppearanceChanges } from './terminalAppearance.js';
import {
  computeSliderSnapPoints,
  maybeSnapSliderValue,
  ROOT_PADDING,
  type SnapPoint,
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

/** Cross-section centered-tile coordination: which handle currently has a
 *  centered tile? When the user clicks a tile in section B while section A
 *  has one centered, we uncenter A first via the `onTileEnlarge` hook. */
let centeredHandle: TileGridHandle | null = null;

/** Search widget mounted in the app-header `#terminal-dashboard-search-slot`
 *  while a dedicated view is open. Disposed via the `onDedicatedBarMount`
 *  return-value disposer pattern. */
let dedicatedSearchHandle: TerminalSearchHandle | null = null;

let active = false;
let toggleButton: HTMLButtonElement | null = null;
let rootElement: HTMLElement | null = null;
let resizeHandler: (() => void) | null = null;
let resizeRaf: number | null = null;
let bellUnsubscribe: (() => void) | null = null;
let appearanceUnsubscribe: (() => void) | null = null;

let sizerContainer: HTMLElement | null = null;
let sizeSlider: HTMLInputElement | null = null;
let currentSnapPoints: SnapPoint[] = [];
/** HS-7661 — Show / Hide Terminals dialog opener for the global dashboard. */
let hideButton: HTMLButtonElement | null = null;
/** HS-7661 — last-fetched per-project section data, retained so the
 *  hide-state subscription can re-render without re-fetching `/projects`
 *  + per-project `/terminal/list` round-trips. */
let lastSectionData: ProjectSectionData[] = [];
/** HS-7661 — unsubscribe from hidden-state changes. Set on enterDashboard,
 *  cleared on exitDashboard. */
let hiddenChangeUnsubscribe: (() => void) | null = null;

/** Module-level slider value persists across enter / exit calls (resets on
 *  page reload). HS-7129 default = 33; lines up with three tiles per row on
 *  a typical laptop. */
let sliderValue = 33;

/** HS-7662 — layout mode for the dashboard grid. `'sectioned'` renders one
 *  `<section>` per project (the default §25.4 behaviour); `'flow'` renders
 *  every project's terminals as a single flat grid in registered-project
 *  order, with project-color badges to mark project boundaries. Persisted
 *  to `/file-settings` under `dashboard_layout_mode`. Default `'sectioned'`. */
type LayoutMode = 'sectioned' | 'flow';
let layoutMode: LayoutMode = 'sectioned';
let layoutToggleButton: HTMLButtonElement | null = null;
/** HS-7662 — cached layoutMode load promise, awaited inside
 *  `renderDashboardGrid` so the first paint always reflects the persisted
 *  mode (sectioned default never paints first then re-paints on fetch
 *  resolution). Subsequent calls return the cached promise. */
let layoutModeLoadPromise: Promise<void> | null = null;

export function initTerminalDashboard(): void {
  if (getTauriInvoke() === null) return;

  toggleButton = document.getElementById('terminal-dashboard-toggle') as HTMLButtonElement | null;
  rootElement = document.getElementById('terminal-dashboard-root');
  if (toggleButton === null || rootElement === null) return;

  toggleButton.style.display = '';
  toggleButton.addEventListener('click', () => {
    if (active) exitDashboard();
    else enterDashboard();
  });

  sizerContainer = document.getElementById('terminal-dashboard-sizer');
  sizeSlider = document.getElementById('terminal-dashboard-size-slider') as HTMLInputElement | null;
  hideButton = document.getElementById('terminal-dashboard-hide-btn') as HTMLButtonElement | null;
  layoutToggleButton = document.getElementById('terminal-dashboard-layout-toggle') as HTMLButtonElement | null;
  // HS-7662 — fire-and-forget eagerly load the persisted layout mode so the
  // first dashboard open paints the right layout without flicker. The fetch
  // is shared with /file-settings calls elsewhere on page load (api wraps
  // a single in-flight request when the cache is warm).
  void loadLayoutMode();
  layoutToggleButton?.addEventListener('click', () => {
    setLayoutMode(layoutMode === 'sectioned' ? 'flow' : 'sectioned');
  });
  // HS-7661 — open the "Show / Hide Terminals" dialog in global mode (every
  // project grouped). State changes fire the hidden-changes subscription
  // (registered on `enterDashboard`) which re-runs `applyHiddenFiltering`
  // so tiles disappear / reappear without a fetch round-trip.
  hideButton?.addEventListener('click', () => {
    showHideTerminalDialog({
      mode: 'global',
      groups: lastSectionData.map(s => ({
        secret: s.project.secret,
        name: s.project.name,
        terminals: s.terminals.map(t => ({ id: t.id, name: tileEntryLabel(t) })),
      })),
    });
  });
  sizeSlider?.addEventListener('input', () => {
    if (sizeSlider === null) return;
    const parsed = Number.parseFloat(sizeSlider.value);
    const rawValue = Number.isFinite(parsed) ? parsed : 33;
    const snapped = maybeSnapSliderValue(rawValue, currentSnapPoints);
    sliderValue = snapped;
    if (snapped !== rawValue) sizeSlider.value = String(snapped);
    if (active) applyAllSizing();
  });

  // Esc routing: dedicated → centered → bare-grid → exit.
  // Capture phase so we beat xterm's helper-textarea Escape handler.
  document.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key !== 'Escape') return;
    // HS-7661 — let the hide-terminal dialog consume Esc when open;
    // otherwise the dashboard handler exits dashboard mode before the
    // dialog has a chance to close.
    if (document.querySelector('.hide-terminal-dialog-overlay') !== null) return;
    // Dedicated view active in any handle?
    for (const handle of gridHandles.values()) {
      if (handle.isDedicatedOpen()) {
        // HS-7526 — if focus is in the search input, blur it instead of
        // exiting the dedicated view. After blurring, focus the dedicated
        // xterm so a SECOND Esc lands on the terminal-side keypress target
        // and exits the view normally. See docs/25-terminal-dashboard.md
        // §25.8.
        const activeEl = document.activeElement as HTMLElement | null;
        const searchSlot = document.getElementById('terminal-dashboard-search-slot');
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
    if (centeredHandle !== null) {
      e.preventDefault();
      e.stopPropagation();
      centeredHandle.uncenterTile();
      return;
    }
    e.preventDefault();
    exitDashboard();
  }, true);
}

export function isDashboardActive(): boolean {
  return active;
}

export function exitDashboard(): void {
  if (!active) return;
  active = false;
  document.body.classList.remove(BODY_CLASS);
  teardownAllHandles();
  if (rootElement !== null) {
    rootElement.style.display = 'none';
    rootElement.replaceChildren();
  }
  if (toggleButton !== null) toggleButton.classList.remove('active');
  if (sizerContainer !== null) sizerContainer.style.display = 'none';
  if (hideButton !== null) hideButton.style.display = 'none';
  if (layoutToggleButton !== null) layoutToggleButton.style.display = 'none';
  if (hiddenChangeUnsubscribe !== null) {
    hiddenChangeUnsubscribe();
    hiddenChangeUnsubscribe = null;
  }
  if (resizeHandler !== null) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (bellUnsubscribe !== null) {
    bellUnsubscribe();
    bellUnsubscribe = null;
  }
  if (appearanceUnsubscribe !== null) {
    appearanceUnsubscribe();
    appearanceUnsubscribe = null;
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

/** HS-7662 — load the persisted layout mode from `/file-settings` once and
 *  cache the resulting promise. Resolves silently on error so the dashboard
 *  still works when the settings endpoint is briefly unavailable. */
function loadLayoutMode(): Promise<void> {
  if (layoutModeLoadPromise !== null) return layoutModeLoadPromise;
  layoutModeLoadPromise = (async () => {
    try {
      const fs = await api<{ dashboard_layout_mode?: string }>('/file-settings');
      layoutMode = parseLayoutMode(fs.dashboard_layout_mode);
    } catch {
      layoutMode = 'sectioned';
    }
    applyLayoutToggleVisualState();
  })();
  return layoutModeLoadPromise;
}

/** HS-7662 — flip the layout mode and persist to `/file-settings`.
 *  Triggers a full re-render of the dashboard root if currently active so
 *  the user sees the new layout immediately. */
function setLayoutMode(next: LayoutMode): void {
  if (next === layoutMode) return;
  layoutMode = next;
  applyLayoutToggleVisualState();
  // Persist in the background — don't block the re-render on the network.
  void api('/file-settings', {
    method: 'PATCH',
    body: { dashboard_layout_mode: next },
  }).catch(() => { /* swallow — UI flip already happened */ });
  // Re-render with the cached section data when active so we don't
  // re-fetch /projects + /terminal/list on every toggle.
  if (active && rootElement !== null && lastSectionData.length > 0) {
    paintDashboardSections(rootElement, lastSectionData);
  }
}

function applyLayoutToggleVisualState(): void {
  if (layoutToggleButton === null) return;
  layoutToggleButton.classList.toggle('active', layoutMode === 'flow');
  layoutToggleButton.title = layoutMode === 'flow'
    ? 'Switch to sectioned layout'
    : 'Switch to flow layout';
}

function teardownAllHandles(): void {
  for (const handle of gridHandles.values()) handle.dispose();
  gridHandles.clear();
  centeredHandle = null;
  // Clear search slot if dedicated view was open at exit time.
  if (dedicatedSearchHandle !== null) {
    try { dedicatedSearchHandle.dispose(); } catch { /* ignore */ }
    dedicatedSearchHandle = null;
  }
  const searchSlot = document.getElementById('terminal-dashboard-search-slot');
  if (searchSlot !== null) {
    searchSlot.replaceChildren();
    searchSlot.style.display = 'none';
  }
}

function enterDashboard(): void {
  if (active) return;
  restoreTicketList();
  closeDetail();
  active = true;
  document.body.classList.add(BODY_CLASS);
  if (toggleButton !== null) toggleButton.classList.add('active');
  if (sizerContainer !== null) sizerContainer.style.display = '';
  if (hideButton !== null) hideButton.style.display = '';
  if (layoutToggleButton !== null) layoutToggleButton.style.display = '';
  applyLayoutToggleVisualState();
  if (sizeSlider !== null) sizeSlider.value = String(sliderValue);
  if (rootElement !== null) {
    rootElement.style.display = '';
    void renderDashboardGrid(rootElement);
  }
  resizeHandler = (): void => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      applyAllSizing();
      refreshSnapPointIndicators();
      // Re-center any centered tile against the new viewport.
      for (const handle of gridHandles.values()) handle.recenterTile();
    });
  };
  window.addEventListener('resize', resizeHandler);
  refreshSnapPointIndicators();

  // Cross-project bell long-poll subscription — forward filtered pending sets
  // to each per-project grid handle. Tiles whose terminalId is in the set
  // gain `.has-bell` (bounce + outline); others have it cleared. The
  // FLOW_HANDLE_KEY sentinel (HS-7662) gets the union of every project's
  // pending bells since flow mode renders one handle for every project's
  // tiles in a single grid.
  bellUnsubscribe = subscribeToBellState((state) => {
    for (const [secret, handle] of gridHandles.entries()) {
      if (secret === FLOW_HANDLE_KEY) {
        const allPending = new Set<string>();
        for (const entry of state.values()) {
          for (const id of entry.terminalIds) allPending.add(id);
        }
        handle.syncBellState(allPending);
        continue;
      }
      const entry = state.get(secret);
      const pendingIds = new Set(entry?.terminalIds ?? []);
      handle.syncBellState(pendingIds);
    }
  });

  // HS-6307 — re-render every tile when the project default appearance
  // changes. The shared module re-resolves appearance on next mount; for
  // already-mounted tiles we'd need a re-resolve hook on the handle. Simplest
  // is to dispose + rebuild the handle's tiles, which preserves the user's
  // centered / dedicated state because `rebuild` resets that anyway and the
  // user is changing project-default appearance from the Settings dialog
  // (which they wouldn't do mid-zoom). For now we just trigger a refresh.
  appearanceUnsubscribe = subscribeToDefaultAppearanceChanges(() => {
    refreshDashboardGrid();
  });

  // HS-7661 — re-render the sections (using cached lastSectionData) when
  // hidden-terminal state changes. No fetch round-trip; the subscription
  // fires after every `setTerminalHidden` / `unhideAll*` call.
  hiddenChangeUnsubscribe = subscribeToHiddenChanges(() => {
    if (!active || rootElement === null) return;
    paintDashboardSections(rootElement, lastSectionData);
  });
}

async function renderDashboardGrid(root: HTMLElement): Promise<void> {
  root.replaceChildren(toElement(<div className="terminal-dashboard-loading">Loading terminals…</div>));
  // HS-7662 — await both fetches in parallel. The layout-mode load is
  // typically resolved by initTerminalDashboard's eager call, so this is
  // usually instant.
  const [sections] = await Promise.all([fetchProjectSections(), loadLayoutMode()]);
  if (!active) return; // user exited during fetch
  lastSectionData = sections;
  paintDashboardSections(root, sections);
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

  if (layoutMode === 'flow') {
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
 *  feedback #5). The first tile of each project's run gets the project
 *  name as a label prefix; subsequent tiles in the same run get only a
 *  small project-color badge. No `+` button, no terminal-count headings,
 *  no per-section chrome (per user feedback #7 + §25.10.5 spec). */
function paintFlowLayout(root: HTMLElement, sections: ProjectSectionData[]): void {
  // Build flat tile list, marking first-of-run for each project.
  const flat: { secret: string; entry: TileEntry; project: ProjectInfo }[] = [];
  for (const section of sections) {
    const visible = filterVisibleEntries(section.project.secret, section.terminals);
    if (visible.length === 0) continue;
    const color = projectBadgeColor(section.project.secret);
    visible.forEach((terminal, index) => {
      const baseEntry = toTileEntry(section.project.secret)(terminal);
      const badge: { color: string; name?: string } = index === 0
        ? { color, name: section.project.name }
        : { color };
      flat.push({
        secret: section.project.secret,
        project: section.project,
        entry: { ...baseEntry, projectBadge: badge },
      });
    });
  }

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
    centerReferenceEl: rootElement ?? undefined,
    getSliderValue: () => sliderValue,
    onContextMenu: (entry, e) => {
      const project = projectFor(entry);
      if (project === null) return;
      onTileContextMenu(entry, project.secret, e);
    },
    onTileEnlarge: (_entry, target) => {
      if (target === 'center') centeredHandle = handle;
    },
    onTileShrink: () => {
      if (centeredHandle === handle && !handle.isCentered()) centeredHandle = null;
    },
    onDedicatedBarMount: (bar, entry, term) => {
      if (sizerContainer !== null) sizerContainer.style.display = 'none';
      if (layoutToggleButton !== null) layoutToggleButton.style.display = 'none';
      if (hideButton !== null) hideButton.style.display = 'none';
      const label = bar.querySelector<HTMLElement>('.terminal-dashboard-dedicated-label');
      const project = projectFor(entry);
      if (label !== null && project !== null) {
        const terminalLabel = entry.label;
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
      const search = new SearchAddon();
      term.loadAddon(search);
      const searchSlot = document.getElementById('terminal-dashboard-search-slot');
      let handleLocal: TerminalSearchHandle | null = null;
      if (searchSlot !== null) {
        handleLocal = mountTerminalSearch(term, search, { placeholder: `Search ${entry.label}` });
        searchSlot.replaceChildren(handleLocal.root);
        searchSlot.style.display = '';
        dedicatedSearchHandle = handleLocal;
      }
      return () => {
        try { handleLocal?.dispose(); } catch { /* ignore */ }
        if (searchSlot !== null) {
          searchSlot.replaceChildren();
          searchSlot.style.display = 'none';
        }
        dedicatedSearchHandle = null;
        if (sizerContainer !== null && active) sizerContainer.style.display = '';
        if (layoutToggleButton !== null && active) layoutToggleButton.style.display = '';
        if (hideButton !== null && active) hideButton.style.display = '';
      };
    },
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

/** HS-7662 — derive a stable color for a project's flow-mode badge from
 *  the project's secret. Same secret always produces the same hue, so
 *  badges remain consistent across reloads. HSL with fixed saturation +
 *  lightness for visual harmony. */
function projectBadgeColor(secret: string): string {
  let hash = 0;
  for (let i = 0; i < secret.length; i++) {
    hash = ((hash << 5) - hash) + secret.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

async function fetchProjectSections(): Promise<ProjectSectionData[]> {
  let projects: ProjectInfo[] = [];
  try {
    const res = await fetch('/api/projects');
    projects = await res.json() as ProjectInfo[];
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
    sections.push({ project, terminals });
  }
  return sections;
}

function renderProjectSection(data: ProjectSectionData, visibleTerminals?: TerminalListEntry[]): HTMLElement {
  // HS-7661 — `count` reflects all configured terminals (per user answer
  // #6: "should count all terminals, not just visible ones"); `visible` is
  // the filtered set used for the actual tile render. Default to the full
  // list when no filter is provided so older callsites keep working.
  const visible = visibleTerminals ?? data.terminals;
  const count = data.terminals.length;
  const headingText = count > 0
    ? `${data.project.name} (${count} ${count === 1 ? 'terminal' : 'terminals'})`
    : data.project.name;

  const section = toElement(
    <section className="terminal-dashboard-section" data-secret={data.project.secret}>
      <div className="terminal-dashboard-heading-row">
        <h2 className="terminal-dashboard-heading">{headingText}</h2>
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

  const grid = section.querySelector<HTMLElement>('.terminal-dashboard-grid');
  if (grid !== null) {
    const handle = mountTileGrid({
      container: grid,
      cssPrefix: 'terminal-dashboard',
      centerSizeFrac: 0.7,
      centerScope: 'viewport',
      centerReferenceEl: rootElement ?? undefined,
      getSliderValue: () => sliderValue,
      onContextMenu: (entry, e) => { onTileContextMenu(entry, data.project.secret, e); },
      onTileEnlarge: (_entry, target) => {
        // Cross-section coordination: only one tile centered globally.
        if (target === 'center') {
          // Uncenter any other handle's centered tile, then record this one.
          for (const [otherSecret, otherHandle] of gridHandles.entries()) {
            if (otherSecret === data.project.secret) continue;
            if (otherHandle.isCentered()) otherHandle.uncenterTile();
          }
          centeredHandle = handle;
        }
      },
      onTileShrink: () => {
        if (centeredHandle === handle && !handle.isCentered()) {
          centeredHandle = null;
        }
      },
      onDedicatedBarMount: (bar, entry, term) => {
        // Hide the slider, show the search slot, mount the search widget.
        if (sizerContainer !== null) sizerContainer.style.display = 'none';

        // Add the project breadcrumb to the bar (between Back and the label).
        // Append each breadcrumb span individually — the JSX runtime's Fragment
        // emits multiple top-level elements and `toElement` only returns the
        // first element child of its parsed template, so a `<>...</>` here
        // would silently drop the `›` separator and the terminal span.
        const label = bar.querySelector<HTMLElement>('.terminal-dashboard-dedicated-label');
        if (label !== null) {
          // Replace the bare terminal label with `Project › Terminal`. The
          // bar was just constructed with `entry.label` as the label child,
          // so we know what to render — re-use `entry.label` directly.
          const terminalLabel = entry.label;
          label.replaceChildren();
          label.appendChild(toElement(
            <span className="terminal-dashboard-dedicated-project">{data.project.name}</span>
          ));
          label.appendChild(toElement(
            <span className="terminal-dashboard-dedicated-sep">{'›'}</span>
          ));
          label.appendChild(toElement(
            <span className="terminal-dashboard-dedicated-terminal">{terminalLabel}</span>
          ));
        }

        const search = new SearchAddon();
        term.loadAddon(search);
        const searchSlot = document.getElementById('terminal-dashboard-search-slot');
        let handleLocal: TerminalSearchHandle | null = null;
        if (searchSlot !== null) {
          handleLocal = mountTerminalSearch(term, search, { placeholder: `Search ${entry.label}` });
          searchSlot.replaceChildren(handleLocal.root);
          searchSlot.style.display = '';
          dedicatedSearchHandle = handleLocal;
        }
        return () => {
          // Disposer: tear down the search widget + restore the slider.
          try { handleLocal?.dispose(); } catch { /* ignore */ }
          if (searchSlot !== null) {
            searchSlot.replaceChildren();
            searchSlot.style.display = 'none';
          }
          dedicatedSearchHandle = null;
          if (sizerContainer !== null && active) sizerContainer.style.display = '';
        };
      },
    });
    gridHandles.set(data.project.secret, handle);
    handle.rebuild(visible.map(toTileEntry(data.project.secret)));
  }

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
  if (!active || rootElement === null) return;
  teardownAllHandles();
  void renderDashboardGrid(rootElement);
}

// -----------------------------------------------------------------------------
// Slider snap-point indicators (HS-7271)
// -----------------------------------------------------------------------------

function refreshSnapPointIndicators(): void {
  if (sizerContainer === null || rootElement === null || sizeSlider === null) return;
  const rootWidth = rootElement.clientWidth - 2 * ROOT_PADDING;
  currentSnapPoints = computeSliderSnapPoints(rootWidth);

  let ticksEl = sizerContainer.querySelector<HTMLElement>('.terminal-dashboard-sizer-ticks');
  if (ticksEl === null) {
    ticksEl = document.createElement('div');
    ticksEl.className = 'terminal-dashboard-sizer-ticks';
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
    tick.className = 'terminal-dashboard-sizer-tick';
    tick.style.left = `${pt.sliderValue}%`;
    tick.title = `${pt.perRow} per row`;
    ticksEl.appendChild(tick);
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
      <div
        className={`context-menu-item${closeDisabled ? ' disabled' : ''}`}
        data-action="close"
        title={closeDisabled ? 'Configured terminals must be removed from Settings → Terminal' : undefined}
      >
        Close Tab
      </div>
      <div className="context-menu-separator"></div>
      <div className="context-menu-item" data-action="rename">Rename...</div>
      <div className="context-menu-separator"></div>
      {/* HS-7661 — hide this terminal from the dashboard. Session-only;
          state lives in dashboardHiddenTerminals.ts. The hidden-state
          subscription rebuilds the dashboard so the tile disappears
          immediately. */}
      <div className="context-menu-item" data-action="hide">Hide in Dashboard</div>
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
  document.querySelectorAll('.terminal-rename-overlay').forEach(el => el.remove());

  const overlay = toElement(
    <div className="cmd-editor-overlay terminal-rename-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>Rename Terminal</span>
          <button className="cmd-editor-close-btn" title="Close">{'×'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-field">
            <label>Tab name</label>
            <input type="text" className="term-rename-input" value={entry.label} />
            <span className="settings-hint">This rename is temporary — it doesn't change saved settings and resets on reload or project switch.</span>
          </div>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-cancel-btn">Cancel</button>
          <button className="btn btn-sm btn-primary cmd-editor-done-btn">Rename</button>
        </div>
      </div>
    </div>
  );

  const input = overlay.querySelector<HTMLInputElement>('.term-rename-input');
  if (input === null) { overlay.remove(); return; }

  const apply = (): void => {
    const next = input.value.trim();
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
    overlay.remove();
  };

  const cancel = (): void => { overlay.remove(); };

  overlay.querySelector('.cmd-editor-close-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-cancel-btn')?.addEventListener('click', cancel);
  overlay.querySelector('.cmd-editor-done-btn')?.addEventListener('click', apply);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) cancel(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); apply(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  });

  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
