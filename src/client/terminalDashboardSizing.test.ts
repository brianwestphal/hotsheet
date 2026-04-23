import { describe, expect, it } from 'vitest';

import {
  computeTileGridDims,
  computeTileScale,
  computeTileWidth,
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
  DASHBOARD_TARGET_NATURAL_HEIGHT_PX,
  DASHBOARD_TARGET_NATURAL_WIDTH_PX,
  TILE_ASPECT,
  tileTargetFromHistory,
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
 * HS-6965 — after the server's history frame arrives on a dashboard tile, the
 * xterm MUST adopt the PTY's cols × rows (from the history frame) instead of
 * being force-reset back to a 4:3-optimised target. Otherwise live PTY bytes
 * formatted for the PTY's own geometry wrap at the wrong column inside the
 * xterm and leave a band of empty rows below the last line of real content —
 * the exact "weird wrapping" the bug screenshot showed. This test pins the
 * new policy: `tileTargetFromHistory` returns the history frame's dims
 * verbatim (clamped / floored only), so the caller can assign them straight
 * into `tile.targetCols` / `tile.targetRows`.
 */
describe('tileTargetFromHistory (HS-6965)', () => {
  it('returns the history frame dims verbatim so the xterm matches the PTY', () => {
    // Typical drawer-attached PTY: wide, fewer rows (not 4:3).
    expect(tileTargetFromHistory(235, 41)).toEqual({ cols: 235, rows: 41 });
    // Typical freshly-spawned default: 80 × 24.
    expect(tileTargetFromHistory(80, 24)).toEqual({ cols: 80, rows: 24 });
  });

  it('does NOT fall back to a 4:3 natural target', () => {
    // Regression: the old HS-6931 follow-up resized back to the measured-cell
    // 4:3 grid (~160 × 60). The new policy trades that stable-aspect property
    // for rendering correctness — if the PTY is at 235 × 41 we keep it, even
    // though 235/41 ≈ 5.73 natural aspect leaves vertical letterboxing in the
    // tile's 4:3 preview frame.
    const out = tileTargetFromHistory(235, 41);
    const naturalAspect = out.cols / out.rows;
    expect(naturalAspect).toBeCloseTo(235 / 41, 6);
    expect(Math.abs(naturalAspect - TILE_ASPECT)).toBeGreaterThan(1);
  });

  it('floors fractional history dims (xterm cols / rows are integers)', () => {
    expect(tileTargetFromHistory(235.7, 41.2)).toEqual({ cols: 235, rows: 41 });
  });

  it('falls back to the 80 × 60 defaults when history dims are non-positive / non-finite', () => {
    const fallback = { cols: DASHBOARD_FALLBACK_COLS, rows: DASHBOARD_FALLBACK_ROWS };
    expect(tileTargetFromHistory(0, 24)).toEqual({ cols: fallback.cols, rows: 24 });
    expect(tileTargetFromHistory(80, 0)).toEqual({ cols: 80, rows: fallback.rows });
    expect(tileTargetFromHistory(-1, -1)).toEqual(fallback);
    expect(tileTargetFromHistory(Number.NaN, Number.NaN)).toEqual(fallback);
    expect(tileTargetFromHistory(Number.POSITIVE_INFINITY, 24)).toEqual({ cols: fallback.cols, rows: 24 });
  });
});
