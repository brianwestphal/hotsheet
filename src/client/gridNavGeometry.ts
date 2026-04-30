/**
 * HS-8028 follow-up — pure geometry helper for grid-neighbour navigation.
 *
 * Pre-fix `terminalTileGrid.tsx::findNextTileInDirection` used a
 * perpendicular-weighted cone metric that would reach into a different
 * row when no same-row neighbour existed. The user's reply on HS-8028
 * pinned the desired behaviour: arrow-left lands on the tile *immediately
 * to the left in the SAME ROW* — no row-jumping. If no tile shares the
 * row / column AND lies in the indicated direction, the action is a
 * no-op.
 *
 * Same-row / same-column is determined by positive bounding-rect overlap
 * on the perpendicular axis. This file holds the pure logic so it's
 * testable in isolation from xterm / DOM / IntersectionObserver.
 */

import type { GridNavDirection } from './terminalKeybindings.js';

/** Minimal rect shape — `getBoundingClientRect()` is structurally compatible. */
export interface NavRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Pick the immediate-neighbour rect in `direction` from `from` among
 * `candidates`. Returns the chosen rect's index, or `-1` when no
 * candidate qualifies (no same-row / same-column rect lies strictly in
 * the indicated direction).
 *
 * Candidates may include zero-size rects (skipped) but should not
 * include `from` itself — caller is expected to filter that.
 */
export function pickGridNeighbourIndex(
  from: NavRect,
  candidates: readonly NavRect[],
  direction: GridNavDirection,
): number {
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < candidates.length; i++) {
    const r = candidates[i];
    if ((r.right - r.left) === 0 && (r.bottom - r.top) === 0) continue;

    if (direction === 'left' || direction === 'right') {
      // Same-row gate: vertical bounding-rect ranges must overlap.
      const verticalOverlap = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
      if (verticalOverlap <= 0) continue;
      // Strict half-plane test in the indicated direction.
      if (direction === 'left' && r.right > from.left) continue;
      if (direction === 'right' && r.left < from.right) continue;
      const dist = direction === 'left' ? from.left - r.right : r.left - from.right;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    } else {
      // Same-column gate: horizontal bounding-rect ranges must overlap.
      const horizontalOverlap = Math.min(from.right, r.right) - Math.max(from.left, r.left);
      if (horizontalOverlap <= 0) continue;
      if (direction === 'up' && r.bottom > from.top) continue;
      if (direction === 'down' && r.top < from.bottom) continue;
      const dist = direction === 'up' ? from.top - r.bottom : r.top - from.bottom;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
  }
  return bestIdx;
}
