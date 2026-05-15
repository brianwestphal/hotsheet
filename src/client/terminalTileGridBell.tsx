import { apiWithSecret } from './api.js';
import { tileKeyFor } from './terminalTileGridKeys.js';
import type { InternalTile, TileGridContext } from './terminalTileGridTypes.js';

/**
 * HS-8402 / HS-8411 (Cycle 1 lift + Cycle 4b split) — bell-clearing
 * helpers. The §22 / §23 / §24 cross-project bell flow paints a
 * `.has-bell` indicator on tiles whose terminal printed `\x07` while
 * out of view. These helpers clear that indicator when (a) the user
 * is now looking at the tile in the unoccluded grid surface and
 * (b) we want the server-side `bellPending` flag dropped so other
 * surfaces (project-tab glyph, drawer tab) don't redundantly mark it.
 */

/** HS-8046 — true when nothing is occluding the grid layout, so a tile
 *  in the viewport really IS the surface the user is looking at. While
 *  a centered overlay or dedicated view is up, the rest of the grid is
 *  visually behind / hidden, so bells for those tiles should NOT
 *  auto-clear (the user can't actually see them). */
export function isGridSurfaceUnoccluded(ctx: TileGridContext): boolean {
  return ctx.centered.current === null && ctx.dedicated.current === null;
}

/** HS-8046 — POST `/clear-bell` for a tile WITHOUT first checking the
 *  class. Used by the auto-clear path: when a bell tries to land on a
 *  tile the user is already looking at, we want to drop the server's
 *  `bellPending` flag without ever rendering the indicator locally. */
export function postClearBell(_ctx: TileGridContext, tile: InternalTile): void {
  void apiWithSecret('/terminal/clear-bell', tile.entry.secret, {
    method: 'POST',
    body: { terminalId: tile.entry.id },
  }).catch(() => { /* server restart / network blip — long-poll resyncs */ });
}

export function clearTileBell(ctx: TileGridContext, tile: InternalTile): void {
  if (!tile.root.classList.contains('has-bell')) return;
  tile.root.classList.remove('has-bell');
  postClearBell(ctx, tile);
}

/** HS-8046 — clear the bell for `tile` when (a) the grid surface is
 *  unoccluded (no centered overlay / dedicated view) AND (b) the tile
 *  root is currently in the viewport. The user is actively looking at
 *  this terminal — no reason to keep the bell indicator. */
export function maybeAutoClearTileBell(ctx: TileGridContext, tile: InternalTile): void {
  if (!isGridSurfaceUnoccluded(ctx)) return;
  if (!ctx.visibleTileIds.has(tileKeyFor(tile.entry))) return;
  clearTileBell(ctx, tile);
}

/** HS-8046 — sweep every currently-visible tile for `has-bell`, called
 *  whenever the grid surface becomes unoccluded again (centered or
 *  dedicated view dismissed). Bells that accumulated WHILE the
 *  occluding view was up are now visible to the user; auto-clear them. */
export function clearBellsForVisibleTiles(ctx: TileGridContext): void {
  for (const id of ctx.visibleTileIds) {
    const t = ctx.tiles.get(id);
    if (t === undefined) continue;
    clearTileBell(ctx, t);
  }
}
