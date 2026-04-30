import type { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal as XTerm } from '@xterm/xterm';

import { apiWithSecret } from './api.js';
import { toElement } from './dom.js';
import { openExternalUrl } from './tauriIntegration.js';
import {
  applyAppearanceToTerm,
  getProjectDefault,
  getSessionOverride,
  resolveAppearance,
} from './terminalAppearance.js';
import { checkout,type CheckoutHandle } from './terminalCheckout.js';
import {
  computeTileScale,
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
  ROOT_PADDING,
  TILE_ASPECT,
  tileNativeGridFromCellMetrics,
  tileWidthFromSlider,
} from './terminalDashboardSizing.js';
import { isTerminalViewToggleShortcut } from './terminalKeybindings.js';
import { replayHistoryToTerm } from './terminalReplay.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';
import {
  initialTileState,
  onDisposeTimerFired,
  onTileEnter,
  onTileExit,
  type TileVirtualState,
  VIRT_DEFAULT_DEBOUNCE_MS,
} from './terminalTileVirtualization.js';

/**
 * Shared tile-grid module (HS-7595) used by:
 *   - The global Terminal Dashboard (§25 / docs/25-terminal-dashboard.md)
 *   - The per-project Drawer Terminal Grid (§36 / docs/36-drawer-terminal-grid.md)
 *
 * Both surfaces render scaled-down terminal tiles in a flex-wrap grid with the
 * same interaction model: single-click → centered overlay (FLIP animation),
 * double-click → dedicated full-pane view, lazy/exited tiles render as
 * placeholders that spawn-on-enlarge, bell indicators bounce + outline, etc.
 * Before HS-7595 each callsite held a near-identical copy of this code; this
 * module collapses the per-tile lifecycle behind one API. The callsite still
 * owns the surrounding chrome (project sections / drawer toolbar / slider /
 * on-list-update wiring) and just delegates per-tile rendering + center +
 * dedicated state to `mountTileGrid()`.
 *
 * Key parameterisations the two surfaces need:
 *
 * - `cssPrefix` — class names differ (`drawer-terminal-grid` vs
 *   `terminal-dashboard`) so styles can evolve independently per surface.
 * - `centerSizeFrac` — 0.7 for the dashboard's full-viewport overlay, 0.9 for
 *   the drawer's already-cramped pane.
 * - `centerScope` — backdrop attachment target. `'viewport'` makes the
 *   backdrop dim the whole document (dashboard); `'container'` constrains it
 *   to the grid's parent panel (drawer).
 * - `getSliderValue` — caller owns the size slider state; the grid asks for
 *   the current value during sizing passes.
 * - `onContextMenu` — optional right-click handler. The dashboard wires a
 *   per-tile context menu (§25.8.5); the drawer-grid currently doesn't.
 *
 * The returned `TileGridHandle` exposes the operations the callsite needs to
 * react to outside events (rebuild on a list refresh, applySizing on slider
 * change / window resize, exitCentered / exitDedicated on Esc).
 */

export type TileSessionState = 'alive' | 'exited' | 'not_spawned';

/** A normalised tile entry. Both callsites fetch terminal lists from
 *  `/terminal/list` then map each entry into this shape. The shared module
 *  doesn't care about the original list response — it just needs id, secret,
 *  display label, current state + exit code, server-side bell flag, and the
 *  three appearance-override fields. */
export interface TileEntry {
  id: string;
  secret: string;
  label: string;
  state: TileSessionState;
  exitCode: number | null;
  bellPending?: boolean;
  /** HS-6307 — appearance overrides resolved by the server from settings.json
   *  per terminal. Layered over project default + session override at mount
   *  time via `resolveAppearance`. */
  theme?: string;
  fontFamily?: string;
  fontSize?: number;
  /** HS-7278 — pre-formatted CWD label rendered as a small chip below the
   *  tile name. Empty string / undefined hides the row. The callsite is
   *  responsible for tildification + truncation (via `formatCwdLabel`); the
   *  shared module just renders whatever string is passed. The drawer grid
   *  intentionally omits this (no CWD row per §36 v1); the dashboard passes
   *  it (HS-7278). */
  cwdLabel?: string;
  /** Raw CWD path used as the `title` attribute on the chip — gives the user
   *  the full path on hover when the rendered label was truncated. */
  cwdRaw?: string;
  /** Optional opaque payload the callsite wants to associate with the tile.
   *  Returned to `onContextMenu` etc. so the callsite can dispatch over its
   *  original list-response shape (e.g., the dashboard needs `dynamic` to
   *  decide whether the Close Tab option is enabled). */
  metadata?: unknown;
  /** HS-7662 — flow-layout mode renders a `{ProjectName} ›` prefix BEFORE
   *  the terminal label on the first tile of each project's run so a single
   *  grid mixing terminals from many projects reads at a glance. Subsequent
   *  tiles in the same project run get nothing extra (the run itself groups
   *  them visually). HS-7824 removed the colored badge dot that originally
   *  accompanied this prefix — it didn't actually clarify grouping in
   *  practice.
   */
  projectBadge?: { name?: string };
}

export interface TileGridOptions {
  /** Where the grid renders. Tiles are appended as direct children. */
  container: HTMLElement;
  /** Shared CSS-class prefix. Determines the rendered class names — e.g.
   *  prefix `terminal-dashboard` produces `terminal-dashboard-tile`,
   *  `terminal-dashboard-tile-preview`, `terminal-dashboard-tile-xterm`,
   *  `terminal-dashboard-tile-slot` (placeholder), etc. */
  cssPrefix: string;
  /** Fraction of the centering reference rect occupied by the centered tile
   *  (both axes, then clamped by 4:3). `0.7` for §25 (full viewport), `0.9`
   *  for §36 (cramped drawer body). */
  centerSizeFrac: number;
  /** Where the centered tile + backdrop position themselves against, and
   *  where the dim backdrop attaches:
   *  - `'viewport'`: centered tile uses `position: fixed` + viewport dims;
   *    backdrop attaches to `document.body` so it dims the whole window.
   *    Used by §25 (dashboard is full-viewport).
   *  - `'container'`: centered tile positions against `centerReferenceEl`
   *    (or container) bounding rect; backdrop attaches inside that element.
   *    Used by §36 (drawer-scoped). */
  centerScope: 'viewport' | 'container';
  /** When `centerScope === 'container'`, the element to read for the
   *  centered tile's reference rect + backdrop attachment. Defaults to
   *  `container` if not provided. */
  centerReferenceEl?: HTMLElement;
  /** Returns the current slider value (0..100). Callsite owns the slider
   *  state; the grid calls this during sizing passes. */
  getSliderValue: () => number;
  /** Optional right-click context-menu handler. */
  onContextMenu?: (entry: TileEntry, e: MouseEvent) => void;
  /** Optional hook fired when a tile is enlarged (centered or dedicated).
   *  Used by callsites that need to react to "user is now interacting with
   *  this terminal" — e.g. clearing cross-project bell indicators. */
  onTileEnlarge?: (entry: TileEntry, target: 'center' | 'dedicated') => void;
  /** Optional hook to add chrome to the dedicated view's top bar (e.g. the
   *  dashboard's project breadcrumb + search widget). The hook is called
   *  with the bar element after Back + label are appended; the callsite can
   *  insert additional children. Return value can be a disposer that runs
   *  on `exitDedicated`. */
  onDedicatedBarMount?: (bar: HTMLElement, entry: TileEntry, term: XTerm) => undefined | (() => void);
  /** Optional hook called whenever a centered tile is uncentered or the
   *  dedicated view exits. Gives callsites a way to react (e.g. clearing
   *  per-tile state in their own maps). */
  onTileShrink?: (entry: TileEntry) => void;
  /** HS-7943 — optional hook fired when the user clicks the project
   *  badge prefix on a flow-mode tile (`{ProjectName} ›`). The grid calls
   *  this with the tile's entry and stops the click from bubbling to the
   *  tile-center handler so the dashboard can route the user to that
   *  project's tab without ALSO centering the tile. Sectioned-mode
   *  headings live outside the tile grid in the dashboard's own DOM, so
   *  they wire their click handler directly — this hook only covers the
   *  flow-mode case. */
  onProjectBadgeClick?: (entry: TileEntry) => void;
}

export interface TileGridHandle {
  /** Re-render every tile from the new entry list. Disposes outgoing tiles +
   *  mounts incoming ones. Centered / dedicated state is reset. Callers
   *  should call this on every `/terminal/list` refresh that affects this
   *  grid's terminals. */
  rebuild(entries: TileEntry[]): void;
  /** Re-run the per-tile sizing pass — reads `getSliderValue()` against the
   *  container width and applies the resulting tile dims to every grid
   *  tile (centered tile is skipped). Called on slider input + window
   *  resize + dedicated-view exit. */
  applySizing(): void;
  /** Re-center the currently-centered tile (if any) against the current
   *  reference rect. Called by callsites on window resize so the centered
   *  overlay tracks viewport / drawer-body changes. */
  recenterTile(): void;
  /** Programmatically exit the centered overlay (Esc on the bare grid →
   *  callsite calls this before exiting its own grid mode). */
  uncenterTile(): void;
  /** Programmatically exit the dedicated view. */
  exitDedicatedView(): void;
  /** Sync per-tile bell indicators against a set of bellPending terminal IDs
   *  (drawn from the cross-project bell-state long-poll subscription, or a
   *  per-project subset). Tiles whose id is in `pendingIds` get `.has-bell`;
   *  others have it removed. */
  syncBellState(pendingIds: Set<string>): void;
  /** Move keyboard focus to the dedicated view's xterm (no-op when no
   *  dedicated view is open). Used by callsites' Esc handlers — when the
   *  user blurs an input within the dedicated view's chrome (e.g. the
   *  HS-7526 search widget), the next-keypress target should be the
   *  terminal so a subsequent Esc exits the view. */
  focusDedicatedTerm(): void;
  /** True when a tile is currently centered. */
  isCentered(): boolean;
  /** True when the dedicated view is mounted. */
  isDedicatedOpen(): boolean;
  /** Tear down everything (every xterm, every WS, the centered tile state,
   *  the dedicated view if any). Idempotent. */
  dispose(): void;
}

interface InternalTile {
  entry: TileEntry;
  state: TileSessionState;
  exitCode: number | null;
  root: HTMLElement;
  preview: HTMLElement;
  labelEl: HTMLElement;
  term: XTerm | null;
  xtermRoot: HTMLElement | null;
  ws: WebSocket | null;
  gridPreviewWidth: number;
  gridPreviewHeight: number;
  /** Tile-native cols × rows the WebSocket history handler resized the PTY
   *  to (HS-7097). Used on dedicated-view exit to re-claim the PTY at the
   *  tile's geometry rather than the dedicated pane's. */
  targetCols: number;
  targetRows: number;
  slotPlaceholder: HTMLElement | null;
  screenObserver: ResizeObserver | null;
}

interface DedicatedView {
  tile: InternalTile;
  overlay: HTMLElement;
  /** HS-8042 — dedicated view is a `terminalCheckout` consumer (Phase 2.2
   *  of HS-8032). The handle owns the live xterm + WebSocket; pre-fix the
   *  dedicated view spawned a SECOND xterm + SECOND WebSocket attached to
   *  the same PTY, doubling memory + network for the same terminal. After
   *  the migration the tile's existing WS-attached xterm (if any) drops
   *  to the placeholder per §54.3.2; on `exitDedicatedView` the handle
   *  releases and the live xterm reparents back. */
  checkout: CheckoutHandle;
  /** Convenience aliases — sourced from `checkout.term` / `checkout.fit`
   *  so existing call sites stay readable. Stable for the dedicated
   *  view's lifetime. */
  term: XTerm;
  fit: FitAddon;
  bodyResizeObserver: ResizeObserver | null;
  /** When the user double-clicks a tile WHILE another tile is already
   *  centered, the prior centered tile is recorded here so the dedicated
   *  view's exit returns to centered-prior rather than back-to-grid. */
  priorCenteredTile: InternalTile | null;
  /** Disposer returned by `onDedicatedBarMount` callsite hook (if any).
   *  Called from `exitDedicatedView` so the callsite's bar chrome cleans
   *  up alongside the rest. */
  barDispose: (() => void) | null;
}

const TILE_INITIAL_COLS = DASHBOARD_FALLBACK_COLS;
const TILE_INITIAL_ROWS = DASHBOARD_FALLBACK_ROWS;
const CENTER_ANIMATION_MS = 280;
/** 220 ms gives the browser enough time to dispatch dblclick first when the
 *  user double-clicks; tested across macOS / Linux / Windows. Below ~200 ms
 *  the single-click action sometimes fires before dblclick on slower
 *  hardware. */
const SINGLE_CLICK_DELAY_MS = 220;

export function mountTileGrid(opts: TileGridOptions): TileGridHandle {
  const tiles = new Map<string, InternalTile>();
  let centered: InternalTile | null = null;
  let centerBackdrop: HTMLElement | null = null;
  let dedicated: DedicatedView | null = null;
  let pendingSingleClickTimer: number | null = null;

  // HS-7968 — virtualization state. One IntersectionObserver per grid; per-
  // tile state lives in `virtState`. Pure decisions in
  // `terminalTileVirtualization.ts`; this section just wires the DOM/timer
  // side-effects to the state machine.
  const virtState = new Map<string, TileVirtualState>();
  const virtTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const virtRootToId = new Map<Element, string>();
  const virtObserver = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(handleIntersectionEntries, {
        root: null,
        rootMargin: '200px',
        threshold: 0,
      })
    : null;

  const cssPrefix = opts.cssPrefix;
  const tileClass = `${cssPrefix}-tile`;
  const previewClass = `${cssPrefix}-tile-preview`;
  const labelClass = `${cssPrefix}-tile-label`;
  const xtermClass = `${cssPrefix}-tile-xterm`;
  const placeholderClass = `${cssPrefix}-tile-placeholder`;
  const placeholderColdClass = `${cssPrefix}-tile-placeholder-cold`;
  const placeholderStartingClass = `${cssPrefix}-tile-placeholder-starting`;
  const placeholderStatusClass = `${cssPrefix}-tile-placeholder-status`;
  const slotClass = `${cssPrefix}-tile-slot`;
  const backdropClass = `${cssPrefix}-center-backdrop`;
  const dedicatedClass = `${cssPrefix}-dedicated`;
  const dedicatedBarClass = `${cssPrefix}-dedicated-bar`;
  const dedicatedBackClass = `${cssPrefix}-dedicated-back`;
  const dedicatedLabelClass = `${cssPrefix}-dedicated-label`;
  const dedicatedBodyClass = `${cssPrefix}-dedicated-body`;
  const dedicatedPaneClass = `${cssPrefix}-dedicated-pane`;

  // --- DOM construction ---

  function renderPreviewContent(state: TileSessionState, exitCode: number | null) {
    if (state === 'alive') {
      return <div className={placeholderClass}></div>;
    }
    const status = state === 'exited'
      ? (exitCode === null ? 'Exited' : `Exited (code ${exitCode})`)
      : 'Not yet started';
    return (
      <div className={`${placeholderClass} ${placeholderColdClass}`}>
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>
        <span className={placeholderStatusClass}>{status}</span>
      </div>
    );
  }

  function renderTile(entry: TileEntry): HTMLElement {
    const initialBell = entry.bellPending === true;
    const cwdLabel = entry.cwdLabel ?? '';
    const cwdRaw = entry.cwdRaw ?? '';
    const cwdClass = `${cssPrefix}-tile-cwd`;
    // HS-7662 — flow-mode project prefix: `{ProjectName} ›` BEFORE the
    // terminal label on the first tile of each project's run. Absent in
    // sectioned mode and on subsequent tiles in the same project run.
    // HS-7824 dropped the colored badge dot that originally sat in front
    // of the prefix.
    const badge = entry.projectBadge;
    const fullLabelTitle = badge?.name !== undefined && badge.name !== ''
      ? `${badge.name} › ${entry.label}`
      : entry.label;
    const root = toElement(
      <div
        className={`${tileClass} ${tileClass}-${entry.state}${initialBell ? ' has-bell' : ''}`}
        data-secret={entry.secret}
        data-terminal-id={entry.id}
      >
        <div className={previewClass}>
          {renderPreviewContent(entry.state, entry.exitCode)}
        </div>
        <div className={labelClass} title={fullLabelTitle}>
          {badge?.name !== undefined && badge.name !== ''
            // HS-7943 follow-up — only the project name itself should
            // carry the link affordance (pointer cursor + accent underline
            // on hover); the trailing ` › ` chevron stays as muted plain
            // text. Pre-fix the whole `{name} › ` span was the click +
            // hover target, so the chevron was underlined alongside the
            // name. The click listener stays on the outer span so a click
            // on the chevron still routes (matches the pre-fix click
            // hitbox); SCSS scopes the hover affordance to the inner name
            // span only.
            ? <span className={`${cssPrefix}-tile-project${opts.onProjectBadgeClick !== undefined ? ' is-clickable' : ''}`} title={`Switch to ${badge.name}`}><span className={`${cssPrefix}-tile-project-name`}>{badge.name}</span>{' › '}</span>
            : null}
          <span className={`${cssPrefix}-tile-name`}>{entry.label}</span>
        </div>
        {cwdLabel === ''
          ? null
          : <div className={cwdClass} title={cwdRaw}>{cwdLabel}</div>}
      </div>
    );

    // HS-7943 — project-badge click switches to that project's tab. The
    // listener is wired only when the callsite passes a handler (sectioned
    // mode never renders the badge prefix, so its tiles get no listener
    // either — checking the callback at attach time keeps the hover
    // affordance consistent with the actual behaviour). `stopPropagation`
    // beats the tile-center click handler that sits on the tile root.
    if (opts.onProjectBadgeClick !== undefined && badge?.name !== undefined && badge.name !== '') {
      const projectEl = root.querySelector<HTMLElement>(`.${cssPrefix}-tile-project`);
      const onProjectBadgeClick = opts.onProjectBadgeClick;
      if (projectEl !== null) {
        projectEl.addEventListener('click', (e) => {
          e.stopPropagation();
          onProjectBadgeClick(entry);
        });
      }
    }
    const preview = root.querySelector<HTMLElement>(`.${previewClass}`);
    const labelEl = root.querySelector<HTMLElement>(`.${labelClass}`);
    if (preview === null || labelEl === null) return root;

    const tile: InternalTile = {
      entry,
      state: entry.state,
      exitCode: entry.exitCode,
      root,
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
    };
    tiles.set(entry.id, tile);

    // HS-7968 — virtualized mount. Tile starts unmounted; the IntersectionObserver
    // drives mount/dispose based on viewport visibility. Tiles in non-alive
    // state never auto-mount (no PTY to attach to); spawn-and-enlarge still
    // mounts eagerly via `spawnAndEnlarge` below. When the observer is
    // unavailable (test envs without IO) we fall back to the eager-mount
    // behaviour so tests don't have to install a polyfill.
    virtState.set(entry.id, initialTileState());
    if (virtObserver !== null) {
      virtRootToId.set(root, entry.id);
      virtObserver.observe(root);
    } else if (entry.state === 'alive') {
      mountTileXterm(tile);
      connectTileSocket(tile);
      const s = virtState.get(entry.id);
      if (s !== undefined) virtState.set(entry.id, { ...s, mounted: true });
    }

    root.addEventListener('click', (e) => { onTileClick(tile, e); });
    root.addEventListener('dblclick', (e) => { onTileDblClick(tile, e); });
    if (opts.onContextMenu !== undefined) {
      const handler = opts.onContextMenu;
      root.addEventListener('contextmenu', (e) => { handler(tile.entry, e); });
    }

    return root;
  }

  // --- HS-7968 virtualization wiring ---

  function handleIntersectionEntries(entries: IntersectionObserverEntry[]): void {
    const now = performance.now();
    for (const entry of entries) {
      const tileId = virtRootToId.get(entry.target);
      if (tileId === undefined) continue;
      const tile = tiles.get(tileId);
      if (tile === undefined) continue;
      const current = virtState.get(tileId) ?? initialTileState();
      if (entry.isIntersecting) {
        // HS-8046 — track viewport membership so the auto-clear-bell
        // logic knows which tiles the user is actually looking at, and
        // immediately clear any bell that was already on this tile when
        // it scrolled in.
        visibleTileIds.add(tileId);
        maybeAutoClearTileBell(tile);
        // Only mount-if-not-mounted when the tile is alive — exited /
        // not_spawned tiles don't have PTYs to attach to. The placeholder
        // visual already conveys their state.
        const mountIfNotMounted = tile.state === 'alive';
        const step = onTileEnter(current, { tileId, mountIfNotMounted });
        virtState.set(tileId, step.next);
        for (const action of step.actions) {
          if (action.type === 'cancelDispose') {
            const t = virtTimers.get(tileId);
            if (t !== undefined) { clearTimeout(t); virtTimers.delete(tileId); }
          } else if (action.type === 'mount') {
            mountTileXterm(tile);
            connectTileSocket(tile);
          }
        }
      } else {
        // HS-8046 — tile scrolled out of viewport; user can no longer see
        // it, so subsequent bells must surface as the indicator.
        visibleTileIds.delete(tileId);
        const step = onTileExit(current, { tileId, now, debounceMs: VIRT_DEFAULT_DEBOUNCE_MS });
        virtState.set(tileId, step.next);
        for (const action of step.actions) {
          if (action.type === 'scheduleDispose') {
            const timer = setTimeout(() => {
              virtTimers.delete(tileId);
              const after = virtState.get(tileId) ?? initialTileState();
              const fired = onDisposeTimerFired(after, { tileId });
              virtState.set(tileId, fired.next);
              for (const innerAction of fired.actions) {
                if (innerAction.type === 'dispose') {
                  softDisposeTile(tile);
                }
              }
            }, action.afterMs);
            virtTimers.set(tileId, timer);
          }
        }
      }
    }
  }

  /** HS-7968 — recycle the tile's xterm renderer + WebSocket without
   *  removing the tile from the registry. The PTY + scrollback stay alive
   *  server-side; on re-enter we re-mount + replay scrollback via the
   *  existing `mountTileXterm` + `connectTileSocket` path. */
  function softDisposeTile(tile: InternalTile): void {
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
    // Restore the placeholder visual so the off-screen-then-back-on tile
    // doesn't briefly show an empty white box during the re-mount window.
    tile.preview.replaceChildren(toElement(renderPreviewContent(tile.state, tile.exitCode)));
  }

  /** HS-7968 — force-mount a tile and update the virtualization state.
   *  Used by the click-before-IO defensive path in `centerTile` /
   *  `enterDedicatedView`-via-tile-click so the user doesn't briefly see a
   *  placeholder when the IntersectionObserver hadn't fired yet. */
  function ensureTileMounted(tile: InternalTile): void {
    if (tile.term !== null) return;
    mountTileXterm(tile);
    connectTileSocket(tile);
    const v = virtState.get(tile.entry.id);
    if (v !== undefined) virtState.set(tile.entry.id, { ...v, mounted: true });
    // If a dispose timer was pending (rare race), cancel it.
    const t = virtTimers.get(tile.entry.id);
    if (t !== undefined) { clearTimeout(t); virtTimers.delete(tile.entry.id); }
  }

  /** HS-7968 — fully forget the tile from the virtualization registry.
   *  Called from `disposeTile` on full teardown. */
  function forgetVirtualization(tile: InternalTile): void {
    if (virtObserver !== null) virtObserver.unobserve(tile.root);
    virtRootToId.delete(tile.root);
    const timer = virtTimers.get(tile.entry.id);
    if (timer !== undefined) { clearTimeout(timer); virtTimers.delete(tile.entry.id); }
    virtState.delete(tile.entry.id);
    // HS-8046 — drop the viewport-membership flag too so a re-rendered
    // tile with the same id starts from a clean slate.
    visibleTileIds.delete(tile.entry.id);
  }

  // --- xterm mount + WebSocket attach ---

  function resolveTileAppearance(tile: InternalTile) {
    const configOverride: { theme?: string; fontFamily?: string; fontSize?: number } = {};
    if (tile.entry.theme !== undefined) configOverride.theme = tile.entry.theme;
    if (tile.entry.fontFamily !== undefined) configOverride.fontFamily = tile.entry.fontFamily;
    if (tile.entry.fontSize !== undefined) configOverride.fontSize = tile.entry.fontSize;
    return resolveAppearance({
      projectDefault: getProjectDefault(),
      configOverride,
      sessionOverride: getSessionOverride(tile.entry.id),
    });
  }

  function mountTileXterm(tile: InternalTile): void {
    const xtermRoot = document.createElement('div');
    xtermRoot.className = xtermClass;
    tile.preview.replaceChildren(xtermRoot);

    const appearance = resolveTileAppearance(tile);
    const themeData = getThemeById(appearance.theme) ?? getThemeById('default')!;

    const term = new XTerm({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: false,
      // HS-7990 — was `scrollback: 0`. Bumping to 1000 lines lets the user
      // mouse-wheel through the back-buffer when a tile is centered /
      // magnified (the ticket's request — only the dedicated view supported
      // scrolling before). xterm allocates the scrollback ring lazily so a
      // quiet tile pays nearly zero; a chatty tile caps at ~5 MB at 160 cols
      // × 1000 lines × 32 bytes/cell. The HS-7968 virtualization disposes
      // off-screen tiles, so only the on-screen subset holds scrollback.
      scrollback: 1000,
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

    // HS-7097: observe `.xterm-screen` so every xterm render commits scaling.
    // HS-7603 follow-up: also re-run the cell-metrics → term/PTY resize logic
    // here. Tiles that mount while scrolled offscreen (or any tile where the
    // initial rAF / first history-frame fired before xterm had committed its
    // first paint to `.xterm-screen`) get `screen.offsetWidth === 0` and
    // `tileNativeDimsFromXterm` returns the fallback 80×60. Without this hook
    // the term + PTY stay locked to the fallback even after the user scrolls
    // the tile into view and xterm finally renders. The observer fires every
    // time `.xterm-screen` gets a new size, which is exactly the moment cell
    // metrics become authoritative — so we re-derive native dims and resize
    // the term + PTY whenever the computed native shape differs from what the
    // tile is currently sized to. The check is idempotent: once the term is
    // at native dims, subsequent observer fires recompute the same native and
    // skip the resize.
    const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
    if (screen !== null) {
      const observer = new ResizeObserver(() => {
        reapplyTileScaleFromPreview(tile);
        resyncTilePtyFromCellMetrics(tile);
      });
      observer.observe(screen);
      tile.screenObserver = observer;
    }
    requestAnimationFrame(() => {
      resyncTilePtyFromCellMetrics(tile);
      reapplyTileScaleFromPreview(tile);
    });

    const encoder = new TextEncoder();
    term.onData((data) => {
      if (tile.ws !== null && tile.ws.readyState === WebSocket.OPEN) {
        tile.ws.send(encoder.encode(data));
      }
    });
    term.onBell(() => {
      // HS-8046 — skip the indicator entirely when the user is already
      // viewing this tile in the unoccluded grid surface. Drop the
      // server-side bellPending flag too so other surfaces (project-tab
      // glyph, drawer tab) don't redundantly mark it.
      if (isGridSurfaceUnoccluded() && visibleTileIds.has(tile.entry.id)) {
        postClearBell(tile);
        return;
      }
      tile.root.classList.add('has-bell');
    });

    tile.term = term;
    tile.xtermRoot = xtermRoot;
  }

  function connectTileSocket(tile: InternalTile): void {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    // Omit cols/rows so the server skips the first-attach cleanup (HS-6799).
    const url = `${protocol}//${window.location.host}/api/terminal/ws`
      + `?project=${encodeURIComponent(tile.entry.secret)}`
      + `&terminal=${encodeURIComponent(tile.entry.id)}`;
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
            // HS-7097 follow-up: resize local xterm + the server-side PTY to
            // tile-native 4:3 so a running TUI redraws to fill the tile.
            // HS-7603: routed through `resyncTilePtyFromCellMetrics` so a
            // miss here (e.g. xterm hasn't committed its first paint to
            // `.xterm-screen` yet — common for tiles initially scrolled
            // offscreen) is recovered later by the `.xterm-screen`
            // ResizeObserver running the same pass once cell metrics
            // become authoritative.
            resyncTilePtyFromCellMetrics(tile);
          }
        } catch { /* non-JSON frame */ }
      }
    });
    ws.addEventListener('close', () => { tile.ws = null; });
    ws.addEventListener('error', () => { tile.ws = null; });
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

  /** HS-7603: re-derive the tile's native cols × rows from the latest
   *  `.xterm-screen` cell metrics and, if they differ from the term's current
   *  shape, resize the term + send a `'resize'` message to the server PTY.
   *  Idempotent — safe to call from rAF, the `.xterm-screen` ResizeObserver,
   *  and the history-frame handler without redundant resizes.
   *
   *  Skip-condition gates on BOTH the term's current `cols/rows` AND
   *  `tile.targetCols/Rows` (the last value we sent the server). `term.cols`
   *  on its own can lag the server: `replayHistoryToTerm` resizes the term
   *  down to the history frame's geometry (typically the drawer's narrower
   *  shape) and we need to push it back to native afterwards even though
   *  `tile.targetCols/Rows` is already at native from an earlier rAF pass.
   *  `tile.targetCols/Rows` on its own can lag the term: after a successful
   *  resize the term IS at native but skipping the server send would leave
   *  the PTY at whatever size another subscriber set it to. Both conditions
   *  must be satisfied to skip. */
  function resyncTilePtyFromCellMetrics(tile: InternalTile): void {
    if (tile.term === null || tile.xtermRoot === null) return;
    const native = tileNativeDimsFromXterm(tile.term, tile.xtermRoot);
    if (native === null) return;
    const termAlreadyNative = tile.term.cols === native.cols && tile.term.rows === native.rows;
    const targetAlreadyNative = tile.targetCols === native.cols && tile.targetRows === native.rows;
    if (termAlreadyNative && targetAlreadyNative) return;
    if (!termAlreadyNative) {
      try { tile.term.resize(native.cols, native.rows); } catch { /* disposed */ }
    }
    tile.targetCols = native.cols;
    tile.targetRows = native.rows;
    if (tile.ws !== null && tile.ws.readyState === WebSocket.OPEN) {
      try {
        tile.ws.send(JSON.stringify({ type: 'resize', cols: native.cols, rows: native.rows }));
      } catch { /* ws closed */ }
    }
  }

  // --- Tile sizing ---

  function applySizing(): void {
    const rootWidth = Math.max(0, opts.container.clientWidth - ROOT_PADDING * 2);
    if (rootWidth <= 0) return;
    const sliderValue = opts.getSliderValue();
    const tileWidth = tileWidthFromSlider(sliderValue, rootWidth);
    const tileHeight = Math.round(tileWidth / TILE_ASPECT);

    for (const tile of opts.container.querySelectorAll<HTMLElement>(`.${tileClass}`)) {
      if (!tile.classList.contains('centered')) {
        tile.style.width = `${tileWidth}px`;
      }
      const preview = tile.querySelector<HTMLElement>(`.${previewClass}`);
      if (preview !== null && !tile.classList.contains('centered')) {
        preview.style.width = `${tileWidth}px`;
        preview.style.height = `${tileHeight}px`;
      }
      const xtermRoot = tile.querySelector<HTMLElement>(`.${xtermClass}`);
      if (xtermRoot !== null && !tile.classList.contains('centered')) {
        applyTileScale(xtermRoot, tileWidth, tileHeight);
      }
      const tid = tile.dataset.terminalId ?? '';
      const live = tiles.get(tid);
      if (live !== undefined) {
        live.gridPreviewWidth = tileWidth;
        live.gridPreviewHeight = tileHeight;
      }
    }
  }

  function reapplyTileScaleFromPreview(tile: InternalTile): void {
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

  // --- Click → center / dblclick → dedicated ---

  function onTileClick(tile: InternalTile, e: MouseEvent): void {
    e.stopPropagation();
    if (pendingSingleClickTimer !== null) window.clearTimeout(pendingSingleClickTimer);
    pendingSingleClickTimer = window.setTimeout(() => {
      pendingSingleClickTimer = null;
      if (tile.state !== 'alive') {
        void spawnAndEnlarge(tile, 'center');
        return;
      }
      if (centered === tile) {
        uncenterTile();
        return;
      }
      if (centered !== null) uncenterTile();
      centerTile(tile);
    }, SINGLE_CLICK_DELAY_MS);
  }

  function onTileDblClick(tile: InternalTile, e: MouseEvent): void {
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
    const prior = centered === tile ? null : centered;
    if (centered === tile) uncenterTile();
    try { enterDedicatedView(tile, prior); }
    catch (err) { console.error('terminalTileGrid: enterDedicatedView failed', err); }
  }

  async function spawnAndEnlarge(tile: InternalTile, target: 'center' | 'dedicated'): Promise<void> {
    const wasExited = tile.state === 'exited';
    tile.preview.replaceChildren(toElement(
      <div className={`${placeholderClass} ${placeholderStartingClass}`}>
        <span>Starting…</span>
      </div>
    ));
    try {
      if (wasExited) {
        await apiWithSecret('/terminal/restart', tile.entry.secret, {
          method: 'POST',
          body: { terminalId: tile.entry.id },
        });
      }
      tile.state = 'alive';
      tile.exitCode = null;
      tile.root.classList.remove(`${tileClass}-not_spawned`, `${tileClass}-exited`);
      tile.root.classList.add(`${tileClass}-alive`);
      mountTileXterm(tile);
      connectTileSocket(tile);
      // HS-7968 — flag the tile as mounted in the virtualization state so
      // an immediate viewport-exit triggers the dispose-debounce flow.
      const v = virtState.get(tile.entry.id);
      if (v !== undefined) virtState.set(tile.entry.id, { ...v, mounted: true });
    } catch (err) {
      console.error('terminalTileGrid: spawn failed', err);
      tile.preview.replaceChildren(toElement(renderPreviewContent(tile.state, tile.exitCode)));
      return;
    }
    if (target === 'center') centerTile(tile);
    else enterDedicatedView(tile, null);
  }

  // --- Centered overlay (FLIP animation, §25.7 / HS-6867) ---

  function getCenterReferenceRect(): DOMRect {
    if (opts.centerScope === 'viewport') {
      // Use the visual viewport so the centered tile tracks the window.
      return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    }
    const el = opts.centerReferenceEl ?? opts.container;
    return el.getBoundingClientRect();
  }

  function centerTile(tile: InternalTile): void {
    centered = tile;
    clearTileBell(tile);
    if (opts.onTileEnlarge !== undefined) opts.onTileEnlarge(tile.entry, 'center');
    // HS-7968 — defend against the click-before-IO race: if an alive tile
    // hasn't been mounted yet (the IntersectionObserver callback hadn't run
    // before the click landed), force-mount now so the centered tile shows
    // the live terminal instead of an empty placeholder.
    if (tile.state === 'alive' && tile.term === null) {
      ensureTileMounted(tile);
    }

    const origRect = tile.root.getBoundingClientRect();
    const placeholder = createSlotPlaceholder(origRect.width, origRect.height);
    tile.slotPlaceholder = placeholder;
    tile.root.parentElement?.insertBefore(placeholder, tile.root);

    const refRect = getCenterReferenceRect();
    const availWidth = refRect.width * opts.centerSizeFrac;
    const availHeight = refRect.height * opts.centerSizeFrac;
    const previewWidth = Math.min(availWidth, availHeight * TILE_ASPECT);
    const previewHeight = previewWidth / TILE_ASPECT;
    const targetLeft = refRect.left + (refRect.width - previewWidth) / 2;
    const targetTop = refRect.top + (refRect.height - previewHeight) / 2;

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

  function recenterTile(): void {
    if (centered === null || !centered.root.classList.contains('centered')) return;
    const refRect = getCenterReferenceRect();
    const availWidth = refRect.width * opts.centerSizeFrac;
    const availHeight = refRect.height * opts.centerSizeFrac;
    const previewWidth = Math.min(availWidth, availHeight * TILE_ASPECT);
    const previewHeight = previewWidth / TILE_ASPECT;
    const targetLeft = refRect.left + (refRect.width - previewWidth) / 2;
    const targetTop = refRect.top + (refRect.height - previewHeight) / 2;

    const tile = centered;
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
    if (centered === null) return;
    const tile = centered;
    const placeholder = tile.slotPlaceholder;
    centered = null;
    removeCenterBackdrop();
    if (opts.onTileShrink !== undefined) opts.onTileShrink(tile.entry);

    if (placeholder === null) { finishUncenterTile(tile, null); return; }
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
    window.setTimeout(() => {
      tile.root.removeEventListener('transitionend', onEnd);
      if (tile.slotPlaceholder === placeholder) finishUncenterTile(tile, placeholder);
    }, CENTER_ANIMATION_MS + 80);
  }

  function finishUncenterTile(tile: InternalTile, placeholder: HTMLElement | null): void {
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
    // HS-8046 — uncentering returns the user to the unoccluded grid view;
    // bells that piled up behind the centered overlay are now visible and
    // should auto-clear (the user IS looking at them).
    clearBellsForVisibleTiles();
  }

  function createSlotPlaceholder(width: number, height: number): HTMLElement {
    const el = document.createElement('div');
    el.className = slotClass;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    return el;
  }

  function mountCenterBackdrop(): void {
    if (centerBackdrop !== null) return;
    const backdrop = document.createElement('div');
    backdrop.className = backdropClass;
    backdrop.addEventListener('click', () => { uncenterTile(); });
    if (opts.centerScope === 'viewport') {
      document.body.appendChild(backdrop);
    } else {
      const target = opts.centerReferenceEl ?? opts.container;
      target.appendChild(backdrop);
    }
    centerBackdrop = backdrop;
  }

  function removeCenterBackdrop(): void {
    if (centerBackdrop === null) return;
    centerBackdrop.remove();
    centerBackdrop = null;
  }

  function clearTileBell(tile: InternalTile): void {
    if (!tile.root.classList.contains('has-bell')) return;
    tile.root.classList.remove('has-bell');
    postClearBell(tile);
  }

  /** HS-8046 — POST `/clear-bell` for a tile WITHOUT first checking the
   *  class. Used by the auto-clear path: when a bell tries to land on a
   *  tile the user is already looking at, we want to drop the server's
   *  `bellPending` flag without ever rendering the indicator locally. */
  function postClearBell(tile: InternalTile): void {
    void apiWithSecret('/terminal/clear-bell', tile.entry.secret, {
      method: 'POST',
      body: { terminalId: tile.entry.id },
    }).catch(() => { /* server restart / network blip — long-poll resyncs */ });
  }

  /** HS-8046 — true when nothing is occluding the grid layout, so a tile
   *  in the viewport really IS the surface the user is looking at. While
   *  a centered overlay or dedicated view is up, the rest of the grid is
   *  visually behind / hidden, so bells for those tiles should NOT
   *  auto-clear (the user can't actually see them). */
  function isGridSurfaceUnoccluded(): boolean {
    return centered === null && dedicated === null;
  }

  /** HS-8046 — set of tileIds whose root is currently inside the
   *  IntersectionObserver's viewport. Updated by `handleIntersectionEntries`
   *  on every enter / exit transition. Used to gate the auto-clear path. */
  const visibleTileIds = new Set<string>();

  /** HS-8046 — clear the bell for `tile` when (a) the grid surface is
   *  unoccluded (no centered overlay / dedicated view) AND (b) the tile
   *  root is currently in the viewport. The user is actively looking at
   *  this terminal — no reason to keep the bell indicator. */
  function maybeAutoClearTileBell(tile: InternalTile): void {
    if (!isGridSurfaceUnoccluded()) return;
    if (!visibleTileIds.has(tile.entry.id)) return;
    clearTileBell(tile);
  }

  /** HS-8046 — sweep every currently-visible tile for `has-bell`, called
   *  whenever the grid surface becomes unoccluded again (centered or
   *  dedicated view dismissed). Bells that accumulated WHILE the
   *  occluding view was up are now visible to the user; auto-clear them. */
  function clearBellsForVisibleTiles(): void {
    for (const id of visibleTileIds) {
      const t = tiles.get(id);
      if (t === undefined) continue;
      clearTileBell(t);
    }
  }

  // --- Dedicated full-pane view (§25.8 / §36.5 / HS-7063 / HS-7098) ---

  function enterDedicatedView(tile: InternalTile, priorCenteredTile: InternalTile | null): void {
    if (dedicated !== null) exitDedicatedView();
    clearTileBell(tile);
    if (opts.onTileEnlarge !== undefined) opts.onTileEnlarge(tile.entry, 'dedicated');

    const overlay = toElement(
      <div className={dedicatedClass} data-secret={tile.entry.secret} data-terminal-id={tile.entry.id}>
        <div className={dedicatedBarClass}>
          <button className={dedicatedBackClass} title="Back to grid">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>
            <span>Back</span>
          </button>
          <div className={dedicatedLabelClass}>{tile.entry.label}</div>
        </div>
        <div className={dedicatedBodyClass}>
          <div className={dedicatedPaneClass}></div>
        </div>
      </div>
    );
    // Append the overlay relative to the appropriate scope so the dedicated
    // view occupies the same area the grid does. Dashboard uses
    // 'viewport' -> append to the dashboard root (which has fixed position
    // anyway); drawer uses 'container' -> append into the grid container.
    const dedicatedHost = opts.centerScope === 'viewport'
      ? (opts.centerReferenceEl ?? opts.container)
      : opts.container;
    dedicatedHost.appendChild(overlay);

    const pane = overlay.querySelector<HTMLElement>(`.${dedicatedPaneClass}`);
    const backBtn = overlay.querySelector<HTMLElement>(`.${dedicatedBackClass}`);
    const bar = overlay.querySelector<HTMLElement>(`.${dedicatedBarClass}`);
    const dedicatedBody = overlay.querySelector<HTMLElement>(`.${dedicatedBodyClass}`);
    if (pane === null || backBtn === null || bar === null) return;
    // HS-8012 — the prompt overlay used to capture `dedicatedBody ?? pane`
    // here so it could mount inside the dedicated view. It now mounts on
    // `document.body` and anchors below the project tab, so the closure
    // no longer needs an in-pane anchor. `dedicatedBody` is still used
    // below to apply the per-theme background colour.
    backBtn.addEventListener('click', () => { exitDedicatedView(); });

    const appearance = resolveTileAppearance(tile);
    const themeData = getThemeById(appearance.theme) ?? getThemeById('default')!;
    // HS-7960 — paint the dedicated-body padded gutter with the active
    // theme's bg so the area around the xterm canvas reads as part of the
    // terminal frame, matching the drawer's HS-7960 treatment.
    if (dedicatedBody !== null) dedicatedBody.style.backgroundColor = themeData.background;

    // HS-8042 — dedicated view is a `terminalCheckout` consumer. Pre-fix
    // it spawned its own xterm + WebSocket attached to the same PTY,
    // duplicating resources for any terminal already mounted in a tile.
    // The migration claims the live xterm into the dedicated pane via
    // checkout; the tile's existing mount drops to the §54.3.2
    // placeholder; on exit the handle releases and the xterm reparents
    // back. The `cols`/`rows` initial-checkout values are placeholders —
    // `fit.fit()` runs in the next frame to resolve real dims from the
    // pane's measured layout, then `applyResizeIfChanged` inside
    // checkout fires the real resize via `term.onResize` below.
    const handle = checkout({
      projectSecret: tile.entry.secret,
      terminalId: tile.entry.id,
      cols: TILE_INITIAL_COLS,
      rows: TILE_INITIAL_ROWS,
      mountInto: pane,
    });
    const term = handle.term;
    const fit = handle.fit;

    // Apply appearance + per-consumer term tweaks. The xterm is shared
    // across consumers via the checkout module, so settings written here
    // persist on the term — when this dedicated view releases and the
    // tile's checkout (if any) regains top-of-stack, the tile sees the
    // theme/font we set. That's fine — both surfaces resolve appearance
    // for the same `(secret, terminalId)` so the values match.
    term.options.theme = themeToXtermOptions(themeData);
    term.options.linkHandler = {
      activate: (_event, text) => { openExternalUrl(text); },
    };
    term.loadAddon(new WebLinksAddon((_event, uri) => { openExternalUrl(uri); }));
    void applyAppearanceToTerm(term, appearance);
    // HS-7594 — swallow Cmd/Ctrl+` so the document-level toggle dispatcher
    // sees it instead of the shell receiving a backtick.
    term.attachCustomKeyEventHandler((e) => {
      if (isTerminalViewToggleShortcut(e) !== null) return false;
      return true;
    });

    const runFit = (): void => {
      try {
        fit.fit();
        // HS-8042 — propagate the fit() result to the checkout entry's
        // last-applied dims so a subsequent same-size handoff (e.g.
        // tile's checkout regains top-of-stack at its own dims) won't
        // skip an actually-different resize. The `term.onResize` below
        // fires after fit() and sends the WS resize frame; without
        // updating the entry's bookkeeping we'd risk a stale lastApplied.
      } catch { /* not ready */ }
    };
    requestAnimationFrame(runFit);
    const bodyResizeObserver = new ResizeObserver(runFit);
    bodyResizeObserver.observe(pane);

    // HS-8042 — `term.onData` is wired by the checkout module's WS
    // attachment; we don't need to add another handler here. (Pre-fix
    // dedicated had its own ws.send onData wiring because it owned a
    // separate WS; checkout's WS handler now serves both tile and
    // dedicated for the same terminal.)
    //
    // `term.onResize` fires when `fit.fit()` resolves the pane's
    // measured dims — route the new size through `handle.resize` so
    // the checkout module sends the WS resize frame AND updates the
    // entry's `lastAppliedCols/Rows` bookkeeping (so a future stack
    // swap to a different-size consumer doesn't skip-on-same-size
    // erroneously). The skip rule inside `handle.resize` itself is the
    // SIGWINCH-storm guard for idempotent fit() calls.
    term.onResize(({ cols, rows }) => {
      handle.resize(cols, rows);
    });

    let barDispose: (() => void) | null = null;
    if (opts.onDedicatedBarMount !== undefined) {
      const result = opts.onDedicatedBarMount(bar, tile.entry, term);
      if (typeof result === 'function') barDispose = result;
    }

    dedicated = { tile, overlay, checkout: handle, term, fit, bodyResizeObserver, priorCenteredTile, barDispose };
    queueMicrotask(() => { term.focus(); });
  }

  function exitDedicatedView(): void {
    if (dedicated === null) return;
    const view = dedicated;
    dedicated = null;
    view.bodyResizeObserver?.disconnect();
    if (view.barDispose !== null) {
      try { view.barDispose(); } catch { /* swallow */ }
    }
    // HS-8042 — release the checkout instead of disposing the term/ws
    // directly. If the tile's own checkout is still in the LIFO stack
    // (the common case — the user double-clicked a mounted tile), the
    // live xterm DOM-reparents back to the tile's `xtermRoot` and the
    // tile's preview becomes interactive again. If the tile's checkout
    // is empty (rare — the tile was virtualized off-screen between
    // dedicated entry and exit), the entry is fully disposed and the
    // tile re-mounts on its next viewport-enter.
    view.checkout.release();
    view.overlay.remove();
    if (opts.onTileShrink !== undefined) opts.onTileShrink(view.tile.entry);

    // HS-7097: re-claim the tile PTY at tile-native dims.
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

    applySizing();
    if (view.priorCenteredTile !== null) {
      centerTile(view.priorCenteredTile);
    } else {
      // HS-8046 — exiting dedicated view (with no centered fallback)
      // returns the user to the unoccluded grid; sweep visible tiles for
      // bells that piled up while the dedicated view was up.
      clearBellsForVisibleTiles();
    }
  }

  // --- Tile teardown ---

  function disposeTile(tile: InternalTile): void {
    forgetVirtualization(tile);
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

  function teardownAll(): void {
    if (dedicated !== null) exitDedicatedView();
    if (centered !== null) {
      if (centered.slotPlaceholder !== null) centered.slotPlaceholder.remove();
      centered.root.classList.remove('centered');
      centered.root.style.transition = '';
      centered.root.style.transform = '';
      centered = null;
    }
    removeCenterBackdrop();
    for (const tile of tiles.values()) disposeTile(tile);
    tiles.clear();
    if (pendingSingleClickTimer !== null) {
      window.clearTimeout(pendingSingleClickTimer);
      pendingSingleClickTimer = null;
    }
    // HS-7968 — drop every pending dispose timer + disconnect the observer.
    // `disposeTile` already cleared per-tile state via `forgetVirtualization`,
    // but the observer instance + any orphaned timers (none expected, but
    // defensive) need an explicit disconnect.
    for (const t of virtTimers.values()) clearTimeout(t);
    virtTimers.clear();
    virtState.clear();
    virtRootToId.clear();
    visibleTileIds.clear();
    if (virtObserver !== null) virtObserver.disconnect();
  }

  // --- Public handle ---

  return {
    rebuild(entries) {
      teardownAll();
      opts.container.replaceChildren();
      for (const entry of entries) {
        opts.container.appendChild(renderTile(entry));
      }
      applySizing();
    },
    applySizing,
    recenterTile,
    uncenterTile,
    exitDedicatedView,
    syncBellState(pendingIds) {
      for (const tile of tiles.values()) {
        const want = pendingIds.has(tile.entry.id);
        const has = tile.root.classList.contains('has-bell');
        if (want && !has) {
          // HS-8046 — server-pushed bellPending lands on a tile the user
          // is already looking at. Drop the server flag instead of
          // rendering the indicator.
          if (isGridSurfaceUnoccluded() && visibleTileIds.has(tile.entry.id)) {
            postClearBell(tile);
          } else {
            tile.root.classList.add('has-bell');
          }
        } else if (!want && has) {
          tile.root.classList.remove('has-bell');
        }
      }
    },
    focusDedicatedTerm() {
      if (dedicated === null) return;
      try { dedicated.term.focus(); } catch { /* term disposed */ }
    },
    isCentered() { return centered !== null; },
    isDedicatedOpen() { return dedicated !== null; },
    dispose() { teardownAll(); },
  };
}
