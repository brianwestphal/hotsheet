import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import type { SafeHtml } from '../jsx-runtime.js';
import { apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import { restoreTicketList } from './dashboardMode.js';
import { closeDetail } from './detail.js';
import { toElement } from './dom.js';
import type { ProjectInfo } from './state.js';
import { getTauriInvoke, openExternalUrl } from './tauriIntegration.js';
import {
  computeTileScale,
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
  ROOT_PADDING,
  TILE_ASPECT,
  tileNativeGridFromCellMetrics,
  tileWidthFromSlider,
} from './terminalDashboardSizing.js';
import { applyDedicatedHistoryFrame, replayHistoryToTerm } from './terminalReplay.js';
import { readXtermTheme } from './xtermTheme.js';

/**
 * Terminal Dashboard — a second top-level client view (alongside the normal
 * per-project ticket view) that shows every configured terminal across every
 * registered project as a grid of live tiles. See docs/25-terminal-dashboard.md.
 *
 * HS-6832 scope — foundation only:
 *  - Toolbar toggle button (Tauri-only).
 *  - Enter / exit flag and CSS `body.terminal-dashboard-active` class.
 *  - Exit paths: click toggle again, Esc on the bare grid, click any project tab.
 *
 * Follow-up tickets wire the grid (HS-6833), live tiles (HS-6834), zoom (HS-6835),
 * dedicated view (HS-6836), bells (HS-6837), and placeholders (HS-6838).
 */

const BODY_CLASS = 'terminal-dashboard-active';

/** HS-6834: every dashboard tile mounts an xterm and scales visually via
 *  `transform: scale(s)` from its natural pixel size. We never send
 *  `?cols=&rows=` on the dashboard WebSocket so the first-attach cleanup
 *  (HS-6799) does not fire — the PTY is left at whatever dims the drawer /
 *  eager-spawn established.
 *
 *  HS-6965: initial dims are a brief placeholder — the xterm keeps them only
 *  until the server's history frame arrives and tells us the PTY's real
 *  cols × rows. At that point `connectTileSocket`'s message handler resizes
 *  the xterm to match the PTY so live bytes render at the dims they were
 *  formatted for. The earlier HS-6931 follow-up resized to a measured-cell
 *  4:3 target (1280 × 960) and then force-reset back to that target after
 *  the history replay, which left the xterm displaying PTY bytes at the
 *  wrong cols and caused awkward wrapping + a band of empty rows below the
 *  content. */
const DASHBOARD_INITIAL_COLS = DASHBOARD_FALLBACK_COLS;
const DASHBOARD_INITIAL_ROWS = DASHBOARD_FALLBACK_ROWS;

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
  /** HS-7065: set by `fetchProjectSections` from the list-response bucket the
   *  entry came from. True for dynamic terminals (created ad-hoc), false for
   *  configured terminals from settings.json. Closable vs. rename-only in the
   *  right-click context menu. */
  dynamic?: boolean;
}

interface DashboardTile {
  secret: string;
  terminalId: string;
  label: string;
  /** HS-7065: context-menu gating. Dynamic terminals (created via the
   *  drawer's `+` or the dashboard's §25.4 plus button) can be closed;
   *  configured terminals from settings.json can only be renamed. */
  dynamic: boolean;
  state: TerminalSessionState;
  exitCode: number | null;
  root: HTMLElement;
  preview: HTMLElement;
  labelEl: HTMLElement;
  term: XTerm | null;
  xtermRoot: HTMLElement | null;
  ws: WebSocket | null;
  /** Preview dims that `applyTileSizing()` last wrote for the grid slot.
   *  Persisted so uncentering can restore the same dimensions without
   *  re-running the full global sizing pass. */
  gridPreviewWidth: number;
  gridPreviewHeight: number;
  /** The xterm's current cols × rows. Seeded to the initial 80 × 60
   *  placeholder at mount time, then overwritten to tile-native 4:3 dims
   *  once xterm has laid out enough to report cell metrics. Held on the
   *  tile (rather than recomputed from cell metrics each time) so the
   *  exit-dedicated path can re-send the resize message without needing a
   *  fresh xterm-screen measurement.
   *
   *  HS-7097: the tile's history handler also pushes these dims to the
   *  server-side PTY via a 'resize' message — that was the missing piece in
   *  the previous attempts. Without resizing the PTY, a TUI like nano kept
   *  drawing for the drawer's wide-short geometry and the tile's xterm
   *  showed nano's footer at row 14-of-60 with rows 15-60 empty (HS-6965 /
   *  HS-7099 reverts both struggled with this same band of dead space).
   *  Driving the PTY makes nano SIGWINCH-redraw to fill the new geometry,
   *  same as the dedicated view already does via fit(). */
  targetCols: number;
  targetRows: number;
  /** HS-6867: while centered, a placeholder sits in the tile's original
   *  grid position so the rest of the grid doesn't reflow. The real tile
   *  is reparented to a fixed-position overlay that animates from the
   *  placeholder's position/size to the centered position/size. */
  slotPlaceholder: HTMLElement | null;
  /** HS-7097: observer on `.xterm-screen` so the tile's scale is re-applied
   *  every time xterm's renderer updates the screen's natural pixel dims.
   *  Previously the rescale was fired with two `requestAnimationFrame`s after
   *  `term.resize(..)`, but that raced xterm's own render scheduler — on a
   *  first-history-after-mount, both our rAFs could land before xterm's
   *  renderer had committed the new `.xterm-screen` inline width / height,
   *  so `applyTileScale` read pre-resize dims and built a scale for the old
   *  grid. The observer is authoritative: any change to `.xterm-screen`'s
   *  size (initial render, post-resize render, font-load reflow, whatever)
   *  triggers the rescale directly. */
  screenObserver: ResizeObserver | null;
}

const liveTiles = new Map<string, DashboardTile>();
const tileKey = (secret: string, terminalId: string) => `${secret}::${terminalId}`;

/** HS-6835: currently-zoomed tile (the "center overlay" state). */
let centeredTile: DashboardTile | null = null;
/** The backdrop DOM element while a tile is centered. */
let centerBackdrop: HTMLElement | null = null;

/** HS-6836: dedicated-view state. When non-null, the dashboard content area is
 *  replaced with a full-viewport pane showing one terminal's live xterm. */
interface DedicatedView {
  tile: DashboardTile;
  overlay: HTMLElement;
  term: XTerm;
  fit: FitAddon;
  ws: WebSocket | null;
  /** ResizeObserver re-fitting xterm to the dedicated body on window
   *  resize (HS-6898). Disconnected in `exitDedicatedView`. */
  bodyResizeObserver: ResizeObserver | null;
  /** The state to return to when the dedicated view is dismissed (grid or
   *  centered). `Back` / `Esc` restore this; the dashboard toggle / project
   *  tab click route through `exitDashboard()` which disposes everything. */
  priorCenteredTile: DashboardTile | null;
}
let dedicatedView: DedicatedView | null = null;

export interface ProjectSectionData {
  project: ProjectInfo;
  terminals: TerminalListEntry[];
}

let active = false;
let toggleButton: HTMLButtonElement | null = null;
let rootElement: HTMLElement | null = null;
let resizeHandler: (() => void) | null = null;
let resizeRaf: number | null = null;
/** HS-6837: subscription handle for the cross-project bell long-poll (§24). */
let bellUnsubscribe: (() => void) | null = null;
/** HS-7031: DOM refs for the manual size slider. Shown only while the
 *  dashboard is active (the CSS sizer container toggles `display` on enter
 *  / exit), defaults to the middle of its range. */
let sizerContainer: HTMLElement | null = null;
let sizeSlider: HTMLInputElement | null = null;
/** Last slider value applied — survives between enter / exit calls so the
 *  user's preferred tile size sticks in-session (reset on page reload).
 *  HS-7129: default is 33 — the previous 50 midpoint produced tiles big
 *  enough that only 1-2 fit per row on a typical laptop, defeating the
 *  dashboard's "see every terminal at a glance" purpose. 33 lines up with
 *  three tiles across the typical root width. */
let sliderValue = 33;

export function initTerminalDashboard(): void {
  // Tauri-only gate — the terminal feature (§22.11) is desktop-only, and the
  // dashboard is a view over those terminals, so it follows the same rule.
  if (getTauriInvoke() === null) return;

  toggleButton = document.getElementById('terminal-dashboard-toggle') as HTMLButtonElement | null;
  rootElement = document.getElementById('terminal-dashboard-root');
  if (toggleButton === null || rootElement === null) return;

  toggleButton.style.display = '';
  toggleButton.addEventListener('click', () => {
    if (active) exitDashboard();
    else enterDashboard();
  });

  // HS-7031: wire up the size slider. It lives in the app-header (rendered
  // into pages.tsx with display:none) so it stays next to the project-tab
  // strip — we just toggle visibility + react to `input` events while the
  // dashboard is active.
  sizerContainer = document.getElementById('terminal-dashboard-sizer');
  sizeSlider = document.getElementById('terminal-dashboard-size-slider') as HTMLInputElement | null;
  sizeSlider?.addEventListener('input', () => {
    if (sizeSlider === null) return;
    const parsed = Number.parseInt(sizeSlider.value, 10);
    sliderValue = Number.isFinite(parsed) ? parsed : 33;
    if (active && rootElement !== null) applyTileSizing(rootElement);
  });

  // Esc routing:
  //  - If a tile is centered (HS-6835) → collapse back to the grid, do NOT exit.
  //  - Else if a dedicated view is mounted (HS-6836) → collapse that first.
  //  - Else exit the dashboard entirely.
  //
  // Capture phase is required because xterm.js attaches its own keydown
  // handler on the xterm root and swallows Escape when the helper textarea
  // has focus. Listening on document in the capture phase fires before xterm.
  document.addEventListener('keydown', (e) => {
    if (!active) return;
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
    e.preventDefault();
    exitDashboard();
  }, true);
}

export function isDashboardActive(): boolean {
  return active;
}

/**
 * Exit the dashboard if it is active. Safe to call unconditionally.
 * Used by the project-tab click handler (per §25.3 rule 3: clicking a project
 * tab auto-exits the dashboard and activates that project's ticket view).
 */
export function exitDashboard(): void {
  if (!active) return;
  active = false;
  document.body.classList.remove(BODY_CLASS);
  teardownAllTiles();
  if (rootElement !== null) {
    rootElement.style.display = 'none';
    rootElement.replaceChildren();
  }
  if (toggleButton !== null) toggleButton.classList.remove('active');
  // HS-7031: hide the slider again — it's a dashboard-only control.
  if (sizerContainer !== null) sizerContainer.style.display = 'none';
  if (resizeHandler !== null) {
    window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
  }
  if (bellUnsubscribe !== null) {
    bellUnsubscribe();
    bellUnsubscribe = null;
  }
}

function teardownAllTiles(): void {
  // HS-6836: dedicated view teardown — dispose its own xterm + WebSocket.
  // priorCenteredTile is ignored because exitDashboard() is wiping state.
  if (dedicatedView !== null) {
    dedicatedView.bodyResizeObserver?.disconnect();
    try { dedicatedView.ws?.close(); } catch { /* already closed */ }
    try { dedicatedView.term.dispose(); } catch { /* no-op */ }
    dedicatedView.overlay.remove();
    dedicatedView = null;
  }
  if (centeredTile !== null) {
    // HS-6867: clean up the grid-slot placeholder before wiping centered
    // state; the DOM around it is going away anyway, but leaving a dangling
    // placeholder here would hold a reference past teardown.
    if (centeredTile.slotPlaceholder !== null) {
      centeredTile.slotPlaceholder.remove();
      centeredTile.slotPlaceholder = null;
    }
    centeredTile.root.classList.remove('centered');
    centeredTile.root.style.transition = '';
    centeredTile.root.style.transform = '';
    centeredTile = null;
  }
  removeCenterBackdrop();
  for (const tile of liveTiles.values()) {
    disposeTile(tile);
  }
  liveTiles.clear();
}

function disposeTile(tile: DashboardTile): void {
  if (tile.screenObserver !== null) {
    tile.screenObserver.disconnect();
    tile.screenObserver = null;
  }
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

function enterDashboard(): void {
  if (active) return;
  restoreTicketList();
  closeDetail();
  active = true;
  document.body.classList.add(BODY_CLASS);
  if (toggleButton !== null) toggleButton.classList.add('active');
  // HS-7031: reveal the slider + reflect the remembered session-scope value.
  if (sizerContainer !== null) sizerContainer.style.display = '';
  if (sizeSlider !== null) sizeSlider.value = String(sliderValue);
  if (rootElement !== null) {
    rootElement.style.display = '';
    void renderDashboardGrid(rootElement);
  }
  resizeHandler = () => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (rootElement !== null) applyTileSizing(rootElement);
      // HS-6964: re-center the currently-zoomed tile (if any) so it stays
      // centered in the new viewport instead of anchored to the left / top
      // it was placed at when `centerTile` first ran.
      if (centeredTile !== null) recenterTile(centeredTile);
    });
  };
  window.addEventListener('resize', resizeHandler);

  // HS-6837: react to cross-project bell state so the dashboard tile shows
  // a bounce + persistent outline the moment a bell fires in ANY terminal,
  // even terminals that haven't been attached yet.
  bellUnsubscribe = subscribeToBellState((state) => {
    for (const [key, tile] of liveTiles) {
      const entry = state.get(tile.secret);
      const pending = entry?.terminalIds.includes(tile.terminalId) ?? false;
      const hadBell = tile.root.classList.contains('has-bell');
      if (pending && !hadBell) markTileBell(tile);
      else if (!pending && hadBell) tile.root.classList.remove('has-bell');
      void key; // silence noUnusedParameters in destructure
    }
  });
}

/**
 * HS-6833: render the per-project sectioned grid. Fetches the project list
 * and every project's `/api/terminal/list`, then materializes sections with
 * tile placeholders + centered labels. Live xterm canvases in the tiles are
 * owned by HS-6834; here we only emit skeleton placeholder elements.
 */
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
  applyTileSizing(root);
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
      // HS-7065: tag each entry with which bucket it came from so the tile's
      // context menu knows whether Close Tab is allowed (dynamic only).
      terminals = [
        ...listed.configured.map(t => ({ ...t, dynamic: false })),
        ...listed.dynamic.map(t => ({ ...t, dynamic: true })),
      ];
    } catch { /* project's terminal list unavailable — render empty section */ }
    sections.push({ project, terminals });
  }
  return sections;
}

function renderProjectSection(data: ProjectSectionData): HTMLElement {
  const count = data.terminals.length;
  const headingText = count > 0
    ? `${data.project.name} (${count} ${count === 1 ? 'terminal' : 'terminals'})`
    : data.project.name;

  // HS-7064: a lucide `plus` button sits in the heading row for each project
  // so the user can create a new terminal for that project without leaving
  // the dashboard. Uses the existing POST /api/terminal/create path (dynamic
  // terminal) — same endpoint as the drawer's `+` button, but HS-7228 asks
  // the server to spawn the PTY immediately so the new tile lands as a live
  // preview rather than a cold placeholder.
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
    for (const terminal of data.terminals) {
      grid.appendChild(renderTile(data.project.secret, terminal));
    }
  }

  const addBtn = section.querySelector<HTMLButtonElement>('.terminal-dashboard-add-terminal-btn');
  addBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    void createDashboardTerminal(data.project.secret);
  });
  return section;
}

/**
 * HS-7064 / HS-7228: create a dynamic terminal via the project's
 * `/api/terminal/create` endpoint, then rebuild the dashboard so the new
 * tile appears in the section. No prompt, uses the default shell.
 *
 * HS-7228: passes `spawn: true` so the server launches the PTY synchronously
 * during the create call. The drawer's `+` button gets its eager-spawn for
 * free because it `selectDrawerTab`s the new tab (which attaches a WS and
 * triggers the spawn); the dashboard has no such follow-up attach (tiles
 * render from the `/terminal/list` response alone), so without explicit
 * spawn the new tile would render as a `not_spawned` placeholder and the
 * user would have to click it to get a running shell — that's the gap
 * HS-7228 closes.
 */
async function createDashboardTerminal(secret: string): Promise<void> {
  try {
    await apiWithSecret<{ config: { id: string } }>('/terminal/create', secret, {
      method: 'POST',
      body: { spawn: true },
    });
  } catch (err) {
    console.error('terminalDashboard: create terminal failed', err);
    return;
  }
  refreshDashboardGrid();
}

/**
 * Dispose every live tile and re-fetch the full project / terminal list.
 * Used after terminal lifecycle changes that add or remove tiles (HS-7064
 * add, HS-7065 close). Keeps the disposal path aligned with `exitDashboard`
 * so WebSockets and xterm instances don't leak.
 */
function refreshDashboardGrid(): void {
  if (!active || rootElement === null) return;
  // HS-6867 / HS-6835: if a tile is currently centered, drop it back into the
  // grid first so the placeholder / fixed-position state doesn't survive the
  // dispose-and-rerender.
  if (centeredTile !== null) {
    if (centeredTile.slotPlaceholder !== null) {
      centeredTile.slotPlaceholder.remove();
      centeredTile.slotPlaceholder = null;
    }
    centeredTile.root.classList.remove('centered');
    centeredTile.root.style.transition = '';
    centeredTile.root.style.transform = '';
    centeredTile = null;
    removeCenterBackdrop();
  }
  for (const tile of liveTiles.values()) disposeTile(tile);
  liveTiles.clear();
  void renderDashboardGrid(rootElement);
}

/**
 * HS-6834: construct the per-terminal tile. For `alive` terminals, mount an
 * xterm at 80 × 60, open a WebSocket, replay history, and stream live bytes.
 * For `not_spawned` / `exited` terminals, leave a placeholder element in
 * place — HS-6838 will populate it with a spawn-on-click affordance.
 */
function renderTile(secret: string, terminal: TerminalListEntry): HTMLElement {
  const label = tileLabel(terminal);
  const state: TerminalSessionState = terminal.state ?? 'not_spawned';
  const exitCode = terminal.exitCode ?? null;
  const tileRoot = toElement(
    <div
      className={`terminal-dashboard-tile terminal-dashboard-tile-${state}`}
      data-secret={secret}
      data-terminal-id={terminal.id}
    >
      <div className="terminal-dashboard-tile-preview">
        {renderTilePreviewContent(state, exitCode)}
      </div>
      <div className="terminal-dashboard-tile-label" title={label}>{label}</div>
    </div>
  );
  const preview = tileRoot.querySelector<HTMLElement>('.terminal-dashboard-tile-preview');
  const labelEl = tileRoot.querySelector<HTMLElement>('.terminal-dashboard-tile-label');
  if (preview === null || labelEl === null) return tileRoot;

  const tile: DashboardTile = {
    secret,
    terminalId: terminal.id,
    label,
    dynamic: terminal.dynamic === true,
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
    targetCols: DASHBOARD_INITIAL_COLS,
    targetRows: DASHBOARD_INITIAL_ROWS,
    slotPlaceholder: null,
    screenObserver: null,
  };
  liveTiles.set(tileKey(secret, terminal.id), tile);

  if (state === 'alive') {
    mountTileXterm(tile);
    connectTileSocket(tile);
  }
  // HS-6835 / HS-6836 / HS-6838: click centers (or spawns+centers for
  // placeholders), dblclick enters dedicated (or spawns+enters for
  // placeholders). Handlers live on the tile root so they still fire when
  // xterm's child has pointer-events: none in grid view.
  tileRoot.addEventListener('click', (e) => { onTileClick(tile, e); });
  tileRoot.addEventListener('dblclick', (e) => { onTileDblClick(tile, e); });
  // HS-7065: right-click opens a small context menu with Close Tab (dynamic
  // terminals only) and Rename... — same operations as the drawer's tab
  // context menu minus the close-left / close-right options that don't map
  // to a 2D grid layout.
  tileRoot.addEventListener('contextmenu', (e) => { onTileContextMenu(tile, e); });
  return tileRoot;
}

function renderTilePreviewContent(state: TerminalSessionState, exitCode: number | null): SafeHtml {
  if (state === 'alive') {
    return <div className="terminal-dashboard-tile-placeholder"></div>;
  }
  const status = state === 'exited'
    ? (exitCode === null ? 'Exited' : `Exited (code ${exitCode})`)
    : 'Not yet started';
  return (
    <div className="terminal-dashboard-tile-placeholder terminal-dashboard-tile-placeholder-cold">
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
      <span className="terminal-dashboard-tile-placeholder-status">{status}</span>
    </div>
  );
}

/**
 * HS-6837: mark a tile as bell-pending. Adds a `.has-bell` class which drives
 * a one-shot bounce keyframe + persistent outline in CSS. Idempotent —
 * re-applying the class does not re-trigger the animation (CSS handles that
 * via `animation-iteration-count: 1`).
 */
function markTileBell(tile: DashboardTile): void {
  if (tile.root.classList.contains('has-bell')) return;
  tile.root.classList.add('has-bell');
}

/** Clear the bell outline on a tile and drop the server-side `bellPending`
 *  flag via `POST /api/terminal/clear-bell`. Fire-and-forget; the long-poll
 *  will sync any other dashboards on its next tick. */
function clearTileBell(tile: DashboardTile): void {
  if (!tile.root.classList.contains('has-bell')) return;
  tile.root.classList.remove('has-bell');
  void apiWithSecret('/terminal/clear-bell', tile.secret, {
    method: 'POST',
    body: { terminalId: tile.terminalId },
  }).catch(() => { /* server restart / network blip — bell state will resync via long-poll */ });
}

/**
 * Read xterm's measured cell metrics off `.xterm-screen` and return tile-
 * native 4:3 cols × rows for the tile's xterm. Returns null if xterm hasn't
 * laid out yet (no `.xterm-screen` child, or zero / non-finite measured
 * dims) — caller should skip the resize and let the next mount / render
 * tick try again. The `.xterm-screen` inline width is xterm's own
 * `cols * cellWidth`, so dividing by the current cols/rows recovers the
 * measured cell pixels directly (HS-7097 follow-up).
 */
function tileNativeDimsFromXterm(term: XTerm, xtermRoot: HTMLElement): { cols: number; rows: number } | null {
  const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  if (screen === null) return null;
  if (term.cols <= 0 || term.rows <= 0) return null;
  const cellW = screen.offsetWidth / term.cols;
  const cellH = screen.offsetHeight / term.rows;
  if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return null;
  return tileNativeGridFromCellMetrics(cellW, cellH);
}

/**
 * Re-run the scale pass using the preview's current dimensions. Called after
 * the xterm's cols × rows changes (e.g., history-frame replay in
 * `connectTileSocket` resizes to PTY dims) so the xterm root's inline
 * width / height / transform reflect the new natural dims. Using
 * `tile.preview.offsetWidth / offsetHeight` handles both the grid-view case
 * (`applyTileSizing` wrote dims on the preview) and the centered-tile case
 * (`centerTile` writes dims on the preview).
 */
function reapplyTileScaleFromPreview(tile: DashboardTile): void {
  if (tile.xtermRoot === null) return;
  const previewWidth = tile.preview.offsetWidth;
  const previewHeight = tile.preview.offsetHeight;
  if (previewWidth <= 0 || previewHeight <= 0) return;
  applyTileScale(tile.xtermRoot, previewWidth, previewHeight);
}

function mountTileXterm(tile: DashboardTile): void {
  const xtermRoot = document.createElement('div');
  xtermRoot.className = 'terminal-dashboard-tile-xterm';
  // Replace the placeholder stub.
  tile.preview.replaceChildren(xtermRoot);

  const term = new XTerm({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: false,
    scrollback: 0,
    allowProposedApi: true,
    cols: DASHBOARD_INITIAL_COLS,
    rows: DASHBOARD_INITIAL_ROWS,
    // HS-6866: match the drawer terminal's theme so the tile's xterm canvas
    // picks up --bg / --text / --accent instead of xterm's default black
    // palette.
    theme: readXtermTheme(),
    // HS-7263: OSC 8 hyperlinks in tile previews. Mostly a no-op because the
    // tile is scaled + non-interactive by default, but a tile a user has
    // centered / zoomed into is clickable and should honour hyperlinks.
    linkHandler: {
      activate: (_event, text) => { openExternalUrl(text); },
    },
  });
  term.open(xtermRoot);
  // Seed target dims at the initial grid; the WebSocket's history frame will
  // overwrite them in `connectTileSocket` so they match the PTY (HS-6965).
  tile.targetCols = term.cols;
  tile.targetRows = term.rows;

  // HS-7097: observe `.xterm-screen` so every xterm render (initial mount,
  // post-`term.resize()`, post-history-replay, post-font-load — whatever
  // changes the screen element's inline width / height) automatically
  // re-runs the scale pass. Replaces the earlier rAF-chain in
  // `connectTileSocket` / `exitDedicatedView` which raced xterm's own render
  // scheduler and occasionally fired before `.xterm-screen`'s new dims had
  // been committed, leaving the tile scale pinned to the pre-resize grid.
  const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  if (screen !== null) {
    const observer = new ResizeObserver(() => { reapplyTileScaleFromPreview(tile); });
    observer.observe(screen);
    tile.screenObserver = observer;
  }
  // Kick off the initial scale once xterm has committed `.xterm-screen`'s
  // initial dimensions. The observer below will also pick up that first
  // render, but the explicit rAF keeps the behaviour deterministic for tests
  // / short-lived tiles that might not survive until the observer callback.
  requestAnimationFrame(() => {
    // HS-7097 follow-up: resize the xterm down to tile-native 4:3 dims so the
    // pre-history placeholder (80 × 60 = 2:3 natural) renders at the tile's
    // 4:3 aspect instead of showing horizontal letterboxing. `.xterm-screen`'s
    // ResizeObserver below will pick up the post-resize render and run the
    // scale pass authoritatively.
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

  // HS-6835: wire keystrokes to the WebSocket. Grid-view tiles can't focus
  // (pointer-events: none + hidden helper textarea), so this only fires while
  // the tile is centered or in dedicated view (HS-6836).
  const encoder = new TextEncoder();
  term.onData((data) => {
    if (tile.ws !== null && tile.ws.readyState === WebSocket.OPEN) {
      tile.ws.send(encoder.encode(data));
    }
  });

  // HS-6837: live-bell hook so same-project bells fire the bounce + outline
  // even before the bellPoll tick arrives. The long-poll subscriber also
  // keeps state in sync for bells fired in projects whose tiles have no
  // WebSocket yet (lazy / exited) or where the terminal isn't mounted.
  term.onBell(() => { markTileBell(tile); });

  tile.term = term;
  tile.xtermRoot = xtermRoot;
}

function connectTileSocket(tile: DashboardTile): void {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // HS-6834: omit `?cols=&rows=` so the server does NOT run the first-attach
  // cleanup (HS-6799). The dashboard tile is a peek view; other attachers
  // (the drawer, other windows) have already established the session geometry.
  const url = `${protocol}//${window.location.host}/api/terminal/ws`
    + `?project=${encodeURIComponent(tile.secret)}`
    + `&terminal=${encodeURIComponent(tile.terminalId)}`;
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
        if (msg.type === 'history' && typeof msg.bytes === 'string' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          replayHistoryToTerm(tile.term, { bytes: msg.bytes, cols: msg.cols, rows: msg.rows });
          // HS-7097 follow-up: after replaying scrollback at the PTY's cols ×
          // rows (so the bytes render in the geometry they were formatted
          // for), resize BOTH the local xterm AND the server-side PTY to the
          // tile-native 4:3 dims. The PTY resize is essential — without it,
          // a drawer-attached PTY at wide-short dims (e.g. 14 × 197) keeps
          // sending bytes formatted for that geometry, so the tile's xterm
          // shows nano's footer at row 14 of a 60-row buffer with rows 15-60
          // empty (the bug from HS-7097's screenshots). Pushing the PTY to
          // tile-native 4:3 fires SIGWINCH at the running TUI; nano / vim /
          // less / etc. then redraw to fill the new geometry, and the tile
          // shows a usable, aspect-correct preview.
          //
          // This intentionally drives the PTY just like the dedicated view
          // does (enterDedicatedView sends a 'resize' message after fit()).
          // When the user is on the dashboard, dashboard tiles win the
          // resize war; when they switch back to the drawer, the drawer's
          // own fit() resizes the PTY back to drawer dims.
          //
          // The `.xterm-screen` ResizeObserver in `mountTileXterm` picks up
          // both the local resize and the post-SIGWINCH redraw and re-runs
          // the scale pass, so the visible scale stays in sync.
          if (tile.xtermRoot !== null) {
            const native = tileNativeDimsFromXterm(tile.term, tile.xtermRoot);
            if (native !== null) {
              try { tile.term.resize(native.cols, native.rows); } catch { /* xterm disposed under us */ }
              tile.targetCols = native.cols;
              tile.targetRows = native.rows;
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'resize', cols: native.cols, rows: native.rows }));
              }
            }
          }
        }
      } catch { /* non-JSON control frame — ignore */ }
    }
  });
  ws.addEventListener('close', () => { tile.ws = null; });
  ws.addEventListener('error', () => { tile.ws = null; });
}

/**
 * HS-6835: single-click on a live tile animates it to a ~70% viewport centered
 * overlay, dims the rest of the grid, and focuses the xterm for keyboard input.
 * Clicking the same centered tile, the dim backdrop, or pressing Esc returns
 * the tile to its grid slot. Clicking a DIFFERENT tile swaps the center.
 */
/**
 * HS-6835 + HS-6836: a single click centers the tile; a double-click enters
 * the dedicated view. To reliably distinguish the two without one interfering
 * with the other, the single-click action is deferred by `SINGLE_CLICK_DELAY`
 * ms and is cancelled if a dblclick event arrives first. A pure `e.detail`
 * check doesn't work here because the tile's position changes mid-gesture
 * (the first click centers it via CSS transition) which confuses the
 * browser's dblclick hit-testing.
 */
const SINGLE_CLICK_DELAY_MS = 220;
let pendingSingleClickTimer: number | null = null;

function onTileClick(tile: DashboardTile, e: MouseEvent): void {
  e.stopPropagation();
  // Queue the single-click action; dblclick will cancel it if it fires in time.
  if (pendingSingleClickTimer !== null) {
    window.clearTimeout(pendingSingleClickTimer);
  }
  pendingSingleClickTimer = window.setTimeout(() => {
    pendingSingleClickTimer = null;
    // HS-6838: placeholder tile → spawn then transition to centered view.
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

function onTileDblClick(tile: DashboardTile, e: MouseEvent): void {
  e.stopPropagation();
  e.preventDefault();
  if (pendingSingleClickTimer !== null) {
    window.clearTimeout(pendingSingleClickTimer);
    pendingSingleClickTimer = null;
  }
  // HS-6838: placeholder tile → spawn then transition to dedicated view.
  if (tile.state !== 'alive') {
    void spawnAndEnlarge(tile, 'dedicated');
    return;
  }
  const prior = centeredTile === tile ? null : centeredTile;
  if (centeredTile === tile) uncenterTile();
  try {
    enterDedicatedView(tile, prior);
  } catch (err) {
    console.error('terminalDashboard: enterDedicatedView failed', err);
  }
}

/**
 * HS-6838: spawn a lazy / exited terminal, swap its placeholder for a live
 * xterm, and transition to the requested view (center or dedicated). For
 * exited terminals we POST /api/terminal/restart first so the server tears
 * down the old session and starts a fresh PTY; for never-spawned lazy
 * terminals the first WebSocket attach alone triggers the spawn.
 */
async function spawnAndEnlarge(tile: DashboardTile, target: 'center' | 'dedicated'): Promise<void> {
  const wasExited = tile.state === 'exited';

  // Swap placeholder content for a "Starting..." state so the user sees
  // feedback while the server spawns the PTY.
  tile.preview.replaceChildren(toElement(
    <div className="terminal-dashboard-tile-placeholder terminal-dashboard-tile-placeholder-starting">
      <span>Starting…</span>
    </div>
  ));

  try {
    if (wasExited) {
      await apiWithSecret('/terminal/restart', tile.secret, {
        method: 'POST',
        body: { terminalId: tile.terminalId },
      });
    }
    tile.state = 'alive';
    tile.exitCode = null;
    tile.root.classList.remove('terminal-dashboard-tile-not_spawned', 'terminal-dashboard-tile-exited');
    tile.root.classList.add('terminal-dashboard-tile-alive');
    mountTileXterm(tile);
    connectTileSocket(tile);
  } catch (err) {
    console.error('terminalDashboard: spawn failed', err);
    // Restore the placeholder so the user can try again.
    tile.preview.replaceChildren(toElement(renderTilePreviewContent(tile.state, tile.exitCode)));
    return;
  }

  if (target === 'center') centerTile(tile);
  else enterDedicatedView(tile, null);
}

/**
 * HS-6836: replace the dashboard content area with a full-viewport pane for
 * this single terminal. Mounts a fresh xterm instance (separate from the
 * grid tile's xterm) with FitAddon, attaches a new WebSocket with real cols
 * and rows so the server-side PTY can grow to match, and gives keyboard
 * focus to the xterm helper textarea on enter.
 */
function enterDedicatedView(tile: DashboardTile, priorCenteredTile: DashboardTile | null): void {
  if (dedicatedView !== null) exitDedicatedView();
  if (rootElement === null) return;
  // HS-6837: entering the dedicated view also clears the bell.
  clearTileBell(tile);
  // HS-7195: hide the tile-size slider while the dedicated view is up — the
  // slider only controls grid-tile dims (§25.4) and is irrelevant to a
  // single full-viewport terminal. `exitDedicatedView` restores it.
  if (sizerContainer !== null) sizerContainer.style.display = 'none';

  const projectLabel = rootElement.querySelector<HTMLElement>(`.terminal-dashboard-section[data-secret="${tile.secret}"] .terminal-dashboard-heading`)
    ?.textContent
    ?? '';

  const overlay = toElement(
    <div className="terminal-dashboard-dedicated" data-secret={tile.secret} data-terminal-id={tile.terminalId}>
      <div className="terminal-dashboard-dedicated-bar">
        <button className="terminal-dashboard-dedicated-back" title="Back to dashboard">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
          <span>Back</span>
        </button>
        <div className="terminal-dashboard-dedicated-label">
          <span className="terminal-dashboard-dedicated-project">{projectLabel}</span>
          <span className="terminal-dashboard-dedicated-sep">{'›'}</span>
          <span className="terminal-dashboard-dedicated-terminal">{tile.label}</span>
        </div>
      </div>
      <div className="terminal-dashboard-dedicated-body">
        {/* HS-7098: the xterm is opened inside this inner `-pane` wrapper, not
         *  directly in `-body`. FitAddon reads `getComputedStyle(parent).height
         *  / width` to decide cols × rows; `box-sizing: border-box` (app-wide
         *  reset) makes those values include the parent's padding, so putting
         *  padding on the xterm's direct parent made fit overcount the
         *  available space by `padding * 2` and the bottom rows got clipped
         *  off-screen. Structure it so padding lives on `-body` (visual frame)
         *  and the xterm's direct parent `-pane` has none — fit now sees the
         *  real available space and the full content fits inside the 16 px
         *  frame on all four sides. */}
        <div className="terminal-dashboard-dedicated-pane"></div>
      </div>
    </div>
  );
  rootElement.appendChild(overlay);

  const pane = overlay.querySelector<HTMLElement>('.terminal-dashboard-dedicated-pane');
  const backBtn = overlay.querySelector<HTMLElement>('.terminal-dashboard-dedicated-back');
  if (pane === null || backBtn === null) return;
  backBtn.addEventListener('click', () => { exitDedicatedView(); });

  const term = new XTerm({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
    // HS-6866: same theme as the drawer / tile xterms.
    theme: readXtermTheme(),
    // HS-7263: OSC 8 hyperlinks. The dedicated view is fully interactive —
    // same link-activation behaviour as the drawer xterm so `gh pr list` /
    // `delta` / etc. hyperlinks open in an external browser.
    linkHandler: {
      activate: (_event, text) => { openExternalUrl(text); },
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // HS-7263 — dashboard dedicated view also routes plain URLs through the
  // Tauri-safe openExternalUrl helper. Matches the drawer behaviour.
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
  term.open(pane);
  // HS-6898: defer the initial fit so the flex-1 body has its final size in
  // layout before fit() reads dimensions. Without this, fit() can measure a
  // pre-layout size and leave xterm at its default 80 cols — exactly the
  // wrong-width regression from the bug report. ResizeObserver keeps the
  // fit in sync on window resizes while the dedicated view is open.
  const runFit = (): void => {
    try { fit.fit(); } catch { /* pane not ready yet */ }
  };
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
    // HS-7097 follow-up: the grid tile's xterm stays pinned to its own
    // tile-native 4:3 dims throughout the dedicated view's lifetime. Mirroring
    // the dedicated view's fit() geometry onto the tile (as HS-7099 did) meant
    // the tile's natural aspect tracked whatever wide / short geometry the
    // dedicated pane landed on, which is exactly what left the grid tile's
    // 4:3 frame with a band of vertical dead space below the content. Live
    // bytes broadcast by the server at the dedicated view's new dims now
    // wrap inside the tile's narrower xterm buffer — accepted trade-off for
    // an aspect-correct preview (see `DashboardTile.targetCols` JSDoc).
  });

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}/api/terminal/ws`
    + `?project=${encodeURIComponent(tile.secret)}`
    + `&terminal=${encodeURIComponent(tile.terminalId)}`
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
        if (msg.type === 'history' && typeof msg.bytes === 'string' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          // HS-7063: replay + refit, because replayHistoryToTerm resizes xterm
          // to the history's cols × rows which fires onResize which shrinks
          // the PTY. The dedicated view wants the PTY at the full pane size.
          applyDedicatedHistoryFrame(term, fit, { bytes: msg.bytes, cols: msg.cols, rows: msg.rows });
        }
      } catch { /* ignore non-JSON control frames */ }
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
  if (view.ws !== null) {
    try { view.ws.close(); } catch { /* already closed */ }
  }
  try { view.term.dispose(); } catch { /* no-op */ }
  view.overlay.remove();
  // HS-7195: restore the tile-size slider now that we're back in the grid.
  // Dashboard must still be active here (the dedicated view is only reachable
  // from the grid), so `enterDashboard`'s display:'' is the right target.
  if (sizerContainer !== null) sizerContainer.style.display = '';

  // HS-7097: re-claim the PTY at tile-native 4:3 dims. While the dedicated
  // view was up it pushed the PTY to the dedicated pane's geometry (via
  // fit() + 'resize' message), which is typically wider / taller than the
  // tile and would otherwise leave the tile xterm displaying bytes
  // formatted for the wrong shape after the dedicated view closes. The
  // tile's `connectTileSocket` history handler runs the same resize on
  // first attach; this is the symmetric exit-path version so a TUI like
  // nano gets a SIGWINCH and redraws to fill the tile again.
  if (view.tile.ws !== null && view.tile.ws.readyState === WebSocket.OPEN
      && view.tile.targetCols > 0 && view.tile.targetRows > 0) {
    try {
      view.tile.ws.send(JSON.stringify({
        type: 'resize',
        cols: view.tile.targetCols,
        rows: view.tile.targetRows,
      }));
    } catch { /* ws closed under us — tile teardown will follow */ }
  }

  // Recompute global grid sizing. If the window was resized while the
  // dedicated view was up, the other tiles' cached dims may be stale — this
  // is a cheap no-op when nothing changed and fixes the "some tiles wrong
  // size" case when something did.
  if (rootElement !== null) applyTileSizing(rootElement);

  // Restore prior centered state if there was one.
  if (view.priorCenteredTile !== null) centerTile(view.priorCenteredTile);
}

const CENTER_ANIMATION_MS = 280;

/**
 * HS-6867: center-tile animation.
 *
 * The naive implementation (just `position: fixed; top: 50%; left: 50%`)
 * yanks the tile out of the grid the instant the user clicks, which
 * collapses the surrounding tiles and makes the zoomed tile appear to jump
 * rather than grow out of its slot. The fix: insert a grey placeholder of
 * the tile's original size into the grid so the other tiles stay put, then
 * reparent the real tile to a fixed-position overlay and run a FLIP
 * animation (translate + scale) from the placeholder's bounding box to the
 * centered target box. The xterm's internal scale is pinned to the final
 * centered size so it "grows" naturally with the outer transform.
 */
function centerTile(tile: DashboardTile): void {
  centeredTile = tile;
  clearTileBell(tile);

  // Capture the tile's current position/size in the grid before mutating.
  const origRect = tile.root.getBoundingClientRect();

  // Replace the tile in the grid with a same-sized placeholder so the
  // surrounding layout doesn't reflow while the tile is centered.
  const placeholder = createSlotPlaceholder(origRect.width, origRect.height);
  tile.slotPlaceholder = placeholder;
  tile.root.parentElement?.insertBefore(placeholder, tile.root);

  // Compute the target centered box (70% viewport, 4:3).
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const previewWidth = Math.min(vw * 0.7, vh * 0.7 * TILE_ASPECT);
  const previewHeight = previewWidth / TILE_ASPECT;
  const targetLeft = (vw - previewWidth) / 2;
  const targetTop = (vh - previewHeight) / 2;

  // Promote the tile to the fixed-position overlay at the TARGET geometry.
  // The xterm scale is set to the final size here so it animates with the
  // outer transform instead of snapping at the end.
  //
  // HS-6964: set the tile's own inline width to `previewWidth` too. The
  // tile is a `display: flex; flex-direction: column; align-items: center`
  // container, so if the tile's width stays at its grid-slot value (set by
  // `applyTileSizing`) the larger centered preview would overflow and
  // flex-center itself around the smaller tile box — visible as the preview
  // sliding off to the left of the viewport center. Matching the tile's
  // width to the preview's width makes the flex-centering a no-op and puts
  // the preview exactly where `targetLeft = (vw - previewWidth) / 2`
  // intends. It also makes the FLIP `sx` below shrink correctly to the
  // origRect's width ratio so the tile visibly grows out of its slot.
  tile.root.classList.add('centered');
  tile.root.style.left = `${targetLeft}px`;
  tile.root.style.top = `${targetTop}px`;
  tile.root.style.width = `${previewWidth}px`;
  // HS-7096: the preview's CSS no longer transitions width / height (only the
  // outer FLIP transform animates), so these writes snap — no more
  // preview/tile size mismatch band during the center animation.
  tile.preview.style.width = `${previewWidth}px`;
  tile.preview.style.height = `${previewHeight}px`;
  if (tile.xtermRoot !== null) applyTileScale(tile.xtermRoot, previewWidth, previewHeight);

  mountCenterBackdrop();

  // FLIP: compute the inverse transform that visually puts the tile back
  // where the placeholder is, apply it without a transition, then in the
  // next frame remove it with a transition enabled. The browser interpolates
  // the transform so the tile appears to grow out of its grid slot toward
  // the center.
  const finalRect = tile.root.getBoundingClientRect();
  if (finalRect.width > 0 && finalRect.height > 0) {
    const dx = origRect.left - finalRect.left;
    const dy = origRect.top - finalRect.top;
    const sx = origRect.width / finalRect.width;
    const sy = origRect.height / finalRect.height;
    tile.root.style.transition = 'none';
    tile.root.style.transformOrigin = 'top left';
    tile.root.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void tile.root.offsetWidth; // force reflow so the inverse transform commits
    tile.root.style.transition = `transform ${CENTER_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`;
    tile.root.style.transform = '';
  }

  // Hand keyboard focus to xterm once the helper textarea is visible.
  queueMicrotask(() => { tile.term?.focus(); });
}

/**
 * HS-6964: re-apply the centered geometry to a tile after a window resize.
 * Snaps (no transition) so the centered tile tracks the viewport instead of
 * staying anchored to the left / top it was placed at when `centerTile`
 * first ran. Called from the dashboard's resize handler; a no-op if the
 * tile has since been uncentered.
 */
function recenterTile(tile: DashboardTile): void {
  if (!tile.root.classList.contains('centered')) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const previewWidth = Math.min(vw * 0.7, vh * 0.7 * TILE_ASPECT);
  const previewHeight = previewWidth / TILE_ASPECT;
  const targetLeft = (vw - previewWidth) / 2;
  const targetTop = (vh - previewHeight) / 2;

  // HS-7096: the centered tile's FLIP animation only runs on center / uncenter,
  // not on resize, so the position / size writes must snap. Disable the outer
  // transform transition briefly (the tile root has `transition: transform ...`
  // set inline while centered), then restore it so a subsequent uncenter still
  // animates. The preview's own width / height no longer has a CSS transition
  // (HS-7096) so those just snap.
  const prevTileTransition = tile.root.style.transition;
  tile.root.style.transition = 'none';
  tile.root.style.left = `${targetLeft}px`;
  tile.root.style.top = `${targetTop}px`;
  tile.root.style.width = `${previewWidth}px`;
  tile.preview.style.width = `${previewWidth}px`;
  tile.preview.style.height = `${previewHeight}px`;

  if (tile.xtermRoot !== null) applyTileScale(tile.xtermRoot, previewWidth, previewHeight);

  void tile.root.offsetWidth;
  tile.root.style.transition = prevTileTransition;
}

function uncenterTile(): void {
  if (centeredTile === null) return;
  const tile = centeredTile;
  const placeholder = tile.slotPlaceholder;
  centeredTile = null;
  removeCenterBackdrop();

  if (placeholder === null) {
    // Defensive: no placeholder means nothing to animate back to. Fall
    // through to the instant collapse path so state stays consistent.
    finishUncenterTile(tile, null);
    return;
  }

  // Animate the tile back to the placeholder's current position/size with
  // the same FLIP trick in reverse. The xterm's scale stays at its centered
  // size during the transition; the outer transform handles the shrink.
  const targetRect = placeholder.getBoundingClientRect();
  const currentRect = tile.root.getBoundingClientRect();
  if (currentRect.width <= 0 || currentRect.height <= 0) {
    finishUncenterTile(tile, placeholder);
    return;
  }

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
  // Safety: if `transitionend` never fires (e.g., the tile was ripped out
  // mid-animation by tear-down), still clean up after the scheduled time.
  window.setTimeout(() => {
    tile.root.removeEventListener('transitionend', onEnd);
    if (tile.slotPlaceholder === placeholder) finishUncenterTile(tile, placeholder);
  }, CENTER_ANIMATION_MS + 80);
}

function finishUncenterTile(tile: DashboardTile, placeholder: HTMLElement | null): void {
  tile.root.classList.remove('centered');
  tile.root.style.transition = '';
  tile.root.style.transform = '';
  tile.root.style.transformOrigin = '';
  tile.root.style.left = '';
  tile.root.style.top = '';
  // HS-6964: centerTile wrote `tile.root.style.width = previewWidth`; restore
  // the grid-slot width so `applyTileSizing`'s next pass doesn't see a stale
  // inline width. HS-7096 removed the preview's CSS width / height transition
  // so these writes snap.
  if (tile.gridPreviewWidth > 0) {
    tile.root.style.width = `${tile.gridPreviewWidth}px`;
  }
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
  el.className = 'terminal-dashboard-tile-slot';
  el.style.width = `${width}px`;
  el.style.height = `${height}px`;
  return el;
}

function mountCenterBackdrop(): void {
  if (centerBackdrop !== null) return;
  const backdrop = document.createElement('div');
  backdrop.className = 'terminal-dashboard-center-backdrop';
  backdrop.addEventListener('click', () => { uncenterTile(); });
  document.body.appendChild(backdrop);
  centerBackdrop = backdrop;
}

function removeCenterBackdrop(): void {
  if (centerBackdrop === null) return;
  centerBackdrop.remove();
  centerBackdrop = null;
}

/**
 * HS-7065: right-click on any dashboard tile opens a small context menu.
 * Close Tab is only enabled for dynamic terminals (configured ones live in
 * settings.json and must be removed from there). Rename... is always
 * available and is transient — it updates the tile's label in-place but does
 * not persist to settings.json, matching the drawer tab's Rename behaviour
 * (HS-6668).
 *
 * Close-left / Close-right variants from the drawer's context menu are
 * intentionally omitted — in a 2D project grid the linear "left / right"
 * concept isn't useful (per HS-7065 ticket note).
 */
function onTileContextMenu(tile: DashboardTile, e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  dismissDashboardTileContextMenu();

  const closeDisabled = !tile.dynamic;
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

  bind('close', () => { void closeDashboardTile(tile); });
  bind('rename', () => { openDashboardTileRename(tile); });

  document.body.appendChild(menu);

  // Clamp to viewport (same pattern as the drawer's `showTabContextMenu`).
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

/**
 * HS-7065: close a dynamic terminal from the dashboard. Mirrors the drawer's
 * close flow — if the session is alive, show an in-app confirm before
 * destroying so the user doesn't kill a running process by accident; exited
 * or never-spawned sessions close silently.
 */
async function closeDashboardTile(tile: DashboardTile): Promise<void> {
  if (!tile.dynamic) return; // configured terminals can't be closed from here
  if (tile.state === 'alive') {
    const { confirmDialog } = await import('./confirm.js');
    const confirmed = await confirmDialog({
      title: 'Close terminal?',
      message: `Close terminal "${tile.label}"? Its running process will be stopped.`,
      confirmLabel: 'Close',
      danger: true,
    });
    if (!confirmed) return;
  }
  try {
    await apiWithSecret('/terminal/destroy', tile.secret, {
      method: 'POST',
      body: { terminalId: tile.terminalId },
    });
  } catch (err) {
    console.error('terminalDashboard: close terminal failed', err);
    return;
  }
  refreshDashboardGrid();
}

/**
 * HS-7065: rename a dashboard tile in place. Reuses the same transient
 * (non-persisted) semantics as the drawer's Rename... (HS-6668) — updates
 * the tile's label on the client only; a full dashboard refresh or page
 * reload restores the original configured / derived name. For dynamic
 * terminals the name also drops back to its original on refresh because
 * `/api/terminal/list` is the source of truth.
 */
function openDashboardTileRename(tile: DashboardTile): void {
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
            <input type="text" className="term-rename-input" value={tile.label} />
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
    const resolved = next === '' ? tile.label : next;
    tile.label = resolved;
    tile.labelEl.textContent = resolved;
    tile.labelEl.setAttribute('title', resolved);
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

function tileLabel(terminal: TerminalListEntry): string {
  if (typeof terminal.name === 'string' && terminal.name !== '') return terminal.name;
  const word = terminal.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/**
 * HS-7031: tile sizing is driven by the user-controlled size slider (the
 * auto-fit logic from HS-6833 was removed — the explicit slider is easier
 * to reason about than the opaque "pick the largest that fits" algorithm).
 * The slider value in 0..100 maps linearly to a tile width between the
 * ~133 px floor (100 px preview height × 4:3) and the full root width. The
 * root allows vertical scroll if the chosen tile height overflows, matching
 * the earlier behaviour at the floor.
 *
 * `tileWidthFromSlider` is kept in `terminalDashboardSizing.ts` so the math
 * stays unit-testable without pulling in JSX / DOM.
 */
export function applyTileSizing(root: HTMLElement): void {
  const rootWidth = Math.max(0, root.clientWidth - ROOT_PADDING * 2);
  if (rootWidth <= 0) return;

  const tileWidth = tileWidthFromSlider(sliderValue, rootWidth);
  const tileHeight = Math.round(tileWidth / TILE_ASPECT);

  for (const tile of root.querySelectorAll<HTMLElement>('.terminal-dashboard-tile')) {
    // HS-6964: skip the centered tile — it owns its own width while zoomed
    // (set to `previewWidth` by `centerTile` so the preview flex-centers
    // cleanly at the viewport centre). Overwriting it here on a window
    // resize would snap the centered tile back to the grid-slot width
    // mid-zoom and throw the preview off-center again.
    if (!tile.classList.contains('centered')) {
      tile.style.width = `${tileWidth}px`;
    }
    const preview = tile.querySelector<HTMLElement>('.terminal-dashboard-tile-preview');
    // Skip the currently-centered tile — it owns its own preview geometry
    // while zoomed (§25.7). `uncenterTile()` restores these dims on collapse.
    if (preview !== null && !tile.classList.contains('centered')) {
      preview.style.width = `${tileWidth}px`;
      preview.style.height = `${tileHeight}px`;
    }
    const xtermRoot = tile.querySelector<HTMLElement>('.terminal-dashboard-tile-xterm');
    if (xtermRoot !== null && !tile.classList.contains('centered')) {
      applyTileScale(xtermRoot, tileWidth, tileHeight);
    }
    // Remember the grid preview dims on the live tile so uncenterTile() can
    // restore exactly the same size without re-running the global sizer.
    const secret = tile.dataset.secret ?? '';
    const tid = tile.dataset.terminalId ?? '';
    const live = liveTiles.get(`${secret}::${tid}`);
    if (live !== undefined) {
      live.gridPreviewWidth = tileWidth;
      live.gridPreviewHeight = tileHeight;
    }
  }
}

/**
 * HS-6834: scale the xterm DOM root so the 80 × 60 grid visually fits the
 * tile's preview area. xterm lays out at its natural pixel size (cell-size ×
 * cols, cell-size × rows); we apply a CSS transform so we never touch
 * xterm's cols/rows and therefore never reflow the PTY or its attachers.
 *
 * HS-6931: use a single uniform `scale(s)` rather than a two-axis
 * `scale(sx, sy)`. The 4:3 tile and xterm's ~2:3 natural aspect don't
 * match, so one axis leaves dead space — but the anisotropic fix from
 * HS-6898 stretched text enough to look distorted. The reported case was
 * `scale(3.478, 0.375)`, where `xtermRoot.offsetWidth` returned the
 * block-level parent width rather than the actual xterm grid width.
 *
 * HS-6865: the xtermRoot also needs explicit `width` and `height` so its
 * internal absolutely-positioned `.xterm-viewport` / `.xterm-screen` layers
 * don't collapse to zero (causing the partial-canvas layout from the bug
 * report). We set them to xterm's natural pixel size.
 *
 * HS-6997: the scaled xterm is top-aligned inside the preview (left remains
 * horizontally centered to handle the rare portrait-PTY case). HS-6965's
 * policy of adopting the PTY's cols × rows verbatim means wide / short PTYs
 * (e.g. 151 × 13 → natural 1181 × 208) scale to fill the tile's width but
 * only a fraction of its height; the old letterbox-center math sandwiched
 * the content between equal bands top and bottom, which read as "why is
 * there empty space above my prompt?" Top-aligning puts all the dead space
 * below the last line of output so the tile reads like a real terminal pane
 * whose content hasn't yet grown to the bottom. The preview background
 * (HS-6866) matches xterm's theme background so the dead space is visually
 * seamless with the xterm canvas.
 *
 * Natural dims are read from the `.xterm-screen` child — it's the element
 * xterm.js explicitly sizes to `cols × cellW` / `rows × cellH`, whereas
 * xtermRoot is a block-level wrapper that fills its parent horizontally and
 * therefore mis-reports width as the tile width (root cause of HS-6931).
 */
function applyTileScale(xtermRoot: HTMLElement, tileWidth: number, tileHeight: number): void {
  // Reset first so we can measure xterm's natural (cell-based) size without
  // being contaminated by our own previous position / width / height writes.
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

  // The preview has `position: relative`, so absolute positioning here
  // resolves against the tile's preview box. `scale.left` / `scale.top`
  // encode the horizontal-center + top-align letterbox policy (HS-6997).
  xtermRoot.style.position = 'absolute';
  xtermRoot.style.left = `${scale.left}px`;
  xtermRoot.style.top = `${scale.top}px`;
  xtermRoot.style.width = `${scale.width}px`;
  xtermRoot.style.height = `${scale.height}px`;
  xtermRoot.style.transform = `scale(${scale.scale})`;
}

