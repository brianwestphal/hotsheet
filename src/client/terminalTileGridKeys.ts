/**
 * HS-8411 (Cycle 4b) — pure key helpers. Shared across every
 * `terminalTileGrid*` sub-module; pre-split they lived inside
 * `terminalTileGrid.tsx`.
 *
 * HS-8285 follow-up — every internal map in the tile-grid keys tiles by
 * the composite `${secret}::${id}`, NOT just `id`. In flow mode
 * (HS-7662 / §25.10.5) a single tile-grid handle holds tiles from
 * EVERY registered project, and two different projects routinely have
 * terminals with the same id (e.g. every project starts with a
 * `default` terminal). Pre-fix the maps were keyed by `entry.id` alone,
 * so the second project's `default` tile silently overwrote the first
 * project's entry. The `${secret}::${id}` shape matches the checkout
 * module's entry-key format too so a tile's registry key is also
 * debuggable as a checkout lookup string.
 */

export function tileKey(secret: string, id: string): string {
  return `${secret}::${id}`;
}

export function tileKeyFor(entry: { secret: string; id: string }): string {
  return tileKey(entry.secret, entry.id);
}
