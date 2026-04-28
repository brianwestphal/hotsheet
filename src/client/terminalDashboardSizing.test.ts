import { describe, expect, it } from 'vitest';

import {
  computeSliderSnapPoints,
  computeTileGridDims,
  computeTileScale,
  computeTileWidth,
  DASHBOARD_FALLBACK_COLS,
  DASHBOARD_FALLBACK_ROWS,
  DASHBOARD_TARGET_NATURAL_HEIGHT_PX,
  DASHBOARD_TARGET_NATURAL_WIDTH_PX,
  maybeSnapSliderValue,
  SLIDER_MIN_TILE_WIDTH,
  SLIDER_SNAP_THRESHOLD,
  TILE_ASPECT,
  TILE_GAP,
  tickLeftPx,
  tileNativeGridFromCellMetrics,
  tileWidthFromSlider,
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
 * HS-7031 — `tileWidthFromSlider` replaces the auto-fit `computeTileWidth`
 * with a user-controlled linear interpolation between the ~133 px floor and
 * the full root width. Verifies the ticket's own example: 133..1000 span,
 * slider = 50 → 567. Unit-tested so we can refactor the slider wiring
 * without breaking the math.
 */
describe('tileWidthFromSlider (HS-7031)', () => {
  it('returns the min tile width at slider = 0', () => {
    expect(tileWidthFromSlider(0, 1000)).toBe(SLIDER_MIN_TILE_WIDTH);
  });

  it('returns the root width at slider = 100', () => {
    expect(tileWidthFromSlider(100, 1000)).toBe(1000);
  });

  it('interpolates linearly at slider = 50 — matches the ticket example 133..1000 → 567', () => {
    // SLIDER_MIN_TILE_WIDTH rounds to 133 (100 px × 4/3 = 133.33...).
    // Midpoint of 133 and 1000 is 566.5, rounded → 567.
    expect(tileWidthFromSlider(50, 1000)).toBe(567);
  });

  it('clamps out-of-range slider values', () => {
    expect(tileWidthFromSlider(-10, 1000)).toBe(SLIDER_MIN_TILE_WIDTH);
    expect(tileWidthFromSlider(150, 1000)).toBe(1000);
  });

  it('survives a non-finite slider value by defaulting to 50', () => {
    // NaN and ±Infinity are both "not finite"; both route through the 50
    // midpoint fallback so a corrupted slider value never blows out the grid.
    expect(tileWidthFromSlider(Number.NaN, 1000)).toBe(567);
    expect(tileWidthFromSlider(Number.POSITIVE_INFINITY, 1000)).toBe(567);
    expect(tileWidthFromSlider(Number.NEGATIVE_INFINITY, 1000)).toBe(567);
  });

  it('returns the floor when the root width is narrower than the floor', () => {
    // A 100 px root gives no span to interpolate over — the floor wins at
    // every slider value so the tile keeps its 100 px preview height.
    expect(tileWidthFromSlider(0, 100)).toBe(SLIDER_MIN_TILE_WIDTH);
    expect(tileWidthFromSlider(50, 100)).toBe(SLIDER_MIN_TILE_WIDTH);
    expect(tileWidthFromSlider(100, 100)).toBe(SLIDER_MIN_TILE_WIDTH);
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
});

describe('computeSliderSnapPoints (HS-7271)', () => {
  it('produces a snap point for every N where tiles fit exactly with gaps', () => {
    const rootWidth = 1000;
    const points = computeSliderSnapPoints(rootWidth);
    expect(points.length).toBeGreaterThan(1);
    // Each snap point's tileWidth must satisfy N*w + (N-1)*TILE_GAP === rootWidth
    // (within 1 px rounding tolerance).
    for (const p of points) {
      const reconstructed = p.perRow * p.tileWidth + (p.perRow - 1) * TILE_GAP;
      expect(Math.abs(reconstructed - rootWidth)).toBeLessThan(1.5);
    }
  });

  it('has distinct perRow values (no duplicates after rounding)', () => {
    const points = computeSliderSnapPoints(1600);
    const counts = new Set(points.map(p => p.perRow));
    expect(counts.size).toBe(points.length);
  });

  it('is sorted ascending by slider value (fewer per row = wider tile = higher slider)', () => {
    const points = computeSliderSnapPoints(1600);
    for (let i = 1; i < points.length; i++) {
      expect(points[i].sliderValue).toBeGreaterThan(points[i - 1].sliderValue);
    }
    // Fewer-per-row snaps sit at higher slider values. Reversed order of
    // perRow because the list is sorted by sliderValue ascending.
    for (let i = 1; i < points.length; i++) {
      expect(points[i].perRow).toBeLessThan(points[i - 1].perRow);
    }
  });

  it('drops candidates whose tile width falls below the slider floor', () => {
    const points = computeSliderSnapPoints(800);
    for (const p of points) {
      expect(p.tileWidth).toBeGreaterThanOrEqual(SLIDER_MIN_TILE_WIDTH);
    }
  });

  it('returns an empty list when rootWidth cannot fit even a single tile at the floor', () => {
    expect(computeSliderSnapPoints(SLIDER_MIN_TILE_WIDTH - 1)).toEqual([]);
    expect(computeSliderSnapPoints(0)).toEqual([]);
  });

  it('includes a perRow=1 snap at 100% slider (one big tile filling the row)', () => {
    const points = computeSliderSnapPoints(1600);
    const full = points.find(p => p.perRow === 1);
    expect(full).toBeDefined();
    // perRow=1 => tileWidth = rootWidth => slider value 100.
    expect(full!.sliderValue).toBe(100);
  });
});

describe('maybeSnapSliderValue (HS-7271)', () => {
  const points = computeSliderSnapPoints(1600);

  it('snaps to the nearest snap point when raw value is within threshold', () => {
    // Pick a snap point that's isolated — its nearest neighbour is farther
    // than 2 * SLIDER_SNAP_THRESHOLD away — so the threshold probes can't be
    // misrouted to the neighbour. The perRow=1 snap sits at slider value 100
    // and is always the highest snap (followed by the perRow=2 snap some
    // tens of points below), so probes below it are safe.
    const target = points.find(p => p.perRow === 1)!;
    expect(target.sliderValue).toBe(100);
    expect(maybeSnapSliderValue(100 - (SLIDER_SNAP_THRESHOLD - 0.5), points))
      .toBe(target.sliderValue);
    // On-the-point probe is trivially a snap.
    expect(maybeSnapSliderValue(target.sliderValue, points)).toBe(target.sliderValue);
  });

  it('returns the raw value verbatim when no snap is within threshold', () => {
    // Find a gap between two adjacent snaps and pick a midpoint.
    for (let i = 1; i < points.length; i++) {
      const gap = points[i].sliderValue - points[i - 1].sliderValue;
      if (gap > SLIDER_SNAP_THRESHOLD * 4) {
        const mid = (points[i].sliderValue + points[i - 1].sliderValue) / 2;
        expect(maybeSnapSliderValue(mid, points)).toBe(mid);
        return;
      }
    }
    // At rootWidth=1600 there are plenty of adjacent snap gaps >> threshold,
    // so this loop always returns. Guard the test from a silent pass.
    throw new Error('expected at least one snap gap larger than 4 * SLIDER_SNAP_THRESHOLD');
  });

  it('picks the NEAREST snap when two are in range (shouldnt happen in practice at threshold 2.5 but guard anyway)', () => {
    const synthetic = [
      { perRow: 3, tileWidth: 400, sliderValue: 40 },
      { perRow: 2, tileWidth: 600, sliderValue: 42 },
    ];
    // Value 41.1 is closer to 42 than to 40.
    expect(maybeSnapSliderValue(41.1, synthetic)).toBe(42);
    // Value 40.5 is closer to 40.
    expect(maybeSnapSliderValue(40.5, synthetic)).toBe(40);
  });

  it('returns raw value with an empty snap list', () => {
    expect(maybeSnapSliderValue(37, [])).toBe(37);
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
