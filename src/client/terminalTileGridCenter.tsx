import { WebLinksAddon } from '@xterm/addon-web-links';

import type { SafeHtml } from '../jsx-runtime.js';
import { apiWithSecret } from './api.js';
import { toElement } from './dom.js';
import { openExternalUrl } from './tauriIntegration.js';
import {
  applyAppearanceToTerm,
} from './terminalAppearance.js';
import { checkout } from './terminalCheckout.js';
import { TILE_ASPECT } from './terminalDashboardSizing.js';
import { isTerminalViewToggleShortcut } from './terminalKeybindings.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';
import { clearBellsForVisibleTiles, clearTileBell } from './terminalTileGridBell.js';
import {
  ensureTileMounted,
  markTileMounted,
  mountTileViaCheckout,
} from './terminalTileGridLifecycle.js';
import {
  bindMagnifiedNavHandler,
  unbindMagnifiedNavHandler,
} from './terminalTileGridMagnify.js';
import {
  applySizing,
  applyTileScale,
  renderPreviewContent,
  resolveTileAppearance,
} from './terminalTileGridRender.js';
import type { InternalTile, TileGridContext } from './terminalTileGridTypes.js';
import { CENTER_ANIMATION_MS, SINGLE_CLICK_DELAY_MS, TILE_INITIAL_COLS, TILE_INITIAL_ROWS } from './terminalTileGridTypes.js';

const BACK_ARROW_ICON: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>;

/**
 * HS-8404 / HS-8411 (Cycle 3 lift + Cycle 4b split) — click /
 * dblclick dispatchers, the FLIP-animated centered overlay (§25.7 /
 * HS-6867), the slot placeholder, the dim backdrop, and the dedicated
 * full-pane view (§25.8 / §36.5 / HS-7063 / HS-7098).
 *
 * Imports from `…Magnify` (magnified-nav handler bind/unbind),
 * `…Bell` (bell-clearing on enlarge), `…Lifecycle` (mount /
 * ensure-mount / mark-mounted), `…Render` (sizing + appearance +
 * preview content). Forms function-level circular imports with each
 * of those; ES modules resolve this fine.
 */

// --- Click → center / dblclick → dedicated ---

export function onTileClick(ctx: TileGridContext, tile: InternalTile, e: MouseEvent): void {
  e.stopPropagation();
  const prior = ctx.pendingSingleClickTimer.current;
  if (prior !== null) window.clearTimeout(prior);
  ctx.pendingSingleClickTimer.current = window.setTimeout(() => {
    ctx.pendingSingleClickTimer.current = null;
    if (tile.state !== 'alive') {
      void spawnAndEnlarge(ctx, tile, 'center');
      return;
    }
    // HS-8157 — clicking the already-centered tile is a no-op; the
    // user dismisses the magnified view by clicking outside (the
    // backdrop click handler in `centerTile`). Pre-fix the inside
    // click also uncentered, which made any click inside the
    // magnified terminal (text selection, focus, etc.) collapse it.
    const centered = ctx.centered.current;
    if (centered === tile) return;
    if (centered !== null) uncenterTile(ctx);
    centerTile(ctx, tile);
  }, SINGLE_CLICK_DELAY_MS);
}

export function onTileDblClick(ctx: TileGridContext, tile: InternalTile, e: MouseEvent): void {
  e.stopPropagation();
  e.preventDefault();
  const pending = ctx.pendingSingleClickTimer.current;
  if (pending !== null) {
    window.clearTimeout(pending);
    ctx.pendingSingleClickTimer.current = null;
  }
  if (tile.state !== 'alive') {
    void spawnAndEnlarge(ctx, tile, 'dedicated');
    return;
  }
  const centered = ctx.centered.current;
  const prior = centered === tile ? null : centered;
  if (centered === tile) uncenterTile(ctx);
  try { enterDedicatedView(ctx, tile, prior); }
  catch (err) { console.error('terminalTileGrid: enterDedicatedView failed', err); }
}

async function spawnAndEnlarge(ctx: TileGridContext, tile: InternalTile, target: 'center' | 'dedicated'): Promise<void> {
  const wasExited = tile.state === 'exited';
  // HS-8059 — clear the inline theme-bg so the `Starting…` card uses its
  // own `--bg-secondary` instead of being painted with the previous mount's
  // theme bg.
  tile.preview.style.backgroundColor = '';
  tile.preview.replaceChildren(toElement(
    <div className={`${ctx.classes.placeholderClass} ${ctx.classes.placeholderStartingClass}`}>
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
    tile.root.classList.remove(`${ctx.classes.tileClass}-not_spawned`, `${ctx.classes.tileClass}-exited`);
    tile.root.classList.add(`${ctx.classes.tileClass}-alive`);
    mountTileViaCheckout(ctx, tile);
    // HS-7968 / HS-8285 follow-up — flag the tile as mounted in the
    // virtualization state (composite key).
    markTileMounted(ctx, tile);
  } catch (err) {
    console.error('terminalTileGrid: spawn failed', err);
    tile.preview.replaceChildren(renderPreviewContent(ctx, tile.state, tile.exitCode));
    return;
  }
  if (target === 'center') centerTile(ctx, tile);
  else enterDedicatedView(ctx, tile, null);
}

// --- Centered overlay (FLIP animation, §25.7 / HS-6867) ---

function getCenterReferenceRect(ctx: TileGridContext): DOMRect {
  if (ctx.opts.centerScope === 'viewport') {
    // Use the visual viewport so the centered tile tracks the window.
    return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  }
  const el = ctx.opts.centerReferenceEl ?? ctx.opts.container;
  return el.getBoundingClientRect();
}

export function centerTile(ctx: TileGridContext, tile: InternalTile): void {
  ctx.centered.current = tile;
  clearTileBell(ctx, tile);
  if (ctx.opts.onTileEnlarge !== undefined) ctx.opts.onTileEnlarge(tile.entry, 'center');
  // HS-8028 — install the magnified-nav keyboard listener (Shift+Cmd+
  // Arrow on macOS / Shift+Ctrl+Arrow elsewhere). Idempotent — the
  // helper only attaches once even on rapid re-centers.
  bindMagnifiedNavHandler(ctx);
  // HS-7968 — defend against the click-before-IO race: if an alive tile
  // hasn't been mounted yet (the IntersectionObserver callback hadn't run
  // before the click landed), force-mount now so the centered tile shows
  // the live terminal instead of an empty placeholder.
  if (tile.state === 'alive' && tile.checkout === null) {
    ensureTileMounted(ctx, tile);
  }

  const origRect = tile.root.getBoundingClientRect();
  const placeholder = createSlotPlaceholder(ctx, origRect.width, origRect.height);
  tile.slotPlaceholder = placeholder;
  tile.root.parentElement?.insertBefore(placeholder, tile.root);

  const refRect = getCenterReferenceRect(ctx);
  const availWidth = refRect.width * ctx.opts.centerSizeFrac;
  const availHeight = refRect.height * ctx.opts.centerSizeFrac;
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
  if (tile.xtermRoot !== null) applyTileScale(ctx, tile.xtermRoot, previewWidth, previewHeight);

  mountCenterBackdrop(ctx);

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

export function recenterTile(ctx: TileGridContext): void {
  const centered = ctx.centered.current;
  if (centered === null || !centered.root.classList.contains('centered')) return;
  const refRect = getCenterReferenceRect(ctx);
  const availWidth = refRect.width * ctx.opts.centerSizeFrac;
  const availHeight = refRect.height * ctx.opts.centerSizeFrac;
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
  if (tile.xtermRoot !== null) applyTileScale(ctx, tile.xtermRoot, previewWidth, previewHeight);
  void tile.root.offsetWidth;
  tile.root.style.transition = prev;
}

export function uncenterTile(ctx: TileGridContext): void {
  const centered = ctx.centered.current;
  if (centered === null) return;
  const tile = centered;
  const placeholder = tile.slotPlaceholder;
  ctx.centered.current = null;
  removeCenterBackdrop(ctx);
  // HS-8028 — uncentering returns the user to the bare grid; the
  // magnified-nav handler is no longer relevant (no magnified target
  // to navigate from). Only unbind when no dedicated view is up
  // either — `enterDedicatedView` may have called `uncenterTile`
  // internally on an open centered tile, in which case the nav
  // handler must stay armed for the dedicated path.
  if (ctx.dedicated.current === null) unbindMagnifiedNavHandler(ctx);
  if (ctx.opts.onTileShrink !== undefined) ctx.opts.onTileShrink(tile.entry);

  if (placeholder === null) { finishUncenterTile(ctx, tile, null); return; }
  const targetRect = placeholder.getBoundingClientRect();
  const currentRect = tile.root.getBoundingClientRect();
  if (currentRect.width <= 0 || currentRect.height <= 0) {
    finishUncenterTile(ctx, tile, placeholder);
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
    finishUncenterTile(ctx, tile, placeholder);
  };
  tile.root.addEventListener('transitionend', onEnd);
  window.setTimeout(() => {
    tile.root.removeEventListener('transitionend', onEnd);
    if (tile.slotPlaceholder === placeholder) finishUncenterTile(ctx, tile, placeholder);
  }, CENTER_ANIMATION_MS + 80);
}

export function finishUncenterTile(ctx: TileGridContext, tile: InternalTile, placeholder: HTMLElement | null): void {
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
    applyTileScale(ctx, tile.xtermRoot, tile.gridPreviewWidth, tile.gridPreviewHeight);
  }
  if (placeholder !== null && placeholder.parentElement !== null) {
    placeholder.parentElement.insertBefore(tile.root, placeholder);
    placeholder.remove();
  }
  tile.slotPlaceholder = null;
  // HS-8046 — uncentering returns the user to the unoccluded grid view;
  // bells that piled up behind the centered overlay are now visible and
  // should auto-clear (the user IS looking at them).
  clearBellsForVisibleTiles(ctx);
}

function createSlotPlaceholder(ctx: TileGridContext, width: number, height: number): HTMLElement {
  return toElement(
    <div className={ctx.classes.slotClass} style={`width:${width}px;height:${height}px;`}></div>
  );
}

function mountCenterBackdrop(ctx: TileGridContext): void {
  if (ctx.centerBackdrop.current !== null) return;
  const backdrop = toElement(<div className={ctx.classes.backdropClass}></div>);
  backdrop.addEventListener('click', () => { uncenterTile(ctx); });
  if (ctx.opts.centerScope === 'viewport') {
    document.body.appendChild(backdrop);
  } else {
    const target = ctx.opts.centerReferenceEl ?? ctx.opts.container;
    target.appendChild(backdrop);
  }
  ctx.centerBackdrop.current = backdrop;
}

export function removeCenterBackdrop(ctx: TileGridContext): void {
  const backdrop = ctx.centerBackdrop.current;
  if (backdrop === null) return;
  backdrop.remove();
  ctx.centerBackdrop.current = null;
}

// --- Dedicated full-pane view (§25.8 / §36.5 / HS-7063 / HS-7098) ---

export function enterDedicatedView(ctx: TileGridContext, tile: InternalTile, priorCenteredTile: InternalTile | null): void {
  if (ctx.dedicated.current !== null) exitDedicatedView(ctx);
  clearTileBell(ctx, tile);
  if (ctx.opts.onTileEnlarge !== undefined) ctx.opts.onTileEnlarge(tile.entry, 'dedicated');
  // HS-8028 — magnified-nav listener (Shift+Cmd+Arrow on macOS /
  // Shift+Ctrl+Arrow elsewhere). Idempotent — already wired if the
  // user dedicated-viewed an already-centered tile.
  bindMagnifiedNavHandler(ctx);

  const c = ctx.classes;
  const overlay = toElement(
    <div className={c.dedicatedClass} data-secret={tile.entry.secret} data-terminal-id={tile.entry.id}>
      <div className={c.dedicatedBarClass}>
        <button className={c.dedicatedBackClass} title="Back to grid">
          {BACK_ARROW_ICON}
          <span>Back</span>
        </button>
        <div className={c.dedicatedLabelClass}>{tile.entry.label}</div>
      </div>
      <div className={c.dedicatedBodyClass}>
        <div className={c.dedicatedPaneClass}></div>
      </div>
    </div>
  );
  // Append the overlay relative to the appropriate scope so the dedicated
  // view occupies the same area the grid does. Dashboard uses
  // 'viewport' -> append to the dashboard root (which has fixed position
  // anyway); drawer uses 'container' -> append into the grid container.
  const dedicatedHost = ctx.opts.centerScope === 'viewport'
    ? (ctx.opts.centerReferenceEl ?? ctx.opts.container)
    : ctx.opts.container;
  dedicatedHost.appendChild(overlay);

  const pane = overlay.querySelector<HTMLElement>(`.${c.dedicatedPaneClass}`);
  const backBtn = overlay.querySelector<HTMLElement>(`.${c.dedicatedBackClass}`);
  const bar = overlay.querySelector<HTMLElement>(`.${c.dedicatedBarClass}`);
  const dedicatedBody = overlay.querySelector<HTMLElement>(`.${c.dedicatedBodyClass}`);
  if (pane === null || backBtn === null || bar === null) return;
  // HS-8012 — the prompt overlay used to capture `dedicatedBody ?? pane`
  // here so it could mount inside the dedicated view. It now mounts on
  // `document.body` and anchors below the project tab, so the closure
  // no longer needs an in-pane anchor. `dedicatedBody` is still used
  // below to apply the per-theme background color.
  backBtn.addEventListener('click', () => { exitDedicatedView(ctx); });

  const appearance = resolveTileAppearance(ctx, tile);
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
    // HS-8295 — paint the §54 bumped-down placeholder with this terminal's
    // theme bg so a quit-confirm preview / popup borrowing the live xterm
    // doesn't flash the dedicated pane to `--bg-secondary`.
    placeholderBackground: themeData.background,
    onRestoredToTop() {
      // HS-8073 — defer one frame so the pane has a current layout
      // box (the xterm element just reparented in synchronously, but
      // FitAddon reads `term.element.parentElement` dims and we want
      // the browser to have settled any same-frame layout shift the
      // reparent might have triggered).
      requestAnimationFrame(() => { runFit(); });
    },
  });
  const term = handle.term;
  const fit = handle.fit;

  // Apply appearance + per-consumer term tweaks. The xterm is shared
  // across consumers via the checkout module, so settings written here
  // persist on the term — when this dedicated view releases and the
  // tile's checkout (if any) regains top-of-stack, the tile sees the
  // theme/font we set.
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
    try { fit.fit(); } catch { /* not ready */ }
  };
  requestAnimationFrame(runFit);
  const bodyResizeObserver = new ResizeObserver(runFit);
  bodyResizeObserver.observe(pane);

  // `term.onResize` fires when `fit.fit()` resolves the pane's measured
  // dims — route the new size through `handle.resize` so the checkout
  // module sends the WS resize frame AND updates the entry's
  // `lastAppliedCols/Rows` bookkeeping.
  term.onResize(({ cols, rows }) => {
    handle.resize(cols, rows);
  });

  let barDispose: (() => void) | null = null;
  if (ctx.opts.onDedicatedBarMount !== undefined) {
    const result = ctx.opts.onDedicatedBarMount(bar, tile.entry, term);
    if (typeof result === 'function') barDispose = result;
  }

  ctx.dedicated.current = { tile, overlay, checkout: handle, term, fit, bodyResizeObserver, priorCenteredTile, barDispose };
  queueMicrotask(() => { term.focus(); });
}

export function exitDedicatedView(ctx: TileGridContext): void {
  const dedicated = ctx.dedicated.current;
  if (dedicated === null) return;
  const view = dedicated;
  ctx.dedicated.current = null;
  // HS-8028 — exit dedicated; if the user is returning to centered
  // (priorCenteredTile non-null) keep the nav handler armed since
  // `centerTile` would re-bind anyway. Otherwise unbind — the bare
  // grid has no magnified target.
  if (view.priorCenteredTile === null) unbindMagnifiedNavHandler(ctx);
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
  if (ctx.opts.onTileShrink !== undefined) ctx.opts.onTileShrink(view.tile.entry);

  // HS-7097 + HS-8048: re-claim the tile PTY at tile-native dims via
  // the tile's checkout (the live xterm just reparented back into the
  // tile via `view.checkout.release()` above; resize routes through
  // the same shared WS that the dedicated view was using).
  if (view.tile.checkout !== null
      && view.tile.targetCols > 0 && view.tile.targetRows > 0) {
    view.tile.checkout.resize(view.tile.targetCols, view.tile.targetRows);
  }

  applySizing(ctx);
  if (view.priorCenteredTile !== null) {
    centerTile(ctx, view.priorCenteredTile);
  } else {
    // HS-8046 — exiting dedicated view (with no centered fallback)
    // returns the user to the unoccluded grid; sweep visible tiles for
    // bells that piled up while the dedicated view was up.
    clearBellsForVisibleTiles(ctx);
  }
}
