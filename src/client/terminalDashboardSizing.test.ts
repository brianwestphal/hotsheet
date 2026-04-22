import { describe, expect, it } from 'vitest';

import { computeTileWidth } from './terminalDashboardSizing.js';

/**
 * HS-6833 — `computeTileWidth` picks the largest tile width (multiple of 10)
 * where every section's tiles fit inside the viewport. It must honour the
 * 100 px preview-height floor (MIN_TILE_HEIGHT × 4/3 = 133 width rounded
 * up to the step = 140 px) and never return 0 / NaN.
 */
describe('computeTileWidth (HS-6833)', () => {
  it('returns MAX_TILE_WIDTH when the viewport can trivially accommodate the largest step', () => {
    const w = computeTileWidth({
      rootWidth: 4000,
      rootHeight: 4000,
      projectTileCounts: [1],
      hasEmptySection: false,
    });
    expect(w).toBe(480);
  });

  it('shrinks the tile when every section together would overflow the viewport height', () => {
    const big = computeTileWidth({
      rootWidth: 1600,
      rootHeight: 4000,
      projectTileCounts: [2, 3, 4],
      hasEmptySection: false,
    });
    const small = computeTileWidth({
      rootWidth: 1600,
      rootHeight: 600,
      projectTileCounts: [2, 3, 4],
      hasEmptySection: false,
    });
    expect(small).toBeLessThan(big);
    expect(small % 10).toBe(0);
  });

  it('never returns a width whose preview height is below the 100 px floor', () => {
    // MIN_TILE_HEIGHT=100, TILE_ASPECT=4/3 → floor width = round(100 * 4/3) = 133
    const w = computeTileWidth({
      rootWidth: 400,
      rootHeight: 50,
      projectTileCounts: [20, 20, 20],
      hasEmptySection: false,
    });
    expect(w).toBeGreaterThanOrEqual(133);
  });

  it('handles the zero-terminal-section case (heading + empty-state row only)', () => {
    // Empty sections reserve layout for the heading + a single empty-state
    // row, not for the full tile height, so they should not force the tile
    // width down as aggressively as a filled section of the same count.
    const w = computeTileWidth({
      rootWidth: 1600,
      rootHeight: 600,
      projectTileCounts: [0, 0, 0],
      hasEmptySection: true,
    });
    expect(w).toBe(480);
  });

  it('wraps tiles onto multiple rows when a section has more tiles than the row can hold', () => {
    // rootWidth 600 at tileWidth ~140 leaves room for ~4 tiles per row
    // (gap 12 px). 12 tiles wrap to 3 rows. The return shouldn't be 0.
    const w = computeTileWidth({
      rootWidth: 600,
      rootHeight: 2000,
      projectTileCounts: [12],
      hasEmptySection: false,
    });
    expect(w).toBeGreaterThan(0);
    expect(Number.isFinite(w)).toBe(true);
  });
});
