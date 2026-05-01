import type { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Terminal as XTerm } from '@xterm/xterm';

import { apiWithSecret } from './api.js';
import { toElement } from './dom.js';
import { type NavRect, pickGridNeighbourIndex } from './gridNavGeometry.js';
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
import { type GridNavDirection, isMagnifiedNavShortcut, isTerminalViewToggleShortcut } from './terminalKeybindings.js';
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
  /** HS-8048 — tile's `terminalCheckout` handle. Null when the tile is
   *  unmounted (lazy / virtualized / not yet rendered). The handle's
   *  `term` field is the live xterm; `xtermRoot` (the DOM container we
   *  pass as `mountInto`) holds the xterm element when the tile is at
   *  the top of the LIFO stack, or a "Terminal in use elsewhere"
   *  placeholder when bumped down by another consumer (dedicated view,
   *  quit-confirm, etc.). On `release()` an empty stack disposes the
   *  entry; otherwise the next-most-recent consumer regains the live
   *  xterm. */
  checkout: CheckoutHandle | null;
  xtermRoot: HTMLElement | null;
  gridPreviewWidth: number;
  gridPreviewHeight: number;
  /** Tile-native cols × rows the WebSocket history handler resized the PTY
   *  to (HS-7097). Used on dedicated-view exit to re-claim the PTY at the
   *  tile's geometry rather than the dedicated pane's. */
  targetCols: number;
  targetRows: number;
  /** HS-8051 follow-up #2 — cell metrics measured from `.xterm-screen`
   *  on the FIRST `term.onRender` after mount, when `term.cols/rows` and
   *  `screen.offsetWidth/Height` are guaranteed consistent (onRender
   *  fires AFTER xterm commits the paint to DOM). Pre-fix the chained-
   *  rAF resync re-derived `cellW = screen.offsetWidth / term.cols` on
   *  every tick — but `term.cols` updates synchronously on `term.resize`
   *  while screen dims only update on the next paint. Between paints the
   *  ratio gives a wrong cellW, the algorithm produces a wrong target,
   *  the next resize uses that wrong target, and the loop oscillates
   *  (user's HS-8051 second log: bad tile bounced from 1692×1200 to
   *  841×1200 — 80→61→46→… or similar non-converging chain). Caching
   *  cellW once at a stable state and reusing it eliminates the race —
   *  cellW depends on font, not cols, so it's stable across resizes
   *  unless the font itself changes. */
  cachedCellW: number | null;
  cachedCellH: number | null;
  slotPlaceholder: HTMLElement | null;
  screenObserver: ResizeObserver | null;
  /** HS-8048 — disposers for term-level event handlers we set up during
   *  `mountTileViaCheckout` (`term.onBell`). Pre-fix these handlers were
   *  on the tile's own xterm so they died when the tile's xterm was
   *  disposed. With shared xterm via checkout, they survive across
   *  consumers — we MUST dispose them on release / softDispose otherwise
   *  a re-mount of the tile would stack a second `onBell` on top of the
   *  first. */
  termHandlerDisposers: Array<{ dispose(): void }>;
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
      checkout: null,
      xtermRoot: null,
      gridPreviewWidth: 0,
      gridPreviewHeight: 0,
      targetCols: TILE_INITIAL_COLS,
      targetRows: TILE_INITIAL_ROWS,
      cachedCellW: null,
      cachedCellH: null,
      slotPlaceholder: null,
      screenObserver: null,
      termHandlerDisposers: [],
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
      mountTileViaCheckout(tile);
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
            mountTileViaCheckout(tile);
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

  /** HS-7968 + HS-8048 — release the tile's checkout handle without
   *  removing the tile from the registry. The PTY + scrollback stay alive
   *  server-side; on re-enter we re-mount via `mountTileViaCheckout` (a
   *  fresh `checkout()` call creates a new entry if none exists, or
   *  pushes onto an existing one if another consumer like the dedicated
   *  view kept the entry alive). HS-8048 — pre-fix this disposed the
   *  tile's own xterm + ws directly; post-fix `release()` either disposes
   *  the entry on empty stack (matches pre-fix shape) or hands the live
   *  xterm back to the next consumer (which would only happen if a
   *  dedicated/quit-confirm view is up for the same terminal-id, in
   *  which case the tile being virtualized off-screen leaving the
   *  dedicated as the sole consumer is exactly the right outcome). */
  function softDisposeTile(tile: InternalTile): void {
    tile.screenObserver?.disconnect();
    tile.screenObserver = null;
    for (const d of tile.termHandlerDisposers) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
    tile.termHandlerDisposers = [];
    if (tile.checkout !== null) {
      try { tile.checkout.release(); } catch { /* already released */ }
      tile.checkout = null;
    }
    tile.xtermRoot = null;
    tile.cachedCellW = null;
    tile.cachedCellH = null;
    // HS-8059 — drop the inline theme-bg so the placeholder's own bg
    // (`--bg-secondary` for cold/exited; the cold-card bg) paints instead
    // of the previous live xterm's theme.
    tile.preview.style.backgroundColor = '';
    // Restore the placeholder visual so the off-screen-then-back-on tile
    // doesn't briefly show an empty white box during the re-mount window.
    tile.preview.replaceChildren(toElement(renderPreviewContent(tile.state, tile.exitCode)));
  }

  /** HS-7968 + HS-8048 — force-mount a tile and update the virtualization
   *  state. Used by the click-before-IO defensive path in `centerTile` /
   *  `enterDedicatedView`-via-tile-click so the user doesn't briefly see
   *  a placeholder when the IntersectionObserver hadn't fired yet. */
  function ensureTileMounted(tile: InternalTile): void {
    if (tile.checkout !== null) return;
    mountTileViaCheckout(tile);
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

  /**
   * HS-8048 — mount the tile via the `terminalCheckout` LIFO stack
   * instead of constructing a per-tile `XTerm` + `WebSocket`. The
   * checkout module owns the live xterm + WS for this terminal and
   * shares them across consumers (this tile, plus any dedicated-view
   * or quit-confirm-preview also looking at the same terminal). The
   * `mountInto` argument is the per-tile `xtermRoot` div — when this
   * tile is the LIFO top, the live xterm element is reparented into
   * that div; when bumped down, a "Terminal in use elsewhere"
   * placeholder is written into it instead.
   *
   * Replaces pre-fix `mountTileXterm` (per-tile `new XTerm({...})` +
   * `term.open(xtermRoot)` + appearance + `term.onData(ws.send)` +
   * `term.onBell`) AND `connectTileSocket` (per-tile `new WebSocket` +
   * `'message'` listener with history-frame handling). Pre-fix
   * cursorBlink=false + scrollback=1000 (HS-7990) — post-fix unified to
   * checkout's shared defaults (`cursorBlink: true, scrollback: 10_000`)
   * since per-consumer xterm option overrides on every stack swap is
   * fragile (scrollback reduction at runtime can lose history). The
   * 10× scrollback bump for tiles is fine — xterm allocates lazily and
   * the HS-7968 virtualization disposes off-screen tiles via release()
   * so only the on-screen subset pays for the buffer.
   */
  function mountTileViaCheckout(tile: InternalTile): void {
    const xtermRoot = document.createElement('div');
    xtermRoot.className = xtermClass;
    tile.preview.replaceChildren(xtermRoot);

    const appearance = resolveTileAppearance(tile);
    const themeData = getThemeById(appearance.theme) ?? getThemeById('default')!;
    // HS-8059 — paint the tile preview's frame with the live theme bg so the
    // sub-cell slop on the right + bottom of `.xterm-screen` (xterm sizes the
    // canvas at exactly cols × cellW × rows × cellH, ≤ the preview's content
    // area) reads as part of the terminal frame rather than a contrasting
    // app-bg gutter. Mirrors the §22 drawer treatment (`terminal-body` HS-7960)
    // and the §37 quit-confirm preview (HS-8058). Cleared in `softDisposeTile`
    // + the `Starting…` placeholder branches so the placeholder's own
    // `--bg-secondary` still shows through.
    tile.preview.style.backgroundColor = themeData.background;

    const handle = checkout({
      projectSecret: tile.entry.secret,
      terminalId: tile.entry.id,
      cols: TILE_INITIAL_COLS,
      rows: TILE_INITIAL_ROWS,
      mountInto: xtermRoot,
      onBumpedDown() {
        // HS-8048 — another consumer (dedicated view, quit-confirm
        // preview, etc.) just took the live xterm. Disconnect the
        // tile's screen ResizeObserver so its callback doesn't fire
        // on the placeholder content (the placeholder div doesn't
        // contain a `.xterm-screen` anyway, but the observer would
        // still need to be re-attached on restore).
        tile.screenObserver?.disconnect();
        tile.screenObserver = null;
      },
      onRestoredToTop() {
        // HS-8048 — live xterm reparented back into our `xtermRoot`.
        // Re-apply CSS scale (the previous consumer's mount may have
        // cleared transform/position styles). The screen ResizeObserver
        // re-attaches here too so subsequent renders fire the visual
        // scale recompute. HS-8051 follow-up #2 — convergence on tile-
        // native cols × rows is driven by `term.onRender` →
        // `handleTileRender` (which we wired once at mount time and is
        // still alive across the bump-and-restore round-trip since the
        // shared term itself survives). The next render after the
        // restore — triggered by either xterm's dirty repaint or the
        // first incoming output byte — will re-converge the term to
        // tile-native via `handleTileRender`'s cell-metric path. We
        // also kick a `checkout.resize(TILE_INITIAL_*)` here as the
        // explicit signal so the convergence happens promptly even
        // without external output.
        tile.checkout?.resize(TILE_INITIAL_COLS, TILE_INITIAL_ROWS);
        reapplyTileScaleFromPreview(tile);
        attachScreenObserver(tile);
      },
    });

    const term = handle.term;
    // HS-8048 — apply tile-flavoured term tweaks. These persist on the
    // shared term across consumers, but they're idempotent: a follow-up
    // dedicated-view checkout will overwrite them with its own values.
    term.options.theme = themeToXtermOptions(themeData);
    term.options.linkHandler = {
      activate: (_event, text) => { openExternalUrl(text); },
    };
    void applyAppearanceToTerm(term, appearance);

    tile.checkout = handle;
    tile.xtermRoot = xtermRoot;
    tile.targetCols = term.cols;
    tile.targetRows = term.rows;

    // HS-7097 → HS-8051 follow-up #2 — observe `.xterm-screen` so a
    // change in natural xterm dims (font / theme swap; consumer
    // hand-off) re-applies the CSS scale. Convergence on tile-native
    // cols × rows is driven by `term.onRender` (wired below) — the
    // observer is just a safety net for the visual scale.
    attachScreenObserver(tile);

    // HS-8048 — `term.onData` (keystroke-send) is wired by the checkout
    // module's WS attachment so every consumer of the shared xterm gets
    // it for free. Just register `term.onBell` for the per-tile
    // indicator + auto-clear logic from HS-8046, and capture the
    // disposer so a soft-dispose / release of this tile doesn't leave a
    // stale handler attached to the shared term.
    const bellDispose = term.onBell(() => {
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
    tile.termHandlerDisposers.push(bellDispose);

    // HS-8051 follow-up #2 — the convergence path that drives the tile to
    // its 4:3 native cols × rows. `term.onRender` fires AFTER xterm
    // commits a paint to DOM, so `term.cols/rows` and
    // `screen.offsetWidth/Height` are guaranteed consistent at this
    // moment — every other timing (rAF, ResizeObserver, history-frame
    // handler) can race a pending paint and read stale dims. The
    // sequence in steady state:
    //   1. First render after mount → cellW/cellH measured + cached →
    //      compute target dims → `checkout.resize(native)` if not
    //      already there.
    //   2. Second render (caused by step 1's resize) → `term.cols` is
    //      now at native, target also at native → no-op return.
    //   3. Subsequent renders (output, scrolling) → no-op return.
    // Pre-fix the chained-rAF retry oscillated because it re-derived
    // `cellW = screen.offsetWidth / term.cols` between paint frames
    // where `term.cols` had updated but the screen hadn't. User's HS-8051
    // second log: bad tile bounced from 1692×1200 (cols=80) to 841×1200
    // (cols=40) — non-converging because cellW was being re-computed
    // from a wrong ratio every iteration.
    const renderDispose = term.onRender(() => {
      handleTileRender(tile);
    });
    tile.termHandlerDisposers.push(renderDispose);
  }

  /** HS-8051 follow-up #2 — runs on every `term.onRender` for a tile.
   *  Caches cell metrics on the first render where they're measurable,
   *  re-applies CSS scale, and (when top-of-stack) issues at most one
   *  resize per render to converge on the cell-metric-derived 4:3
   *  native cols × rows. */
  function handleTileRender(tile: InternalTile): void {
    if (tile.checkout === null || tile.xtermRoot === null) return;
    const term = tile.checkout.term;
    const screen = tile.xtermRoot.querySelector<HTMLElement>('.xterm-screen');
    if (screen === null) return;
    if (term.cols <= 0 || term.rows <= 0) return;
    if (screen.offsetWidth <= 0 || screen.offsetHeight <= 0) return;

    // Re-measure cellW/cellH on EVERY render — this is safe because
    // onRender fires after the paint committed, so screen dims and
    // `term.cols` are always consistent here. Cell metrics are stable
    // unless the font / theme changes, in which case re-measurement
    // automatically picks up the new values without any explicit
    // invalidation path.
    const cellW = screen.offsetWidth / term.cols;
    const cellH = screen.offsetHeight / term.rows;
    if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return;
    tile.cachedCellW = cellW;
    tile.cachedCellH = cellH;

    // Always re-apply the visual CSS scale so the natural xterm box fills
    // the tile slot uniformly.
    reapplyTileScaleFromPreview(tile);

    // Resize the term + PTY toward the 4:3 native target only when WE
    // own the live xterm. When another consumer (dedicated view, quit-
    // confirm preview) is on top of the LIFO stack, the screen dims
    // we measured here belong to THAT consumer's mount — we still
    // refresh `cachedCellW/H` (cellW is font-driven, not consumer-driven)
    // but skip the resize so we don't fight the active consumer.
    if (!tile.checkout.isTopOfStack()) return;
    const native = tileNativeGridFromCellMetrics(cellW, cellH);
    if (term.cols === native.cols && term.rows === native.rows) {
      // Already at native — sync the bookkeeping so a future
      // `release()` → `restore()` round-trip's safe-stop also recognises
      // convergence.
      tile.targetCols = native.cols;
      tile.targetRows = native.rows;
      return;
    }
    tile.targetCols = native.cols;
    tile.targetRows = native.rows;
    tile.checkout.resize(native.cols, native.rows);
  }

  /** HS-8048 → HS-8051 follow-up #2 — wire (or rewire) the tile's
   *  `.xterm-screen` ResizeObserver. Now ONLY drives the CSS-scale re-fit
   *  when natural xterm dims change (font/theme swap; consumer hand-off);
   *  the cell-metric → native-cols/rows convergence path lives in
   *  `handleTileRender` (driven by `term.onRender`), which is the only
   *  signal that fires after a paint commits with consistent
   *  `term.cols/rows` ↔ `screen.offsetWidth/Height` state.
   *
   *  Idempotent — safe to call from `onRestoredToTop` (the live xterm
   *  came back with its own `.xterm-screen` element) without doubling
   *  observer fires. `.xterm-screen` is created lazily by xterm on its
   *  first render; if it isn't there yet we retry on the next rAF up to
   *  a small budget. The first `term.onRender` will fire by then anyway
   *  (and that's what drives convergence), so this is just a safety net
   *  for the visual scale. */
  function attachScreenObserver(tile: InternalTile, retriesRemaining: number = 30): void {
    if (tile.xtermRoot === null) return;
    if (tile.checkout === null) return;
    tile.screenObserver?.disconnect();
    const screen = tile.xtermRoot.querySelector<HTMLElement>('.xterm-screen');
    if (screen === null) {
      if (retriesRemaining > 0) {
        requestAnimationFrame(() => { attachScreenObserver(tile, retriesRemaining - 1); });
      }
      return;
    }
    const observer = new ResizeObserver(() => {
      reapplyTileScaleFromPreview(tile);
    });
    observer.observe(screen);
    tile.screenObserver = observer;
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
    // HS-8059 — clear the inline theme-bg so the `Starting…` card uses its
    // own `--bg-secondary` instead of being painted with the previous mount's
    // theme bg.
    tile.preview.style.backgroundColor = '';
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
      mountTileViaCheckout(tile);
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
    // HS-8028 — install the magnified-nav keyboard listener (Shift+Cmd+
    // Arrow on macOS / Shift+Ctrl+Arrow elsewhere). Idempotent — the
    // helper only attaches once even on rapid re-centers.
    bindMagnifiedNavHandler();
    // HS-7968 — defend against the click-before-IO race: if an alive tile
    // hasn't been mounted yet (the IntersectionObserver callback hadn't run
    // before the click landed), force-mount now so the centered tile shows
    // the live terminal instead of an empty placeholder.
    if (tile.state === 'alive' && tile.checkout === null) {
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

    queueMicrotask(() => { tile.checkout?.term.focus(); });
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
    // HS-8028 — uncentering returns the user to the bare grid; the
    // magnified-nav handler is no longer relevant (no magnified target
    // to navigate from). Only unbind when no dedicated view is up
    // either — `enterDedicatedView` may have called `uncenterTile`
    // internally on an open centered tile, in which case the nav
    // handler must stay armed for the dedicated path.
    if (dedicated === null) unbindMagnifiedNavHandler();
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

  // --- HS-8028 magnified-nav (Shift+Cmd+Arrow) ---

  /** Capture-phase document keydown listener that fires while a tile is
   *  centered or dedicated. Captures BEFORE xterm's customKeyEventHandler
   *  so the chord doesn't get translated into shell escape sequences,
   *  and uses `preventDefault` + `stopPropagation` to ensure xterm sees
   *  no event at all. Bound idempotently by `bindMagnifiedNavHandler`,
   *  unbound on the last-magnified-state exit by
   *  `unbindMagnifiedNavHandler`. */
  let magnifiedNavListener: ((e: KeyboardEvent) => void) | null = null;

  function bindMagnifiedNavHandler(): void {
    if (magnifiedNavListener !== null) return;
    magnifiedNavListener = (e: KeyboardEvent): void => {
      const direction = isMagnifiedNavShortcut(e);
      if (direction === null) return;
      const fromTile = dedicated !== null ? dedicated.tile : centered;
      if (fromTile === null) return;
      const next = findNextTileInDirection(fromTile, direction);
      if (next === null) return;
      e.preventDefault();
      e.stopPropagation();
      magnifyTile(next, dedicated !== null ? 'dedicated' : 'center');
    };
    document.addEventListener('keydown', magnifiedNavListener, true);
  }

  function unbindMagnifiedNavHandler(): void {
    if (magnifiedNavListener === null) return;
    document.removeEventListener('keydown', magnifiedNavListener, true);
    magnifiedNavListener = null;
  }

  /** HS-8028 — find the immediate-neighbour tile in the indicated grid
   *  direction. Per the user's HS-8028 follow-up: arrows must follow the
   *  natural visual layout — left lands on the tile immediately to the
   *  left in the SAME ROW (no row-jumping), and similarly for the other
   *  three directions. If no tile shares the row / column AND lies in the
   *  indicated direction, returns null (no-op).
   *
   *  Pre-fix used a perpendicular-weighted cone metric that would jump to
   *  a tile in a different row when no same-row neighbour existed, which
   *  felt unintuitive. Same-row / same-column is determined by positive
   *  bounding-rect overlap on the perpendicular axis. */
  function findNextTileInDirection(from: InternalTile, direction: GridNavDirection): InternalTile | null {
    // HS-8028 follow-up #2 — the `from` tile's grid position is what we
    // want to navigate FROM, not its centered/dedicated mount position.
    // When a tile is centered (single-click), its `tile.root` is at
    // `position: absolute` floating in the middle of the viewport (a
    // big rect spanning ~50–80 % of the screen). Comparing other tiles'
    // grid-position rects against THAT rect blows up the same-row /
    // same-column overlap test — every grid tile fails the "strict
    // half-plane" gate because the centered overlay's edges sit far
    // outside any single grid cell. Result: every Shift+Cmd+Arrow
    // chord falls through to no-op, matching the user's "doesn't seem
    // to work at all anymore" report (5/1/2026).
    //
    // Fix: when a slot placeholder exists (centered mode), use its
    // bounding rect as the `from` reference — the placeholder is a
    // ghost div the size of the original grid cell sitting in the
    // tile's natural grid position. For dedicated mode, the tile's own
    // root stays in the grid (the dedicated view is a separate
    // overlay that doesn't reparent the tile root), so its
    // getBoundingClientRect() still reflects the grid position.
    const fromRect = from.slotPlaceholder !== null
      ? from.slotPlaceholder.getBoundingClientRect()
      : from.root.getBoundingClientRect();
    const eligible: InternalTile[] = [];
    const rects: NavRect[] = [];
    for (const candidate of tiles.values()) {
      if (candidate === from) continue;
      if (candidate.state !== 'alive') continue;
      eligible.push(candidate);
      // Mirror the same trick for candidates: a candidate that itself
      // is centered (rare — only one tile can be centered at a time,
      // but defensive) should be navigated to via its grid position.
      const candRect = candidate.slotPlaceholder !== null
        ? candidate.slotPlaceholder.getBoundingClientRect()
        : candidate.root.getBoundingClientRect();
      rects.push(candRect);
    }
    const idx = pickGridNeighbourIndex(fromRect, rects, direction);
    return idx === -1 ? null : eligible[idx];
  }

  /** HS-8028 — switch the magnified view from the current tile to `next`,
   *  preserving the user's current magnification mode. `mode === 'center'`
   *  uncenters the current and centers the next; `mode === 'dedicated'`
   *  exits dedicated and re-enters dedicated for the next tile (with
   *  no priorCenteredTile so the exit returns to the bare grid, not
   *  back through a stale centered state). */
  function magnifyTile(next: InternalTile, mode: 'center' | 'dedicated'): void {
    if (mode === 'center') {
      // Uncentering the prior runs through `uncenterTile` which would
      // unbind the nav handler (no centered + no dedicated). The
      // immediately-following `centerTile(next)` re-binds, but to avoid
      // the unbind-rebind churn we just swap centered tiles directly.
      // Pre-fix the visible flicker would have been minimal but the
      // listener add/remove dance is wasteful when the user rapidly
      // navigates with Shift+Cmd+Arrow.
      if (centered !== null) {
        // Synchronously uncenter without animation — the new center will
        // animate from its grid position to the centered position right
        // after, which feels like a single composite transition.
        const prev = centered;
        const placeholder = prev.slotPlaceholder;
        centered = null;
        removeCenterBackdrop();
        if (opts.onTileShrink !== undefined) opts.onTileShrink(prev.entry);
        finishUncenterTile(prev, placeholder);
      }
      centerTile(next);
    } else {
      // Dedicated → swap. Force-clear `priorCenteredTile` so exit
      // doesn't animate through a stale centered state on the way out
      // (we're about to enter dedicated for `next` immediately).
      // Without this, exit would briefly call `centerTile(prior)` and
      // the new `enterDedicatedView` would have to tear that down.
      if (dedicated !== null) dedicated.priorCenteredTile = null;
      exitDedicatedView();
      enterDedicatedView(next, null);
    }
  }

  // --- Dedicated full-pane view (§25.8 / §36.5 / HS-7063 / HS-7098) ---

  function enterDedicatedView(tile: InternalTile, priorCenteredTile: InternalTile | null): void {
    if (dedicated !== null) exitDedicatedView();
    clearTileBell(tile);
    if (opts.onTileEnlarge !== undefined) opts.onTileEnlarge(tile.entry, 'dedicated');
    // HS-8028 — magnified-nav listener (Shift+Cmd+Arrow on macOS /
    // Shift+Ctrl+Arrow elsewhere). Idempotent — already wired if the
    // user dedicated-viewed an already-centered tile.
    bindMagnifiedNavHandler();

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
    // HS-8073 — when the dedicated view is bumped down (e.g. quit-confirm
    // preview pushes the same terminal onto the LIFO stack) and later
    // restored (cancel), the live xterm reparents back into `pane` but
    // the pane's own dimensions never changed during the round-trip, so
    // the `bodyResizeObserver` below doesn't fire and the term keeps the
    // bumping consumer's last-applied size (e.g. the quit-dialog's
    // smaller preview dims). The result the user sees is centered
    // contents inside an oversized empty frame. We need a refit on
    // restore to reconverge the term to the dedicated pane's actual
    // dims. `runFit` is hoisted as a `let` so the `onRestoredToTop`
    // closure (passed into `checkout()` synchronously below, before the
    // `runFit` const assignment) can call it.
    let runFit: () => void = () => { /* assigned below before any restore */ };
    const handle = checkout({
      projectSecret: tile.entry.secret,
      terminalId: tile.entry.id,
      cols: TILE_INITIAL_COLS,
      rows: TILE_INITIAL_ROWS,
      mountInto: pane,
      onRestoredToTop() {
        // HS-8073 — defer one frame so the pane has a current layout
        // box (the xterm element just reparented in synchronously, but
        // FitAddon reads `term.element.parentElement` dims and we want
        // the browser to have settled any same-frame layout shift the
        // reparent might have triggered). `runFit()` calls `fit.fit()`
        // which calls `term.resize(realCols, realRows)`; that fires
        // `term.onResize` below which routes through `handle.resize`
        // and updates both `lastApplied` and the server PTY size.
        requestAnimationFrame(() => { runFit(); });
      },
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

    runFit = (): void => {
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
    // HS-8028 — exit dedicated; if the user is returning to centered
    // (priorCenteredTile non-null) keep the nav handler armed since
    // `centerTile` would re-bind anyway. Otherwise unbind — the bare
    // grid has no magnified target.
    if (view.priorCenteredTile === null) unbindMagnifiedNavHandler();
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

    // HS-7097 + HS-8048: re-claim the tile PTY at tile-native dims via
    // the tile's checkout (the live xterm just reparented back into the
    // tile via `view.checkout.release()` above; resize routes through
    // the same shared WS that the dedicated view was using).
    if (view.tile.checkout !== null
        && view.tile.targetCols > 0 && view.tile.targetRows > 0) {
      view.tile.checkout.resize(view.tile.targetCols, view.tile.targetRows);
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
    // HS-8048 — dispose the tile's term-level handlers (`term.onBell`)
    // BEFORE releasing the checkout. The handlers live on the shared
    // term — leaving them attached after release would leak state into
    // a hypothetical re-checkout (the term would be disposed before
    // re-creation since we're the only consumer in the dispose path,
    // but the cleanup is symmetric and cheap).
    for (const d of tile.termHandlerDisposers) {
      try { d.dispose(); } catch { /* already disposed */ }
    }
    tile.termHandlerDisposers = [];
    if (tile.checkout !== null) {
      try { tile.checkout.release(); } catch { /* already released */ }
      tile.checkout = null;
    }
    tile.xtermRoot = null;
    tile.cachedCellW = null;
    tile.cachedCellH = null;
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
    // HS-8028 — defensive: nothing's magnified after teardown so the
    // nav handler must come off too. `exitDedicatedView` /
    // `uncenterTile` may have already unbound; the helper is
    // idempotent.
    unbindMagnifiedNavHandler();
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
