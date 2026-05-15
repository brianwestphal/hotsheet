import { type NavRect, pickGridNeighbourIndex } from './gridNavGeometry.js';
import { type GridNavDirection, isMagnifiedNavShortcut } from './terminalKeybindings.js';
import {
  centerTile,
  enterDedicatedView,
  exitDedicatedView,
  finishUncenterTile,
  removeCenterBackdrop,
} from './terminalTileGridCenter.js';
import type { InternalTile, TileGridContext } from './terminalTileGridTypes.js';

/**
 * HS-8403 / HS-8411 (Cycle 2 lift + Cycle 4b split) — magnified-tile
 * keyboard nav. Shift+Cmd+Arrow (macOS) / Shift+Ctrl+Arrow (Linux /
 * Windows) navigates between tiles while one is centered or in
 * dedicated view (HS-8028 family).
 *
 * Imports `centerTile` / `enterDedicatedView` / `exitDedicatedView` /
 * `removeCenterBackdrop` / `finishUncenterTile` from `…Center` —
 * forms a function-level circular import (Center calls
 * `bindMagnifiedNavHandler` / `unbindMagnifiedNavHandler` back from
 * here). ES modules resolve this fine since both modules only export
 * functions; nothing reads from the imports at module-init time.
 */

export function bindMagnifiedNavHandler(ctx: TileGridContext): void {
  if (ctx.magnifiedNavListener.current !== null) return;
  const listener = (e: KeyboardEvent): void => {
    const direction = isMagnifiedNavShortcut(e);
    if (direction === null) return;
    // HS-8366 — bail when a regular text input owns focus so the
    // Cmd+Shift+Arrow chord falls through to the browser for text-
    // selection extension. The xterm helper-textarea is detected via
    // the `.xterm` ancestor and is excluded from the carve-out (xterm
    // doesn't use Cmd+Shift+Arrow for text selection).
    const target = e.target;
    if (target instanceof HTMLElement) {
      const tag = target.tagName;
      const isRegularInput = (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable);
      const isInXterm = target.closest('.xterm') !== null;
      if (isRegularInput && !isInXterm) return;
    }
    const dedicated = ctx.dedicated.current;
    const centered = ctx.centered.current;
    const fromTile = dedicated !== null ? dedicated.tile : centered;
    if (fromTile === null) return;
    const next = findNextTileInDirection(ctx, fromTile, direction);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    magnifyTile(ctx, next, dedicated !== null ? 'dedicated' : 'center');
  };
  ctx.magnifiedNavListener.current = listener;
  document.addEventListener('keydown', listener, true);
}

export function unbindMagnifiedNavHandler(ctx: TileGridContext): void {
  const listener = ctx.magnifiedNavListener.current;
  if (listener === null) return;
  document.removeEventListener('keydown', listener, true);
  ctx.magnifiedNavListener.current = null;
}

/** HS-8028 — find the immediate-neighbour tile in the indicated grid
 *  direction. Per the user's HS-8028 follow-up: arrows must follow the
 *  natural visual layout — left lands on the tile immediately to the
 *  left in the SAME ROW (no row-jumping), and similarly for the other
 *  three directions. */
function findNextTileInDirection(ctx: TileGridContext, from: InternalTile, direction: GridNavDirection): InternalTile | null {
  // HS-8028 follow-up #2 — when a tile is centered, its `tile.root`
  // lives at `position: absolute` in the middle of the viewport. Use
  // the slot placeholder's grid-position rect when one exists so the
  // same-row / same-column overlap test runs against the original
  // grid cell rather than the floating overlay.
  const fromRect = from.slotPlaceholder !== null
    ? from.slotPlaceholder.getBoundingClientRect()
    : from.root.getBoundingClientRect();
  const eligible: InternalTile[] = [];
  const rects: NavRect[] = [];
  for (const candidate of ctx.tiles.values()) {
    if (candidate === from) continue;
    if (candidate.state !== 'alive') continue;
    eligible.push(candidate);
    const candRect = candidate.slotPlaceholder !== null
      ? candidate.slotPlaceholder.getBoundingClientRect()
      : candidate.root.getBoundingClientRect();
    rects.push(candRect);
  }
  const idx = pickGridNeighbourIndex(fromRect, rects, direction);
  return idx === -1 ? null : eligible[idx];
}

/** HS-8028 — switch the magnified view from the current tile to `next`,
 *  preserving the user's current magnification mode. */
function magnifyTile(ctx: TileGridContext, next: InternalTile, mode: 'center' | 'dedicated'): void {
  if (mode === 'center') {
    // Synchronously uncenter the prior tile without animation; the
    // new center will animate from its grid position to the centered
    // position right after, which feels like a single composite
    // transition.
    const prev = ctx.centered.current;
    if (prev !== null) {
      const placeholder = prev.slotPlaceholder;
      ctx.centered.current = null;
      removeCenterBackdrop(ctx);
      if (ctx.opts.onTileShrink !== undefined) ctx.opts.onTileShrink(prev.entry);
      finishUncenterTile(ctx, prev, placeholder);
    }
    centerTile(ctx, next);
  } else {
    // Dedicated → swap. Force-clear `priorCenteredTile` so exit
    // doesn't animate through a stale centered state on the way out
    // (we're about to enter dedicated for `next` immediately).
    if (ctx.dedicated.current !== null) ctx.dedicated.current.priorCenteredTile = null;
    exitDedicatedView(ctx);
    enterDedicatedView(ctx, next, null);
  }
}
