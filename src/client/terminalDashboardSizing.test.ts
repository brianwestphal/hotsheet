import { describe, expect, it } from 'vitest';

import {
  computeColumnSnapPoints,
  computeTileGridDims,
  computeTileScale,
  computeTileWidth,
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
  DASHBOARD_TARGET_NATURAL_HEIGHT_PX,
  DASHBOARD_TARGET_NATURAL_WIDTH_PX,
  DEFAULT_TILES_PER_ROW,
  legacySliderValueToColumnCount,
  MAX_TILES_PER_ROW,
  MIN_TILES_PER_ROW,
  perRowToSliderPosition,
  sliderPositionToPerRow,
  tickLeftPx,
  TILE_ASPECT,
  tileNativeGridFromCellMetrics,
  tileWidthFromColumnCount,
} from './terminalDashboardSizing.js';

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

/**
 * HS-6865 + HS-6931 — `computeTileScale` picks a single uniform scale factor
 * + explicit xterm-root width / height that keeps xterm's internal layout
 * intact while scaling the canvas to fit the tile preview area. Invariants:
 * `scale` is `min(tileWidth / width, tileHeight / height)`, neither scaled
 * axis overflows the tile, and at least one axis is tight (fit-inside).
 *
 * Without explicit dims xterm's absolutely-positioned viewport collapses
 * (HS-6865). A uniform scale — rather than separate scaleX / scaleY —
 * preserves text metrics; HS-6898's two-axis fill was reverted after the
 * stretched text from anisotropic scaling was deemed unacceptable (HS-6931).
 */
describe('computeTileScale (HS-6865, HS-6931)', () => {
  it('uses a single uniform scale factor so text metrics are preserved (HS-6931)', () => {
    // Tile 1280×960 (4:3), natural xterm 640×960 (2:3). Uniform fit-inside
    // picks min(1280/640, 960/960) = min(2, 1) = 1 — the height is the
    // limiting axis and the tile has 640 px of horizontal dead space, but
    // text keeps its natural proportions rather than stretching 2× wide.
    const out = computeTileScale(1280, 960, 640, 960);
    expect(out).not.toBeNull();
    expect(out!.scale).toBeCloseTo(1, 6);
    expect(out!.width).toBe(640);
    expect(out!.height).toBe(960);
  });

  /**
   * HS-6997 — the scaled xterm is top-aligned inside the tile preview so
   * content reads from the top like a real terminal pane. Horizontal remains
   * centered for the rare portrait-PTY case where the tight axis is vertical.
   * The pre-HS-6997 math used `(tileHeight - scaledHeight) / 2` for the top
   * offset and sandwiched the content between equal bands top and bottom —
   * visible with wide / short PTYs (e.g. 151 × 13 at natural 1181 × 208, the
   * exact dims in the bug report) where uniform scaling only covers a small
   * fraction of the tile's vertical space.
   */
  it('top-aligns the scaled xterm so dead vertical space falls below the content (HS-6997)', () => {
    // Wide-short PTY like HS-6997: natural aspect ≈ 5.68, tile is 4:3.
    // Uniform scale fills width, leaves ~230 px of vertical dead space.
    // That space must be AT THE BOTTOM (top = 0), not split top/bottom.
    const out = computeTileScale(400, 300, 1181, 208);
    expect(out).not.toBeNull();
    expect(out!.top).toBe(0);
    // Horizontal is tight here, so left is also 0 (no letterboxing needed).
    expect(out!.left).toBeCloseTo(0, 6);
    const scaledH = out!.height * out!.scale;
    // Confirm there really IS vertical dead space for this case — otherwise
    // the top=0 invariant is vacuous.
    expect(scaledH).toBeLessThan(300 - 100); // more than 100 px of dead space
  });

  it('horizontally centers when the tight axis is vertical (rare portrait-PTY case)', () => {
    // Tall / narrow PTY — height is the tight axis, width has dead space.
    // Vertical top-align still holds; horizontal centers the scaled xterm.
    const out = computeTileScale(400, 300, 320, 960);
    expect(out).not.toBeNull();
    expect(out!.top).toBe(0); // HS-6997: always top-aligned
    // Uniform scale = min(400/320, 300/960) = min(1.25, 0.3125) = 0.3125.
    // Scaled: 100 × 300. Horizontal dead space = 300 px → left = 150.
    const scaledW = out!.width * out!.scale;
    expect(out!.left).toBeCloseTo((400 - scaledW) / 2, 6);
    expect(out!.left).toBeGreaterThan(0);
  });

  it('offsets are 0 when the scaled size fills the tile exactly', () => {
    // natural 4:3 in a 4:3 tile → uniform scale fills both axes tight.
    const out = computeTileScale(400, 300, 1280, 960);
    expect(out).not.toBeNull();
    expect(out!.left).toBeCloseTo(0, 6);
    expect(out!.top).toBe(0);
  });

  it('returns xterm natural dims as the explicit width/height (HS-6865)', () => {
    const out = computeTileScale(140, 105, 640, 960);
    expect(out).not.toBeNull();
    // Natural dims are returned unchanged so xterm's internal viewport has
    // a concrete pre-transform box to render into.
    expect(out!.width).toBe(640);
    expect(out!.height).toBe(960);
  });

  it('scale is the smaller of tileWidth/width and tileHeight/height (fit-inside)', () => {
    const cases: Array<[number, number, number, number]> = [
      [200, 150, 640, 960],
      [480, 360, 640, 960],
      [140, 105, 800, 600],
      [320, 240, 1024, 768],
    ];
    for (const [tw, th, nw, nh] of cases) {
      const out = computeTileScale(tw, th, nw, nh);
      expect(out).not.toBeNull();
      const expected = Math.min(tw / nw, th / nh);
      expect(out!.scale).toBeCloseTo(expected, 6);
      // Neither axis overflows.
      expect(out!.width * out!.scale).toBeLessThanOrEqual(tw + 1e-6);
      expect(out!.height * out!.scale).toBeLessThanOrEqual(th + 1e-6);
      // At least one axis is tight (uniform fit-inside).
      const wTight = Math.abs(out!.width * out!.scale - tw) < 1e-6;
      const hTight = Math.abs(out!.height * out!.scale - th) < 1e-6;
      expect(wTight || hTight).toBe(true);
    }
  });

  it('returns null for zero / negative dims (avoids NaN / Infinity on style strings)', () => {
    expect(computeTileScale(0, 100, 640, 960)).toBeNull();
    expect(computeTileScale(140, 0, 640, 960)).toBeNull();
    expect(computeTileScale(140, 105, 0, 960)).toBeNull();
    expect(computeTileScale(140, 105, 640, 0)).toBeNull();
    expect(computeTileScale(-10, 105, 640, 960)).toBeNull();
  });
});

/**
 * HS-6931 follow-up — `computeTileGridDims` derives cols × rows so xterm's
 * natural pixel size lands on the 4:3 target. The tile's 4:3 preview then
 * matches the xterm's natural aspect; uniform scaling fills the tile with
 * no horizontal letterboxing and no anisotropic stretching.
 */
describe('computeTileGridDims (HS-6931 follow-up)', () => {
  it('produces a grid whose natural pixel size is within 1 cell of the 4:3 target', () => {
    // macOS ui-monospace 13px measured ≈ 8 × 16 px per cell. Running the
    // defaults we expect ~160 × 60, i.e. 1280 × 960 = 4:3.
    const { cols, rows } = computeTileGridDims(8, 16);
    expect(cols).toBe(160);
    expect(rows).toBe(60);
    const naturalWidth = cols * 8;
    const naturalHeight = rows * 16;
    expect(Math.abs(naturalWidth - DASHBOARD_TARGET_NATURAL_WIDTH_PX)).toBeLessThanOrEqual(8);
    expect(Math.abs(naturalHeight - DASHBOARD_TARGET_NATURAL_HEIGHT_PX)).toBeLessThanOrEqual(16);
    // Natural aspect ≈ 4:3 — the invariant that fixes the HS-6931 dead-space
    // complaint. Letterboxing when scaled into a 4:3 tile is now negligible.
    const naturalAspect = naturalWidth / naturalHeight;
    expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeLessThan(0.01);
  });

  it('adapts to larger cells (e.g. higher-DPI ui-monospace at 15 × 30 px)', () => {
    // With 15 × 30 cells the grid should come out smaller in both axes but
    // still target 4:3 natural aspect.
    const { cols, rows } = computeTileGridDims(15, 30);
    expect(cols).toBe(Math.round(DASHBOARD_TARGET_NATURAL_WIDTH_PX / 15));
    expect(rows).toBe(Math.round(DASHBOARD_TARGET_NATURAL_HEIGHT_PX / 30));
    // Naturalwidth = cols*cellW, naturalHeight = rows*cellH → aspect ≈ 4:3.
    const naturalAspect = (cols * 15) / (rows * 30);
    expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeLessThan(0.05);
  });

  it('accepts a fractional measured cell width from .xterm-screen (~8.04 × 16)', () => {
    // HS-6931 reproducer: xterm-screen measured 643 / 80 = 8.0375 px/cell
    // with cellH exactly 960 / 60 = 16 px/cell. Grid should still land near
    // 160 × 60 and yield a natural aspect extremely close to 4:3.
    const cellW = 643 / 80;
    const cellH = 960 / 60;
    const { cols, rows } = computeTileGridDims(cellW, cellH);
    expect(rows).toBe(60);
    expect(Math.abs(cols - 159)).toBeLessThanOrEqual(1);
    const naturalAspect = (cols * cellW) / (rows * cellH);
    expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeLessThan(0.01);
  });

  it('falls back to the original 80 × 60 when cell dims can not be measured', () => {
    // Measurement failures (offsetWidth = 0 before layout) must produce a
    // usable grid, not NaN / Infinity / zero-sized cells. The fallback is
    // the pre-HS-6931-follow-up size.
    expect(computeTileGridDims(0, 16)).toEqual({
      cols: DASHBOARD_FALLBACK_COLS,
      rows: DASHBOARD_FALLBACK_ROWS,
    });
    expect(computeTileGridDims(8, 0)).toEqual({
      cols: DASHBOARD_FALLBACK_COLS,
      rows: DASHBOARD_FALLBACK_ROWS,
    });
    expect(computeTileGridDims(-1, -1)).toEqual({
      cols: DASHBOARD_FALLBACK_COLS,
      rows: DASHBOARD_FALLBACK_ROWS,
    });
  });

  it('enforces a minimum grid so an absurd cell size does not collapse to zero cols', () => {
    const { cols, rows } = computeTileGridDims(10_000, 10_000);
    expect(cols).toBeGreaterThan(0);
    expect(rows).toBeGreaterThan(0);
  });
});

/**
 * HS-8176 — `tileWidthFromColumnCount` replaces the pre-HS-8176
 * `tileWidthFromSlider` (continuous 0..100 → tile width). The new
 * formula is:
 *
 *     tileWidth = (rootWidth - (perRow - 1) * TILE_GAP) / perRow
 *
 * Clamped to a 1 px floor (no SLIDER_MIN_TILE_WIDTH gate — the user
 * explicitly chose perRow). Pinned via unit tests so a future tweak
 * to the slider wiring can't silently change the math.
 */
describe('tileWidthFromColumnCount (HS-8176)', () => {
  it('perRow=1 returns the full root width (one big tile, no gap)', () => {
    expect(tileWidthFromColumnCount(1, 1000)).toBe(1000);
    expect(tileWidthFromColumnCount(1, 555)).toBe(555);
  });

  it('perRow=2 returns half the root width minus one gap divided in two', () => {
    // (1000 - 12) / 2 = 494
    expect(tileWidthFromColumnCount(2, 1000)).toBe(494);
  });

  it('perRow=10 returns a tenth of the root width minus 9 gaps', () => {
    // (1000 - 9 * 12) / 10 = 89.2 → floor 89
    expect(tileWidthFromColumnCount(10, 1000)).toBe(89);
  });

  it('clamps perRow to MIN_TILES_PER_ROW..MAX_TILES_PER_ROW', () => {
    // Below floor → MIN_TILES_PER_ROW (one big tile).
    expect(tileWidthFromColumnCount(0, 1000)).toBe(tileWidthFromColumnCount(MIN_TILES_PER_ROW, 1000));
    expect(tileWidthFromColumnCount(-5, 1000)).toBe(tileWidthFromColumnCount(MIN_TILES_PER_ROW, 1000));
    // Above ceiling → MAX_TILES_PER_ROW (smallest tiles).
    expect(tileWidthFromColumnCount(50, 1000)).toBe(tileWidthFromColumnCount(MAX_TILES_PER_ROW, 1000));
  });

  it('floors a fractional perRow (legacy float values cannot produce a fractional column count)', () => {
    // 4.7 → floors to 4; matches integer 4 exactly.
    expect(tileWidthFromColumnCount(4.7, 1000)).toBe(tileWidthFromColumnCount(4, 1000));
  });

  it('survives a non-finite perRow by routing through the default', () => {
    // NaN, ±Infinity all fail the `Number.isFinite` check inside the
    // helper and fall back to DEFAULT_TILES_PER_ROW before the clamp +
    // floor pass.
    expect(tileWidthFromColumnCount(Number.NaN, 1000)).toBe(tileWidthFromColumnCount(DEFAULT_TILES_PER_ROW, 1000));
    expect(tileWidthFromColumnCount(Number.POSITIVE_INFINITY, 1000)).toBe(tileWidthFromColumnCount(DEFAULT_TILES_PER_ROW, 1000));
    expect(tileWidthFromColumnCount(Number.NEGATIVE_INFINITY, 1000)).toBe(tileWidthFromColumnCount(DEFAULT_TILES_PER_ROW, 1000));
  });

  it('returns at least 1 px even when rootWidth cannot fit perRow tiles', () => {
    // 50 px root with perRow=10 → (50 - 108) / 10 = -5.8. Floor 1.
    expect(tileWidthFromColumnCount(10, 50)).toBe(1);
    // 0-width root → 1 (defensive against CSS width: 0 collapsing xterm).
    expect(tileWidthFromColumnCount(5, 0)).toBe(1);
  });

  it('produces the same width whether the user passes a stringified or numeric perRow (after Number.parseInt at the slider boundary)', () => {
    // The slider value is read via `Number.parseInt(sizeSlider.value, 10)`
    // before reaching this helper, so we don't accept strings here — but we
    // DO accept floats from the persistence layer's legacy migration.
    expect(tileWidthFromColumnCount(3, 1200)).toBe(tileWidthFromColumnCount(3.0, 1200));
  });
});

/**
 * HS-8176 — `perRowToSliderPosition` and `sliderPositionToPerRow` are
 * the conversion at the slider IO boundary. The slider element is LTR
 * (1 leftmost, 10 rightmost), but the user's mental model is left =
 * many small tiles, right = one big — so the column count is the
 * inverse of the slider position.
 */
describe('perRowToSliderPosition / sliderPositionToPerRow (HS-8176)', () => {
  it('inverts: perRow=1 → sliderPos=MAX, perRow=MAX → sliderPos=1', () => {
    expect(perRowToSliderPosition(MIN_TILES_PER_ROW)).toBe(MAX_TILES_PER_ROW);
    expect(perRowToSliderPosition(MAX_TILES_PER_ROW)).toBe(MIN_TILES_PER_ROW);
  });

  it('round-trips for every value in range', () => {
    for (let perRow = MIN_TILES_PER_ROW; perRow <= MAX_TILES_PER_ROW; perRow += 1) {
      expect(sliderPositionToPerRow(perRowToSliderPosition(perRow))).toBe(perRow);
    }
    for (let pos = MIN_TILES_PER_ROW; pos <= MAX_TILES_PER_ROW; pos += 1) {
      expect(perRowToSliderPosition(sliderPositionToPerRow(pos))).toBe(pos);
    }
  });

  it('clamps inputs outside the valid range', () => {
    expect(perRowToSliderPosition(0)).toBe(perRowToSliderPosition(MIN_TILES_PER_ROW));
    expect(perRowToSliderPosition(20)).toBe(perRowToSliderPosition(MAX_TILES_PER_ROW));
    expect(sliderPositionToPerRow(-3)).toBe(sliderPositionToPerRow(MIN_TILES_PER_ROW));
    expect(sliderPositionToPerRow(50)).toBe(sliderPositionToPerRow(MAX_TILES_PER_ROW));
  });

  it('rounds fractional inputs to the nearest integer', () => {
    expect(perRowToSliderPosition(4.4)).toBe(perRowToSliderPosition(4));
    expect(sliderPositionToPerRow(7.6)).toBe(sliderPositionToPerRow(8));
  });
});

/**
 * HS-8176 — `legacySliderValueToColumnCount` migrates a pre-HS-8176
 * persisted `dashboard_slider_value` (continuous 0..100) to a
 * post-HS-8176 column count (integer 1..10). Linear mapping so users
 * who had the old default 33 land on a sensible mid-range value.
 */
describe('legacySliderValueToColumnCount (HS-8176)', () => {
  it('maps the pre-fix endpoints', () => {
    expect(legacySliderValueToColumnCount(0)).toBe(MIN_TILES_PER_ROW);
    expect(legacySliderValueToColumnCount(100)).toBe(MAX_TILES_PER_ROW);
  });

  it('passes through values that are already in the new range', () => {
    for (let perRow = MIN_TILES_PER_ROW; perRow <= MAX_TILES_PER_ROW; perRow += 1) {
      expect(legacySliderValueToColumnCount(perRow)).toBe(perRow);
    }
  });

  it('clamps out-of-range legacy values', () => {
    expect(legacySliderValueToColumnCount(-50)).toBe(MIN_TILES_PER_ROW);
    expect(legacySliderValueToColumnCount(500)).toBe(MAX_TILES_PER_ROW);
  });

  it('returns DEFAULT_TILES_PER_ROW for non-finite inputs', () => {
    expect(legacySliderValueToColumnCount(Number.NaN)).toBe(DEFAULT_TILES_PER_ROW);
    expect(legacySliderValueToColumnCount(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TILES_PER_ROW);
  });

  it('the pre-HS-8176 default 33 lands inside the valid post-fix range', () => {
    const migrated = legacySliderValueToColumnCount(33);
    expect(migrated).toBeGreaterThanOrEqual(MIN_TILES_PER_ROW);
    expect(migrated).toBeLessThanOrEqual(MAX_TILES_PER_ROW);
  });
});

/**
 * HS-7097 follow-up — the grid tile's xterm resizes to tile-native 4:3 dims
 * after every history replay (and at initial mount) so its natural pixel
 * aspect matches the tile's 4:3 preview frame. `tileNativeGridFromCellMetrics`
 * is the pure policy function call-sites hit; it wraps `computeTileGridDims`
 * so the tile's tile-native intent reads clearly at the call site.
 *
 * Previous iterations are superseded:
 *   - HS-6965 `tileTargetFromHistory` (returned the PTY's dims verbatim) left
 *     wide PTYs showing large bands of vertical dead space in the tile's 4:3
 *     frame. Reverted.
 *   - HS-7099 `tileResyncOnExitDedicated` (mirrored the dedicated view's fit
 *     dims onto the tile) locked the tile's natural aspect to whatever non-
 *     4:3 geometry the dedicated pane landed on. Reverted.
 *   Both removed in HS-7097's follow-up — tile stays on tile-native 4:3
 *   dims for its whole lifetime and accepts live-byte wrap at the tile's
 *   narrower cols as the trade-off.
 */
describe('tileNativeGridFromCellMetrics (HS-7097 follow-up)', () => {
  it('returns a 4:3-natural grid so the tile frame fills without letterboxing', () => {
    // macOS ui-monospace 13 px measured ≈ 8 × 16 px per cell → 160 × 60 =
    // 1280 × 960 = 4:3 natural.
    const { cols, rows } = tileNativeGridFromCellMetrics(8, 16);
    expect(cols).toBe(160);
    expect(rows).toBe(60);
    const naturalAspect = (cols * 8) / (rows * 16);
    expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeLessThan(0.01);
  });

  it('delegates to computeTileGridDims (including fallback on zero cells)', () => {
    // A zero measurement (xterm not yet laid out) should still produce a
    // usable grid — the same 80 × 60 fallback computeTileGridDims returns.
    const fallback = { cols: DASHBOARD_FALLBACK_COLS, rows: DASHBOARD_FALLBACK_ROWS };
    expect(tileNativeGridFromCellMetrics(0, 16)).toEqual(fallback);
    expect(tileNativeGridFromCellMetrics(8, 0)).toEqual(fallback);
  });

  // HS-8051 follow-up regression — the user's stuck Domotion tile was
  // rendering at screenW=1692, screenH=1200, consistent with term.cols=80,
  // term.rows=60, cellW=21.15, cellH=20 (a project with a noticeably larger
  // font than the four good tiles, which were at cellW≈8, cellH=16). The
  // algorithm must produce a 4:3 result for these cell metrics so the chained-
  // rAF retry in terminalTileGrid.tsx::scheduleResyncRetry has somewhere
  // to converge to. Pre-fix the resync seemed to never run for this tile —
  // the chained retry is the actual fix, but locking the algorithm output
  // here makes sure a future tweak to computeTileGridDims doesn't quietly
  // break the convergence target.
  it('produces a 4:3-natural grid for the user-reported large-font cell metrics (cellW=21.15, cellH=20)', () => {
    const { cols, rows } = tileNativeGridFromCellMetrics(21.15, 20);
    // 1280 / 21.15 ≈ 60.52 → 61. 960 / 20 = 48.
    expect(cols).toBe(61);
    expect(rows).toBe(48);
    const naturalAspect = (cols * 21.15) / (rows * 20);
    // Within 1% of 4:3 — rounding errors at the cell-count level can't push
    // the aspect off enough to leave visible letterbox in the tile frame.
    expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeLessThan(0.02);
  });

  it('produces a 4:3-natural grid for a range of plausible larger-font cell metrics', () => {
    // Sweep cell metrics around the user's reported value to confirm the
    // algorithm is robust to font / DPI variation. Each (cellW, cellH) pair
    // models a font-size config that produces those measured cell dims at
    // the tile's xterm-screen.
    const sweep: Array<[number, number]> = [
      [10, 20],     // mono at ~17 pt
      [12, 24],     // mono at ~20 pt
      [14.1, 20],   // condensed-tall mono
      [16, 16],     // square cells
      [21.15, 20],  // user-reported Domotion
      [25, 30],     // very large font
    ];
    for (const [cellW, cellH] of sweep) {
      const { cols, rows } = tileNativeGridFromCellMetrics(cellW, cellH);
      const naturalAspect = (cols * cellW) / (rows * cellH);
      expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeLessThan(0.05);
    }
  });
});

/**
 * HS-8176 — `computeColumnSnapPoints` returns one snap per integer
 * column count from `MIN_TILES_PER_ROW` to `MAX_TILES_PER_ROW`. Same
 * shape regardless of `rootWidth` (post-HS-8176 the slider is
 * integer-only — every value IS a snap), but `tileWidth` reflects the
 * given root so the UI can render a tooltip per snap.
 */
describe('computeColumnSnapPoints (HS-8176)', () => {
  it('returns exactly MAX - MIN + 1 snaps regardless of rootWidth', () => {
    const expected = MAX_TILES_PER_ROW - MIN_TILES_PER_ROW + 1;
    expect(computeColumnSnapPoints(1000).length).toBe(expected);
    expect(computeColumnSnapPoints(400).length).toBe(expected);
    expect(computeColumnSnapPoints(50).length).toBe(expected);
  });

  it('one snap per integer column count', () => {
    const perRows = new Set(computeColumnSnapPoints(1000).map(p => p.perRow));
    expect(perRows).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
  });

  it('sliderValue is the inverse of perRow per perRowToSliderPosition', () => {
    for (const p of computeColumnSnapPoints(1000)) {
      expect(p.sliderValue).toBe(perRowToSliderPosition(p.perRow));
    }
  });

  it('tileWidth matches tileWidthFromColumnCount for the given rootWidth', () => {
    const rootWidth = 1200;
    for (const p of computeColumnSnapPoints(rootWidth)) {
      expect(p.tileWidth).toBe(tileWidthFromColumnCount(p.perRow, rootWidth));
    }
  });

  it('the perRow=1 snap maps to slider position MAX (rightmost — one big tile)', () => {
    const points = computeColumnSnapPoints(1000);
    const single = points.find(p => p.perRow === 1)!;
    expect(single.sliderValue).toBe(MAX_TILES_PER_ROW);
  });

  it('the perRow=MAX snap maps to slider position 1 (leftmost — most tiles)', () => {
    const points = computeColumnSnapPoints(1000);
    const max = points.find(p => p.perRow === MAX_TILES_PER_ROW)!;
    expect(max.sliderValue).toBe(MIN_TILES_PER_ROW);
  });
});

/**
 * HS-7950 — `tickLeftPx` shifts each snap-point tick from its naive
 * `sliderValue%` position to the centre of where the native range thumb
 * actually sits at that value. Without this, leftmost ticks bunched under
 * a non-existent thumb position and rightmost ticks fell off the rail.
 *
 * The math: thumb centre travels `[thumbW/2, sliderW - thumbW/2]` as
 * value goes 0..100. So a tick at slider value v lands at
 * `thumbW/2 + (v/100) * (sliderW - thumbW)`.
 */
describe('tickLeftPx (HS-7950)', () => {
  it('value 0 lands at half a thumb in from the left edge', () => {
    expect(tickLeftPx(0, 200, 16)).toBe(8);
  });

  it('value 100 lands at half a thumb in from the right edge', () => {
    expect(tickLeftPx(100, 200, 16)).toBe(192);
  });

  it('value 50 lands at the midpoint of the slider', () => {
    expect(tickLeftPx(50, 200, 16)).toBe(100);
  });

  it('clamps a sub-zero value to 0', () => {
    expect(tickLeftPx(-10, 200, 16)).toBe(8);
  });

  it('clamps an over-100 value to 100', () => {
    expect(tickLeftPx(150, 200, 16)).toBe(192);
  });

  it('handles a wider thumb proportionally (thumbW=24)', () => {
    expect(tickLeftPx(0, 200, 24)).toBe(12);
    expect(tickLeftPx(100, 200, 24)).toBe(188);
    expect(tickLeftPx(50, 200, 24)).toBe(100);
  });

  it('degenerate sliderW <= thumbW collapses every tick to thumbW/2 (no usable range)', () => {
    expect(tickLeftPx(0, 16, 16)).toBe(8);
    expect(tickLeftPx(50, 16, 16)).toBe(8);
    expect(tickLeftPx(100, 16, 16)).toBe(8);
    expect(tickLeftPx(50, 10, 16)).toBe(8); // smaller-than-thumb slider stays clamped
  });

  it('unstyled CSS-default thumb (16px) keeps midpoint exact at any slider width', () => {
    for (const w of [80, 100, 200, 320, 480]) {
      expect(tickLeftPx(50, w, 16)).toBeCloseTo(w / 2, 5);
    }
  });
});
