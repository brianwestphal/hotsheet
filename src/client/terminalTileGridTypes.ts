import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal as XTerm } from '@xterm/xterm';

import type { Signal } from './reactive.js';
import type { CheckoutHandle } from './terminalCheckout.js';
import {
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
} from './terminalDashboardSizing.js';
import type { TileEntry, TileGridOptions, TileSessionState } from './terminalTileGrid.js';
import type { TileVirtualState } from './terminalTileVirtualization.js';

/**
 * HS-8397 / HS-8411 — internal types shared across the
 * `terminalTileGrid*` cluster (Cycle 4b split). Each behaviour
 * sub-module (`terminalTileGridBell` / `…Magnify` / `…Center` /
 * `…Lifecycle` / `…Render`) imports the type names from here so the
 * sibling modules can declare argument types without pulling in code
 * from one another at type-level only. Pre-split these lived inside
 * `terminalTileGrid.tsx` alongside the now-extracted closure bodies.
 */

export interface InternalTile {
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

export interface DedicatedView {
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

export const TILE_INITIAL_COLS = DASHBOARD_FALLBACK_COLS;
export const TILE_INITIAL_ROWS = DASHBOARD_FALLBACK_ROWS;
export const CENTER_ANIMATION_MS = 280;
/** 220 ms gives the browser enough time to dispatch dblclick first when the
 *  user double-clicks; tested across macOS / Linux / Windows. Below ~200 ms
 *  the single-click action sometimes fires before dblclick on slower
 *  hardware. */
export const SINGLE_CLICK_DELAY_MS = 220;

/**
 * HS-8397 lift-to-module-with-ctx refactor — per-factory state container
 * for the lifted module-level functions. Each `mountTileGrid` call builds
 * one of these; every lifted function takes `ctx: TileGridContext` as
 * its first arg.
 *
 * Cycle history:
 *   - HS-8402 (Cycle 1): bell-clearing functions lifted.
 *   - HS-8403 (Cycle 2): magnified-nav lifted; ctx grew the
 *     `magnifiedNavListener` boxed slot.
 *   - HS-8404 (Cycle 3): center / dedicated subsystem lifted; ctx grew
 *     the `classes` block.
 *   - HS-8412 (Cycle 4a): per-tile lifecycle / sizing / virtualization /
 *     rendering all lifted; the four mutable single-slot refs became
 *     boxed `{ current }` slots; `centerCallbacks` removed.
 *   - HS-8411 (Cycle 4b, this commit): the lifted cluster splits into
 *     per-concern sub-modules. The `TileGridContext` interface relocates
 *     to this dedicated types module so every sub-module imports it
 *     symmetrically rather than having one file own it.
 */
export interface TileGridContext {
  opts: TileGridOptions;
  cssPrefix: string;
  tiles: Map<string, InternalTile>;
  /** HS-8046 — set of tileIds whose root is currently inside the
   *  IntersectionObserver's viewport. Updated by `handleIntersectionEntries`
   *  on every enter / exit transition. Used to gate the auto-clear path. */
  visibleTileIds: Set<string>;

  /** Mutable single-slot refs — boxed for cross-module reads + writes.
   *  Pre-Cycle-4 these were `let` bindings inside the factory closure
   *  with get/set bridge fns; post-Cycle-4 they're direct `.current`
   *  reads + writes. */
  centered: { current: InternalTile | null };
  dedicated: { current: DedicatedView | null };
  centerBackdrop: { current: HTMLElement | null };
  pendingSingleClickTimer: { current: number | null };

  /** HS-8028 — boxed slot for the magnified-nav keyboard listener. The
   *  lifted bind / unbind functions read + write `.current`. */
  magnifiedNavListener: { current: ((e: KeyboardEvent) => void) | null };

  /** HS-7968 virtualization registries. The composite `${secret}::${id}`
   *  keying matches the `tiles` Map. */
  virtState: Map<string, TileVirtualState>;
  virtTimers: Map<string, ReturnType<typeof setTimeout>>;
  virtRootToId: Map<Element, string>;
  /** Boxed because the `IntersectionObserver` is wired AFTER ctx
   *  construction so its callback can capture `ctx` for the
   *  `handleIntersectionEntries(ctx, entries)` call. */
  virtObserver: { current: IntersectionObserver | null };

  /** HS-8313 — source-of-truth for the tile list. `rebuild()` writes a
   *  fresh array here; `bindList` reconciles add / remove / reorder
   *  against the previous value; the prop-update effect walks surviving
   *  tiles to apply in-place updates. */
  entriesSignal: Signal<readonly TileEntry[]>;

  /** Derived CSS class strings the lifted functions use for new DOM
   *  element construction. Pre-Cycle-4 the closures closed over the
   *  factory's class-name locals; post-Cycle-4 they're passed via ctx
   *  so the rendering / sizing / center / dedicated paths share a
   *  single source of truth. */
  classes: {
    tileClass: string;
    previewClass: string;
    labelClass: string;
    xtermClass: string;
    placeholderClass: string;
    placeholderColdClass: string;
    placeholderStartingClass: string;
    placeholderStatusClass: string;
    slotClass: string;
    backdropClass: string;
    dedicatedClass: string;
    dedicatedBarClass: string;
    dedicatedBackClass: string;
    dedicatedLabelClass: string;
    dedicatedBodyClass: string;
    dedicatedPaneClass: string;
    cwdClass: string;
  };
}
