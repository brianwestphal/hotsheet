import { SearchAddon } from '@xterm/addon-search';

import { apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import { restoreTicketList } from './dashboardMode.js';
import { closeDetail } from './detail.js';
import { toElement } from './dom.js';
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

/** Module-level slider value persists across enter / exit calls (resets on
 *  page reload). HS-7129 default = 33; lines up with three tiles per row on
 *  a typical laptop. */
let sliderValue = 33;

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
  // gain `.has-bell` (bounce + outline); others have it cleared.
  bellUnsubscribe = subscribeToBellState((state) => {
    for (const [secret, handle] of gridHandles.entries()) {
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
}

async function renderDashboardGrid(root: HTMLElement): Promise<void> {
  root.replaceChildren(toElement(<div className="terminal-dashboard-loading">Loading terminals…</div>));
  const sections = await fetchProjectSections();
  if (!active) return; // user exited during fetch
  root.replaceChildren();
  if (sections.length === 0) {
    root.appendChild(toElement(
      <div className="terminal-dashboard-empty">No registered projects.</div>
    ));
    return;
  }
  for (const section of sections) {
    root.appendChild(renderProjectSection(section));
  }
  // Re-run sizing after every section is appended — `renderProjectSection`'s
  // internal `handle.rebuild()` already called `applySizing()` once, but that
  // happened against a DETACHED grid container (clientWidth === 0) and
  // early-returned, leaving tiles with no preview dims. Now that every
  // section is in the document, walk all handles and size again.
  applyAllSizing();
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

function renderProjectSection(data: ProjectSectionData): HTMLElement {
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
    handle.rebuild(data.terminals.map(toTileEntry(data.project.secret)));
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
    const labelEl = document.querySelector<HTMLElement>(
      `.terminal-dashboard-tile[data-terminal-id="${CSS.escape(entry.id)}"] .terminal-dashboard-tile-label`,
    );
    if (labelEl !== null) {
      labelEl.textContent = resolved;
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
