import { describe, expect, it } from 'vitest';

import { type NavRect, pickGridNeighbourIndex } from './gridNavGeometry.js';

/** Build a rect from (x, y, w, h). Most fixtures here use a uniform 100×60
 *  tile size so the per-direction math is easy to eyeball. */
function rect(x: number, y: number, w: number, h: number): NavRect {
  return { left: x, right: x + w, top: y, bottom: y + h };
}

describe('pickGridNeighbourIndex (HS-8028 follow-up — strict grid neighbour)', () => {
  // 3×2 grid:
  //  [0:A][1:B][2:C]
  //  [3:D][4:E][5:F]
  //
  // Each tile is 100×60 with 0 gutter, top-left at (0, 0).
  const A = rect(0, 0, 100, 60);
  const B = rect(100, 0, 100, 60);
  const C = rect(200, 0, 100, 60);
  const D = rect(0, 60, 100, 60);
  const E = rect(100, 60, 100, 60);
  const F = rect(200, 60, 100, 60);
  const grid = [A, B, C, D, E, F];

  it('right from A picks B (immediate same-row neighbour)', () => {
    expect(pickGridNeighbourIndex(A, [B, C, D, E, F], 'right')).toBe(0); // index 0 → B
  });

  it('left from C picks B (skips A which is two columns away)', () => {
    expect(pickGridNeighbourIndex(C, [A, B, D, E, F], 'left')).toBe(1); // index 1 → B
  });

  it('down from A picks D (same column directly below)', () => {
    expect(pickGridNeighbourIndex(A, [B, C, D, E, F], 'down')).toBe(2); // index 2 → D
  });

  it('up from D picks A (same column directly above)', () => {
    expect(pickGridNeighbourIndex(D, [A, B, C, E, F], 'up')).toBe(0); // index 0 → A
  });

  it('left from A returns -1 (no tile to the left in row)', () => {
    expect(pickGridNeighbourIndex(A, [B, C, D, E, F], 'left')).toBe(-1);
  });

  it('right from F returns -1 (no tile to the right in row)', () => {
    expect(pickGridNeighbourIndex(F, [A, B, C, D, E], 'right')).toBe(-1);
  });

  it('up from A returns -1 (no tile above)', () => {
    expect(pickGridNeighbourIndex(A, [B, C, D, E, F], 'up')).toBe(-1);
  });

  it('down from D returns -1 (no tile below)', () => {
    expect(pickGridNeighbourIndex(D, [A, B, C, E, F], 'down')).toBe(-1);
  });

  // The KEY behavioural change from the prior cone-metric: arrow-down from
  // C MUST land on F (same column directly below), NOT on E even though
  // E might be closer by Euclidean distance with the previous weighting.
  // This pins the user's HS-8028 follow-up requirement: "if i click left
  // / up / down it should show the terminal in that direction in the grid".
  it('down from C picks F (same column), not E (different column)', () => {
    expect(pickGridNeighbourIndex(C, [A, B, D, E, F], 'down')).toBe(4); // index 4 → F
  });

  it('returns -1 when no rect shares a row OR a column AND lies in direction', () => {
    // Single rect to the upper-right of `from` — shares neither row nor
    // column. With cone-metric this would have matched as a diagonal; the
    // strict grid-neighbour gate rejects it.
    const from = rect(0, 100, 100, 60);
    const offDiagonal = rect(200, 0, 100, 60);
    expect(pickGridNeighbourIndex(from, [offDiagonal], 'right')).toBe(-1);
    expect(pickGridNeighbourIndex(from, [offDiagonal], 'up')).toBe(-1);
  });

  it('skips zero-size rects (hidden / not laid out)', () => {
    const zero = rect(105, 0, 0, 0); // would be a same-row neighbour of A if it had area
    expect(pickGridNeighbourIndex(A, [zero, B], 'right')).toBe(1); // skips index 0, picks B
  });

  it('picks the closer of two same-row neighbours in the same direction', () => {
    const far = rect(300, 0, 100, 60);
    expect(pickGridNeighbourIndex(A, [B, far], 'right')).toBe(0); // B is closer than far
  });

  it('partial-row overlap still counts as same row', () => {
    // Tile slightly shifted vertically — bounding-rect ranges still
    // overlap, so it qualifies as same-row. This is realistic for grids
    // where rows have uneven heights or sub-pixel offsets.
    const offset = rect(100, 30, 100, 60);
    expect(pickGridNeighbourIndex(A, [offset], 'right')).toBe(0);
  });

  it('zero overlap (touching but not crossing) does not count as same-row', () => {
    // Touching boundary: A.bottom === touching.top. verticalOverlap === 0
    // → not same-row. Strict positive overlap is required.
    const touching = rect(100, 60, 100, 60);
    expect(pickGridNeighbourIndex(A, [touching], 'right')).toBe(-1);
  });

  it('handles 4 neighbours of a centre tile correctly', () => {
    // 3×3 grid, E is the centre.
    const A2 = rect(0, 0, 100, 60);
    const B2 = rect(100, 0, 100, 60);
    const C2 = rect(200, 0, 100, 60);
    const D2 = rect(0, 60, 100, 60);
    const E2 = rect(100, 60, 100, 60);
    const F2 = rect(200, 60, 100, 60);
    const G2 = rect(0, 120, 100, 60);
    const H2 = rect(100, 120, 100, 60);
    const I2 = rect(200, 120, 100, 60);
    const others = [A2, B2, C2, D2, F2, G2, H2, I2];
    expect(pickGridNeighbourIndex(E2, others, 'left')).toBe(3); // D2
    expect(pickGridNeighbourIndex(E2, others, 'right')).toBe(4); // F2
    expect(pickGridNeighbourIndex(E2, others, 'up')).toBe(1); // B2
    expect(pickGridNeighbourIndex(E2, others, 'down')).toBe(6); // H2
  });
});
