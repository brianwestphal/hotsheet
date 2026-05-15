import { toElement } from './dom.js';
import { openExternalUrl } from './tauriIntegration.js';
import { applyAppearanceToTerm } from './terminalAppearance.js';
import { checkout } from './terminalCheckout.js';
import { tileNativeGridFromCellMetrics } from './terminalDashboardSizing.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';
import { isGridSurfaceUnoccluded, maybeAutoClearTileBell, postClearBell } from './terminalTileGridBell.js';
import { exitDedicatedView, removeCenterBackdrop } from './terminalTileGridCenter.js';
import { tileKeyFor } from './terminalTileGridKeys.js';
import { unbindMagnifiedNavHandler } from './terminalTileGridMagnify.js';
import {
  reapplyTileScaleFromPreview,
  renderPreviewContent,
  resolveTileAppearance,
} from './terminalTileGridRender.js';
import type { InternalTile, TileGridContext } from './terminalTileGridTypes.js';
import { TILE_INITIAL_COLS, TILE_INITIAL_ROWS } from './terminalTileGridTypes.js';
import {
  initialTileState,
  onDisposeTimerFired,
  onTileEnter,
  onTileExit,
  VIRT_DEFAULT_DEBOUNCE_MS,
} from './terminalTileVirtualization.js';

/**
 * HS-8412 / HS-8411 (Cycle 4a lift + Cycle 4b split) — per-tile
 * lifecycle, virtualization, and the final ambient teardown. Covers:
 *
 *   - `mountTileViaCheckout` — wire the tile to the
 *     `terminalCheckout` LIFO stack (HS-8048).
 *   - `softDisposeTile` / `ensureTileMounted` — virtualization
 *     mount / soft-release path (HS-7968).
 *   - `disposeTile` — full per-tile teardown for `bindList` row
 *     disposers.
 *   - `handleTileRender` — `term.onRender` driver for the cell-metric
 *     convergence path (HS-8051 follow-up #2).
 *   - `attachScreenObserver` — ResizeObserver safety net for the
 *     visual scale.
 *   - `markTileMounted` — small bookkeeping helper used by every
 *     mount path.
 *   - `handleIntersectionEntries` / `forgetVirtualization` —
 *     IntersectionObserver wiring.
 *   - `teardownAmbientState` — top-level cleanup (centered /
 *     dedicated / magnify nav / backdrop / single-click timer /
 *     virt registries).
 *
 * Imports from `…Bell` (auto-clear check), `…Center` (exit-dedicated
 * + remove-backdrop on teardown), `…Magnify` (unbind nav handler on
 * teardown), `…Render` (preview content + appearance + scale). The
 * Center / Magnify / Render imports form function-level circulars
 * with this module — ES modules resolve those fine.
 */

// --- HS-7968 virtualization wiring ---

export function handleIntersectionEntries(ctx: TileGridContext, entries: IntersectionObserverEntry[]): void {
  const now = performance.now();
  for (const entry of entries) {
    const tileId = ctx.virtRootToId.get(entry.target);
    if (tileId === undefined) continue;
    const tile = ctx.tiles.get(tileId);
    if (tile === undefined) continue;
    const current = ctx.virtState.get(tileId) ?? initialTileState();
    if (entry.isIntersecting) {
      // HS-8046 — track viewport membership so the auto-clear-bell
      // logic knows which tiles the user is actually looking at, and
      // immediately clear any bell that was already on this tile when
      // it scrolled in.
      ctx.visibleTileIds.add(tileId);
      maybeAutoClearTileBell(ctx, tile);
      // Only mount-if-not-mounted when the tile is alive — exited /
      // not_spawned tiles don't have PTYs to attach to. The placeholder
      // visual already conveys their state.
      const mountIfNotMounted = tile.state === 'alive';
      const step = onTileEnter(current, { tileId, mountIfNotMounted });
      ctx.virtState.set(tileId, step.next);
      for (const action of step.actions) {
        if (action.type === 'cancelDispose') {
          const t = ctx.virtTimers.get(tileId);
          if (t !== undefined) { clearTimeout(t); ctx.virtTimers.delete(tileId); }
        } else if (action.type === 'mount') {
          mountTileViaCheckout(ctx, tile);
        }
      }
    } else {
      // HS-8046 — tile scrolled out of viewport; user can no longer see
      // it, so subsequent bells must surface as the indicator.
      ctx.visibleTileIds.delete(tileId);
      const step = onTileExit(current, { tileId, now, debounceMs: VIRT_DEFAULT_DEBOUNCE_MS });
      ctx.virtState.set(tileId, step.next);
      for (const action of step.actions) {
        if (action.type === 'scheduleDispose') {
          const timer = setTimeout(() => {
            ctx.virtTimers.delete(tileId);
            const after = ctx.virtState.get(tileId) ?? initialTileState();
            const fired = onDisposeTimerFired(after, { tileId });
            ctx.virtState.set(tileId, fired.next);
            for (const innerAction of fired.actions) {
              if (innerAction.type === 'dispose') {
                softDisposeTile(ctx, tile);
              }
            }
          }, action.afterMs);
          ctx.virtTimers.set(tileId, timer);
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
export function softDisposeTile(ctx: TileGridContext, tile: InternalTile): void {
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
  tile.preview.replaceChildren(renderPreviewContent(ctx, tile.state, tile.exitCode));
}

/** HS-7968 + HS-8048 — force-mount a tile and update the virtualization
 *  state. Used by the click-before-IO defensive path in `centerTile` /
 *  `enterDedicatedView`-via-tile-click so the user doesn't briefly see
 *  a placeholder when the IntersectionObserver hadn't fired yet. */
export function ensureTileMounted(ctx: TileGridContext, tile: InternalTile): void {
  if (tile.checkout !== null) return;
  mountTileViaCheckout(ctx, tile);
  markTileMounted(ctx, tile);
  // If a dispose timer was pending (rare race), cancel it.
  const key = tileKeyFor(tile.entry);
  const t = ctx.virtTimers.get(key);
  if (t !== undefined) { clearTimeout(t); ctx.virtTimers.delete(key); }
}

/** HS-7968 — fully forget the tile from the virtualization registry.
 *  Called from `disposeTile` on full teardown. */
export function forgetVirtualization(ctx: TileGridContext, tile: InternalTile): void {
  if (ctx.virtObserver.current !== null) ctx.virtObserver.current.unobserve(tile.root);
  ctx.virtRootToId.delete(tile.root);
  const key = tileKeyFor(tile.entry);
  const timer = ctx.virtTimers.get(key);
  if (timer !== undefined) { clearTimeout(timer); ctx.virtTimers.delete(key); }
  ctx.virtState.delete(key);
  // HS-8046 — drop the viewport-membership flag too so a re-rendered
  // tile with the same id starts from a clean slate.
  ctx.visibleTileIds.delete(key);
}

/** Mark a tile as mounted in the virtualization registry. Pre-Cycle-4
 *  this was inlined at every callsite; lifted out so the bridge from
 *  `spawnAndEnlarge` / `ensureTileMounted` / the eager-mount fallback
 *  in `renderTile` is a one-liner. */
export function markTileMounted(ctx: TileGridContext, tile: InternalTile): void {
  const key = tileKeyFor(tile.entry);
  const v = ctx.virtState.get(key);
  if (v !== undefined) ctx.virtState.set(key, { ...v, mounted: true });
}

// --- xterm mount + WebSocket attach ---

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
export function mountTileViaCheckout(ctx: TileGridContext, tile: InternalTile): void {
  const xtermRoot = toElement(<div className={ctx.classes.xtermClass}></div>);
  tile.preview.replaceChildren(xtermRoot);

  const appearance = resolveTileAppearance(ctx, tile);
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
    // HS-8295 — paint the §54 bumped-down placeholder with this tile's
    // theme bg so a dedicated view / preview borrowing the live xterm
    // doesn't flash the tile to `--bg-secondary`.
    placeholderBackground: themeData.background,
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
      reapplyTileScaleFromPreview(ctx, tile);
      attachScreenObserver(ctx, tile);
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

  // HS-8288 — defense in depth against the cascading-refresh /
  // race-during-mount class of bug. If `checkout()` returned but
  // `reparentXtermInto` hit its `term.element === undefined` early-return
  // (recorded as the `reparent.no-element` event in the HS-8287/8288
  // diagnostic instrumentation), the xtermRoot is empty: no live xterm,
  // no placeholder, no path to recovery. The user sees a blank tile and
  // there's no entry-side state we'd ever clean up. Detect the broken
  // mount immediately and recover: release the checkout (which collapses
  // the entry if we're the only consumer, freeing it for a fresh
  // re-mount), restore the alive placeholder so the tile shows a
  // coherent visual, and bail. The next `term.onRender` won't fire
  // (we never wire it below), but the IntersectionObserver's next cycle
  // / a manual click on the tile will go through `ensureTileMounted` →
  // `mountTileViaCheckout` again with a fresh attempt.
  if (xtermRoot.children.length === 0) {
    try { handle.release(); } catch { /* swallow — already torn down */ }
    tile.checkout = null;
    tile.xtermRoot = null;
    tile.preview.style.backgroundColor = '';
    tile.preview.replaceChildren(renderPreviewContent(ctx, tile.state, tile.exitCode));
    return;
  }

  // HS-7097 → HS-8051 follow-up #2 — observe `.xterm-screen` so a
  // change in natural xterm dims (font / theme swap; consumer
  // hand-off) re-applies the CSS scale. Convergence on tile-native
  // cols × rows is driven by `term.onRender` (wired below) — the
  // observer is just a safety net for the visual scale.
  attachScreenObserver(ctx, tile);

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
    if (isGridSurfaceUnoccluded(ctx) && ctx.visibleTileIds.has(tileKeyFor(tile.entry))) {
      postClearBell(ctx, tile);
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
    handleTileRender(ctx, tile);
  });
  tile.termHandlerDisposers.push(renderDispose);

  // HS-8286 — per-tile stall chip wiring deleted. Stall detection now
  // feeds the global server-slow banner via the per-entry watcher in
  // `terminalCheckout.tsx::createEntry` so a slow server surfaces ONCE
  // (banner) instead of N times (one chip per visible tile).
}

/** HS-8051 follow-up #2 — runs on every `term.onRender` for a tile.
 *  Caches cell metrics on the first render where they're measurable,
 *  re-applies CSS scale, and (when top-of-stack) issues at most one
 *  resize per render to converge on the cell-metric-derived 4:3
 *  native cols × rows. */
export function handleTileRender(ctx: TileGridContext, tile: InternalTile): void {
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
  reapplyTileScaleFromPreview(ctx, tile);

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
    // `release()` → `restore()` round-trip's safe-stop also recognizes
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
export function attachScreenObserver(ctx: TileGridContext, tile: InternalTile, retriesRemaining: number = 30): void {
  if (tile.xtermRoot === null) return;
  if (tile.checkout === null) return;
  tile.screenObserver?.disconnect();
  const screen = tile.xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  if (screen === null) {
    if (retriesRemaining > 0) {
      requestAnimationFrame(() => { attachScreenObserver(ctx, tile, retriesRemaining - 1); });
    }
    return;
  }
  const observer = new ResizeObserver(() => {
    reapplyTileScaleFromPreview(ctx, tile);
  });
  observer.observe(screen);
  tile.screenObserver = observer;
}

// --- Tile teardown ---

export function disposeTile(ctx: TileGridContext, tile: InternalTile): void {
  forgetVirtualization(ctx, tile);
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

/** HS-8313 — terminal cleanup that isn't tile-scoped. Tile teardown
 *  happens through bindListDispose (which fires every per-row
 *  dispose). Centered / dedicated state, the magnified-nav handler,
 *  the single-click timer + virtualization registries / observer all
 *  live above the per-tile layer and need explicit cleanup here. */
export function teardownAmbientState(ctx: TileGridContext): void {
  if (ctx.dedicated.current !== null) exitDedicatedView(ctx);
  const centered = ctx.centered.current;
  if (centered !== null) {
    if (centered.slotPlaceholder !== null) centered.slotPlaceholder.remove();
    centered.root.classList.remove('centered');
    centered.root.style.transition = '';
    centered.root.style.transform = '';
    ctx.centered.current = null;
  }
  // HS-8028 — defensive: nothing's magnified after teardown so the
  // nav handler must come off too. `exitDedicatedView` /
  // `uncenterTile` may have already unbound; the helper is
  // idempotent.
  unbindMagnifiedNavHandler(ctx);
  removeCenterBackdrop(ctx);
  if (ctx.pendingSingleClickTimer.current !== null) {
    window.clearTimeout(ctx.pendingSingleClickTimer.current);
    ctx.pendingSingleClickTimer.current = null;
  }
  // HS-7968 — drop every pending dispose timer + disconnect the observer.
  // Per-tile virt state (virtState entries, virtRootToId entries,
  // visibleTileIds entries) was already cleared by each tile's
  // forgetVirtualization() inside disposeTile via the bindList row
  // disposers; the observer instance + any orphaned timers (none
  // expected, but defensive) need an explicit disconnect.
  for (const t of ctx.virtTimers.values()) clearTimeout(t);
  ctx.virtTimers.clear();
  ctx.virtState.clear();
  ctx.virtRootToId.clear();
  ctx.visibleTileIds.clear();
  if (ctx.virtObserver.current !== null) ctx.virtObserver.current.disconnect();
}
