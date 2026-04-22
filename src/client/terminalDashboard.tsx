import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';

import type { SafeHtml } from '../jsx-runtime.js';
import { apiWithSecret } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import { restoreTicketList } from './dashboardMode.js';
import { closeDetail } from './detail.js';
import { toElement } from './dom.js';
import type { ProjectInfo } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';
import { computeTileWidth, ROOT_PADDING, TILE_ASPECT } from './terminalDashboardSizing.js';
import { replayHistoryToTerm } from './terminalReplay.js';

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

/** HS-6834: every dashboard tile mounts an xterm pinned at 80 × 60. The PTY
 *  is left at whatever dims the drawer / eager-spawn established — we never
 *  send `?cols=&rows=` on the dashboard WebSocket so the first-attach
 *  cleanup (HS-6799) does not fire. The tile scales visually via
 *  `transform: scale(s)` from its natural pixel size. */
const DASHBOARD_TILE_COLS = 80;
const DASHBOARD_TILE_ROWS = 60;

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
}

interface DashboardTile {
  secret: string;
  terminalId: string;
  label: string;
  state: TerminalSessionState;
  exitCode: number | null;
  root: HTMLElement;
  preview: HTMLElement;
  term: XTerm | null;
  xtermRoot: HTMLElement | null;
  ws: WebSocket | null;
  /** Preview dims that `applyTileSizing()` last wrote for the grid slot.
   *  Persisted so uncentering can restore the same dimensions without
   *  re-running the full global sizing pass. */
  gridPreviewWidth: number;
  gridPreviewHeight: number;
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
    try { dedicatedView.ws?.close(); } catch { /* already closed */ }
    try { dedicatedView.term.dispose(); } catch { /* no-op */ }
    dedicatedView.overlay.remove();
    dedicatedView = null;
  }
  if (centeredTile !== null) {
    centeredTile.root.classList.remove('centered');
    centeredTile = null;
  }
  removeCenterBackdrop();
  for (const tile of liveTiles.values()) {
    disposeTile(tile);
  }
  liveTiles.clear();
}

function disposeTile(tile: DashboardTile): void {
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
  if (rootElement !== null) {
    rootElement.style.display = '';
    void renderDashboardGrid(rootElement);
  }
  resizeHandler = () => {
    if (resizeRaf !== null) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      if (rootElement !== null) applyTileSizing(rootElement);
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
      terminals = [...listed.configured, ...listed.dynamic];
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

  const section = toElement(
    <section className="terminal-dashboard-section" data-secret={data.project.secret}>
      <h2 className="terminal-dashboard-heading">{headingText}</h2>
      {count === 0 ? (
        <div className="terminal-dashboard-empty-row">
          No terminals configured — open Settings → Terminal to add one.
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
  return section;
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
  if (preview === null) return tileRoot;

  const tile: DashboardTile = {
    secret,
    terminalId: terminal.id,
    label,
    state,
    exitCode,
    root: tileRoot,
    preview,
    term: null,
    xtermRoot: null,
    ws: null,
    gridPreviewWidth: 0,
    gridPreviewHeight: 0,
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
    cols: DASHBOARD_TILE_COLS,
    rows: DASHBOARD_TILE_ROWS,
  });
  term.open(xtermRoot);

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
          // The replay helper resized the xterm to the history's origin dims.
          // Force it back to 80 × 60 so the dashboard tile's scale-transform
          // geometry stays stable across subsequent live bytes.
          if (tile.term.cols !== DASHBOARD_TILE_COLS || tile.term.rows !== DASHBOARD_TILE_ROWS) {
            tile.term.resize(DASHBOARD_TILE_COLS, DASHBOARD_TILE_ROWS);
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
      <div className="terminal-dashboard-dedicated-body"></div>
    </div>
  );
  rootElement.appendChild(overlay);

  const body = overlay.querySelector<HTMLElement>('.terminal-dashboard-dedicated-body');
  const backBtn = overlay.querySelector<HTMLElement>('.terminal-dashboard-dedicated-back');
  if (body === null || backBtn === null) return;
  backBtn.addEventListener('click', () => { exitDedicatedView(); });

  const term = new XTerm({
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10_000,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(body);
  fit.fit();

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
          replayHistoryToTerm(term, { bytes: msg.bytes, cols: msg.cols, rows: msg.rows });
        }
      } catch { /* ignore non-JSON control frames */ }
    }
  });

  dedicatedView = { tile, overlay, term, fit, ws, priorCenteredTile };
  queueMicrotask(() => { term.focus(); });
}

function exitDedicatedView(): void {
  if (dedicatedView === null) return;
  const view = dedicatedView;
  dedicatedView = null;
  if (view.ws !== null) {
    try { view.ws.close(); } catch { /* already closed */ }
  }
  try { view.term.dispose(); } catch { /* no-op */ }
  view.overlay.remove();
  // Restore prior centered state if there was one.
  if (view.priorCenteredTile !== null) centerTile(view.priorCenteredTile);
}

function centerTile(tile: DashboardTile): void {
  centeredTile = tile;
  tile.root.classList.add('centered');
  // HS-6837: viewing the tile more closely clears the bell outline and the
  // server-side bellPending flag.
  clearTileBell(tile);

  // Compute a 70% viewport box preserving the 4:3 aspect ratio.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const previewWidth = Math.min(vw * 0.7, vh * 0.7 * TILE_ASPECT);
  const previewHeight = previewWidth / TILE_ASPECT;
  tile.preview.style.width = `${previewWidth}px`;
  tile.preview.style.height = `${previewHeight}px`;
  if (tile.xtermRoot !== null) applyTileScale(tile.xtermRoot, previewWidth, previewHeight);

  mountCenterBackdrop();

  // Let the CSS transition settle, then hand keyboard focus to xterm. A
  // microtask is enough on modern browsers to ensure the helper textarea
  // has its final `display` and is focusable.
  queueMicrotask(() => { tile.term?.focus(); });
}

function uncenterTile(): void {
  if (centeredTile === null) return;
  const tile = centeredTile;
  tile.root.classList.remove('centered');
  tile.preview.style.width = `${tile.gridPreviewWidth}px`;
  tile.preview.style.height = `${tile.gridPreviewHeight}px`;
  if (tile.xtermRoot !== null && tile.gridPreviewWidth > 0 && tile.gridPreviewHeight > 0) {
    applyTileScale(tile.xtermRoot, tile.gridPreviewWidth, tile.gridPreviewHeight);
  }
  centeredTile = null;
  removeCenterBackdrop();
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

function tileLabel(terminal: TerminalListEntry): string {
  if (typeof terminal.name === 'string' && terminal.name !== '') return terminal.name;
  const word = terminal.command.trim().split(/\s+/)[0] ?? '';
  const clean = word.replace(/^{{|}}$/g, '');
  if (clean.toLowerCase().includes('claude')) return 'claude';
  const base = clean.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
  return base !== '' ? base : 'terminal';
}

/**
 * HS-6833: global tile sizing. Iterate candidate widths from largest to
 * smallest; pick the largest where every tile at every project fits the
 * viewport height without scrolling. Fall back to the 100 px floor and
 * allow the root to vertical-scroll when even the floor doesn't fit.
 *
 * Exported for unit testing via `computeTileWidth()`.
 */
export function applyTileSizing(root: HTMLElement): void {
  const rootWidth = Math.max(0, root.clientWidth - ROOT_PADDING * 2);
  const rootHeight = root.clientHeight;
  const sections = Array.from(root.querySelectorAll<HTMLElement>('.terminal-dashboard-section'));
  if (sections.length === 0 || rootWidth <= 0) return;

  const projectTileCounts = sections.map(s =>
    s.querySelectorAll<HTMLElement>('.terminal-dashboard-tile').length,
  );
  const hasEmptySection = sections.some((_, i) => projectTileCounts[i] === 0);

  const tileWidth = computeTileWidth({
    rootWidth,
    rootHeight,
    projectTileCounts,
    hasEmptySection,
  });
  const tileHeight = Math.round(tileWidth / TILE_ASPECT);

  for (const tile of root.querySelectorAll<HTMLElement>('.terminal-dashboard-tile')) {
    tile.style.width = `${tileWidth}px`;
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
 * cols, cell-size × rows); we apply `transform: scale(s)` so we never touch
 * xterm's cols/rows and therefore never reflow the PTY or its attachers.
 */
function applyTileScale(xtermRoot: HTMLElement, tileWidth: number, tileHeight: number): void {
  xtermRoot.style.transform = '';
  xtermRoot.style.transformOrigin = 'top left';
  const naturalWidth = xtermRoot.offsetWidth;
  const naturalHeight = xtermRoot.offsetHeight;
  if (naturalWidth <= 0 || naturalHeight <= 0) return;
  const scale = Math.min(tileWidth / naturalWidth, tileHeight / naturalHeight);
  xtermRoot.style.transform = `scale(${scale})`;
}

