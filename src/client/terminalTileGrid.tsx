import type { Terminal as XTerm } from '@xterm/xterm';

import type { Signal } from './reactive.js';
import { effect, signal } from './reactive.js';
import { bindList } from './reactive-bind.js';
import { isGridSurfaceUnoccluded, postClearBell } from './terminalTileGridBell.js';
import {
  exitDedicatedView,
  recenterTile,
  uncenterTile,
} from './terminalTileGridCenter.js';
import { tileKeyFor } from './terminalTileGridKeys.js';
import {
  disposeTile,
  handleIntersectionEntries,
  teardownAmbientState,
} from './terminalTileGridLifecycle.js';
import { applySizing, renderTile, updateTileFromEntry } from './terminalTileGridRender.js';
import type { TileGridContext } from './terminalTileGridTypes.js';

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
 * - `getColumnCount` — caller owns the size-slider state and returns the
 *   currently-selected column count (integer 1..10 per HS-8176). The grid
 *   asks for the current value during every sizing pass.
 * - `onContextMenu` — optional right-click handler. The dashboard wires a
 *   per-tile context menu (§25.8.5); the drawer-grid currently doesn't.
 *
 * The returned `TileGridHandle` exposes the operations the callsite needs to
 * react to outside events (rebuild on a list refresh, applySizing on slider
 * change / window resize, exitCentered / exitDedicated on Esc).
 *
 * HS-8397 / HS-8411 — internal implementation lives in per-concern sibling
 * modules: `terminalTileGridTypes` (interfaces + constants),
 * `terminalTileGridKeys` (pure key helpers), `terminalTileGridBell` (Cycle
 * 1 bell-clearing), `terminalTileGridMagnify` (Cycle 2 magnified-nav),
 * `terminalTileGridCenter` (Cycle 3 click + center + dedicated),
 * `terminalTileGridLifecycle` (Cycle 4 per-tile mount + virt + ambient
 * teardown), `terminalTileGridRender` (Cycle 4 DOM + sizing + in-place
 * updates). This file owns only the public surface — types, the
 * `mountTileGrid` factory, and the `TileGridHandle` whose methods are
 * thin ctx-passing wrappers.
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
  getColumnCount: () => number;
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
  /** Re-run the per-tile sizing pass — reads `getColumnCount()` against the
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
  /** Sync per-tile bell indicators against a set of bellPending tile keys
   *  (composite `${secret}::${id}`, drawn from the cross-project bell-state
   *  long-poll subscription). Tiles whose composite key is in
   *  `pendingTileKeys` get `.has-bell`; others have it removed.
   *
   *  HS-8285 follow-up — the parameter used to be a plain `Set<terminalId>`,
   *  which broke flow mode when two projects shared a terminal id (a bell
   *  on project A's `default` lit up project B's `default` tile too).
   *  The composite key disambiguates. */
  syncBellState(pendingTileKeys: Set<string>): void;
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

export function mountTileGrid(opts: TileGridOptions): TileGridHandle {
  const cssPrefix = opts.cssPrefix;
  const entriesSignal: Signal<readonly TileEntry[]> = signal([]);

  const ctx: TileGridContext = {
    opts,
    cssPrefix,
    tiles: new Map(),
    visibleTileIds: new Set(),
    centered: { current: null },
    dedicated: { current: null },
    centerBackdrop: { current: null },
    pendingSingleClickTimer: { current: null },
    magnifiedNavListener: { current: null },
    virtState: new Map(),
    virtTimers: new Map(),
    virtRootToId: new Map(),
    virtObserver: { current: null },
    entriesSignal,
    classes: {
      tileClass: `${cssPrefix}-tile`,
      previewClass: `${cssPrefix}-tile-preview`,
      labelClass: `${cssPrefix}-tile-label`,
      xtermClass: `${cssPrefix}-tile-xterm`,
      placeholderClass: `${cssPrefix}-tile-placeholder`,
      placeholderColdClass: `${cssPrefix}-tile-placeholder-cold`,
      placeholderStartingClass: `${cssPrefix}-tile-placeholder-starting`,
      placeholderStatusClass: `${cssPrefix}-tile-placeholder-status`,
      slotClass: `${cssPrefix}-tile-slot`,
      backdropClass: `${cssPrefix}-center-backdrop`,
      dedicatedClass: `${cssPrefix}-dedicated`,
      dedicatedBarClass: `${cssPrefix}-dedicated-bar`,
      dedicatedBackClass: `${cssPrefix}-dedicated-back`,
      dedicatedLabelClass: `${cssPrefix}-dedicated-label`,
      dedicatedBodyClass: `${cssPrefix}-dedicated-body`,
      dedicatedPaneClass: `${cssPrefix}-dedicated-pane`,
      cwdClass: `${cssPrefix}-tile-cwd`,
    },
  };

  // HS-7968 — wire the IntersectionObserver AFTER ctx construction so
  // the callback can capture `ctx` for the lifted
  // `handleIntersectionEntries(ctx, entries)` call. The boxed
  // `ctx.virtObserver.current` stays null in test envs that lack
  // `IntersectionObserver` (the eager-mount fallback in `renderTile`
  // picks up the slack).
  ctx.virtObserver.current = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(
        (entries) => { handleIntersectionEntries(ctx, entries); },
        { root: null, rootMargin: '200px', threshold: 0 },
      )
    : null;

  // HS-8313 — bindList-driven rebuild. The key is the registry
  // `${secret}::${id}` so a surviving terminal keeps its DOM + checkout
  // + virtualization state across rebuilds. The captured `tile`
  // reference (closed over at render time) is the dispose target so a
  // hypothetical successor under the same registry key wouldn't be
  // trashed (defensive — same-registry-key successors don't currently
  // arise because state changes update in place rather than remount).
  const bindListDispose = bindList(opts.container, entriesSignal, tileKeyFor, (entry) => {
    const root = renderTile(ctx, entry);
    const tile = ctx.tiles.get(tileKeyFor(entry))!;
    return {
      el: root,
      dispose: () => {
        disposeTile(ctx, tile);
        const k = tileKeyFor(tile.entry);
        if (ctx.tiles.get(k) === tile) ctx.tiles.delete(k);
      },
    };
  });

  // HS-8313 — in-place property updates for surviving tiles. Fires on
  // every signal write; walks the current list, looks up tiles whose
  // entry reference changed, and applies diffs (state transition,
  // label / cwd / appearance updates) WITHOUT destroying the tile.
  // New tiles (just rendered) have `tile.entry === entry`, so the
  // guard skips them. Dropped tiles are absent from `ctx.tiles`, so
  // the guard skips them too.
  const propUpdateDispose = effect(() => {
    const entries = entriesSignal.value;
    for (const entry of entries) {
      const t = ctx.tiles.get(tileKeyFor(entry));
      if (t !== undefined && t.entry !== entry) {
        updateTileFromEntry(ctx, t, entry);
      }
    }
  });

  return {
    rebuild(entries) {
      // HS-8313 — pre-fix this teardown'd every tile + reconstructed
      // them in order. Now: write the signal, let bindList reconcile
      // add / remove / reorder, let propUpdateEffect apply in-place
      // diffs to surviving tiles. applySizing() runs synchronously
      // after the signal write because both effects fire synchronously
      // on signal write per kerf's effect contract.
      entriesSignal.value = [...entries];
      applySizing(ctx);
    },
    applySizing: () => { applySizing(ctx); },
    recenterTile: () => { recenterTile(ctx); },
    uncenterTile: () => { uncenterTile(ctx); },
    exitDedicatedView: () => { exitDedicatedView(ctx); },
    syncBellState(pendingTileKeys) {
      // HS-8469 — bell state is signal-backed (`tile.bellPending`). The
      // effect created in `renderTile` mirrors the signal value onto the
      // `has-bell` class, so this method just writes the signal. Reads
      // use `.peek()` because we're outside any kerf-effect context and
      // don't want to register a subscription.
      for (const tile of ctx.tiles.values()) {
        const key = tileKeyFor(tile.entry);
        const want = pendingTileKeys.has(key);
        const has = tile.bellPending.peek();
        if (want && !has) {
          // HS-8046 — server-pushed bellPending lands on a tile the user
          // is already looking at. Drop the server flag instead of
          // rendering the indicator.
          if (isGridSurfaceUnoccluded(ctx) && ctx.visibleTileIds.has(key)) {
            postClearBell(ctx, tile);
          } else {
            tile.bellPending.value = true;
          }
        } else if (!want && has) {
          tile.bellPending.value = false;
        }
      }
    },
    focusDedicatedTerm() {
      const view = ctx.dedicated.current;
      if (view === null) return;
      try { view.term.focus(); } catch { /* term disposed */ }
    },
    isCentered() { return ctx.centered.current !== null; },
    isDedicatedOpen() { return ctx.dedicated.current !== null; },
    dispose() {
      // HS-8313 — bindListDispose disposes every live row's per-row
      // dispose (which runs disposeTile + tiles.delete), then
      // teardownAmbientState handles centered / dedicated / virt
      // observer / magnified-nav cleanup that lives above the tile
      // layer.
      bindListDispose();
      propUpdateDispose();
      teardownAmbientState(ctx);
    },
  };
}
