/**
 * HS-6833: pure layout math for the terminal dashboard's global tile sizing.
 * Extracted from `terminalDashboard.tsx` so it can be unit-tested without
 * pulling in JSX / API imports.
 *
 * See docs/25-terminal-dashboard.md §25.4 for the algorithm description.
 */

export const TILE_ASPECT = 4 / 3;
export const MIN_TILE_HEIGHT = 100;
export const MAX_TILE_WIDTH = 480;
export const TILE_WIDTH_STEP = 10;
export const TILE_GAP = 12;
export const SECTION_GAP = 24;
export const LABEL_ROW_HEIGHT = 26;
export const HEADING_ROW_HEIGHT = 32;
export const ROOT_PADDING = 20;

/** HS-7031: the minimum tile width used by the size slider — same floor as
 *  `computeTileWidth` (100 px preview height at the 4:3 aspect). */
export const SLIDER_MIN_TILE_WIDTH = Math.round(MIN_TILE_HEIGHT * TILE_ASPECT);

/**
 * HS-6931 follow-up: the tile preview area is 4:3, so the xterm's natural
 * pixel size has to be 4:3 too or uniform scaling leaves dead space. 80×60
 * cells at a typical ~8×16 px monospace cell is ≈2:3 — portrait, not 4:3 —
 * so we target a 1280 × 960 natural pixel box and derive cols/rows from
 * measured cell metrics. See `computeTileGridDims` below.
 */
export const DASHBOARD_TARGET_NATURAL_WIDTH_PX = 1280;
export const DASHBOARD_TARGET_NATURAL_HEIGHT_PX = 960;
export const DASHBOARD_MIN_COLS = 20;
export const DASHBOARD_MIN_ROWS = 10;
/** Fallback when cell dims can't be measured. Matches the original 80×60
 *  grid. */
export const DASHBOARD_FALLBACK_COLS = 80;
export const DASHBOARD_FALLBACK_ROWS = 60;

export interface SizingInput {
  rootWidth: number;
  rootHeight: number;
  projectTileCounts: number[];
  hasEmptySection: boolean;
}

/**
 * Pick the largest tile width (in multiples of TILE_WIDTH_STEP) where every
 * section's tiles fit inside the available viewport height. Falls back to
 * the 100 px-preview-height floor when nothing fits; the caller allows the
 * root element to vertical-scroll in that case.
 */
export function computeTileWidth(input: SizingInput): number {
  const minWidth = Math.round(MIN_TILE_HEIGHT * TILE_ASPECT);
  const candidateMax = Math.min(MAX_TILE_WIDTH, input.rootWidth);
  const start = Math.max(minWidth, Math.floor(candidateMax / TILE_WIDTH_STEP) * TILE_WIDTH_STEP);

  for (let w = start; w >= minWidth; w -= TILE_WIDTH_STEP) {
    const h = w / TILE_ASPECT;
    const tileFullHeight = h + LABEL_ROW_HEIGHT + TILE_GAP;
    let total = 0;
    for (const count of input.projectTileCounts) {
      total += HEADING_ROW_HEIGHT;
      if (count === 0) {
        total += LABEL_ROW_HEIGHT;
      } else {
        const perRow = Math.max(1, Math.floor((input.rootWidth + TILE_GAP) / (w + TILE_GAP)));
        const rows = Math.ceil(count / perRow);
        total += rows * tileFullHeight;
      }
      total += SECTION_GAP;
    }
    if (total <= input.rootHeight) return w;
  }
  return minWidth;
}

/**
 * HS-8176 — slider value range (number of tiles per row, integer).
 * The slider's HTML `min` / `max` / `step` attributes mirror these.
 * Inverted visually via `direction: rtl` on the slider element so the
 * left edge represents `MAX_TILES_PER_ROW` (smallest tiles, most per
 * row) and the right edge represents `MIN_TILES_PER_ROW` (one big tile
 * filling the row). Default chosen to roughly match the pre-HS-8176
 * 33% slider position on a typical viewport.
 */
export const MIN_TILES_PER_ROW = 1;
export const MAX_TILES_PER_ROW = 10;
export const DEFAULT_TILES_PER_ROW = 4;

/**
 * HS-8176 — map an integer "tiles per row" value to a tile width in
 * pixels. Replaces the pre-HS-8176 continuous `tileWidthFromSlider`
 * (0..100 float). Math:
 *
 *     tileWidth = (rootWidth - (perRow - 1) * TILE_GAP) / perRow
 *
 * For perRow=1 the tile fills the row (modulo TILE_GAP not being
 * subtracted — there are no gaps when only one tile exists). For
 * perRow=10 the tiles are a tenth of the row width minus 9 gaps —
 * intentionally allowed to fall below `SLIDER_MIN_TILE_WIDTH` because
 * the user explicitly asked for 10 columns; legibility at very narrow
 * widths is their call. The caller's `applySizing` clamps to a small
 * positive minimum to avoid CSS `width: 0` breaking xterm's layout.
 *
 * `perRow` is clamped to `[MIN_TILES_PER_ROW, MAX_TILES_PER_ROW]` and
 * floored to the nearest integer so a stale legacy float value (e.g.
 * the pre-HS-8176 33) doesn't produce a fractional column count — the
 * caller's persistence-load helper additionally migrates out-of-range
 * values to `DEFAULT_TILES_PER_ROW`.
 */
export function tileWidthFromColumnCount(perRow: number, rootWidth: number): number {
  const clamped = Math.max(MIN_TILES_PER_ROW, Math.min(MAX_TILES_PER_ROW, Math.floor(Number.isFinite(perRow) ? perRow : DEFAULT_TILES_PER_ROW)));
  const totalGap = (clamped - 1) * TILE_GAP;
  const width = (Math.max(0, rootWidth) - totalGap) / clamped;
  return Math.max(1, Math.floor(width));
}

/**
 * HS-8176 — back-compat helper for any caller that hasn't migrated
 * yet. Treats a legacy 0..100 slider value as a column count by
 * reverse-mapping linearly: 0 → MIN_TILES_PER_ROW, 100 →
 * MAX_TILES_PER_ROW. Migration helper, not the long-term API — once
 * every consumer is converted this can be deleted along with the
 * legacy `dashboard_slider_value` migration.
 */
export function legacySliderValueToColumnCount(legacyValue: number): number {
  if (!Number.isFinite(legacyValue)) return DEFAULT_TILES_PER_ROW;
  if (legacyValue >= MIN_TILES_PER_ROW && legacyValue <= MAX_TILES_PER_ROW && Number.isInteger(legacyValue)) {
    // Already in the new range — pass through.
    return legacyValue;
  }
  // Old continuous 0..100 value — map roughly so the user's tiles
  // don't dramatically change size on first load after the migration.
  const clampedLegacy = Math.max(0, Math.min(100, legacyValue));
  // Old default 33 ≈ "a few big tiles". Map that to perRow=4. Old 0 →
  // 1 tile (biggest), old 100 → 10 tiles (smallest). Linear.
  const perRow = Math.round(MIN_TILES_PER_ROW + (clampedLegacy / 100) * (MAX_TILES_PER_ROW - MIN_TILES_PER_ROW));
  return Math.max(MIN_TILES_PER_ROW, Math.min(MAX_TILES_PER_ROW, perRow));
}


export interface SnapPoint {
  /** Tile count that fits perfectly across one row at this width (accounting for TILE_GAP). */
  perRow: number;
  /** The exact tile width (px) that makes `perRow` tiles fill the row. */
  tileWidth: number;
  /** Slider value (post-HS-8176 — integer 1..10 in slider-LTR space, the
   *  inverse of `perRow` per `perRowToSliderPosition`). */
  sliderValue: number;
}

/**
 * HS-8176 — convert a `perRow` column count to its slider-LTR position.
 * The slider element is LTR with min=`MIN_TILES_PER_ROW` (1) on the
 * visual left and max=`MAX_TILES_PER_ROW` (10) on the visual right,
 * but the user's mental model per the HS-8176 spec is *"left = many
 * small tiles, right = one big tile"* — so the slider's visual
 * position is the inverse of the column count. Pure helper.
 */
export function perRowToSliderPosition(perRow: number): number {
  const clamped = Math.max(MIN_TILES_PER_ROW, Math.min(MAX_TILES_PER_ROW, Math.round(perRow)));
  return MIN_TILES_PER_ROW + MAX_TILES_PER_ROW - clamped;
}

/** HS-8176 — inverse of `perRowToSliderPosition`. */
export function sliderPositionToPerRow(sliderPosition: number): number {
  const clamped = Math.max(MIN_TILES_PER_ROW, Math.min(MAX_TILES_PER_ROW, Math.round(sliderPosition)));
  return MIN_TILES_PER_ROW + MAX_TILES_PER_ROW - clamped;
}

/**
 * HS-8176 — fixed snap points: one tick per integer column count from
 * `MIN_TILES_PER_ROW` to `MAX_TILES_PER_ROW`. Pre-HS-8176 ticks were
 * computed dynamically based on `rootWidth` (positions where an
 * integer number of tiles fit exactly), but the new integer-only
 * slider has the same set of positions for every viewport — every
 * value is a snap point. The `tileWidth` field is computed for the
 * given `rootWidth` so callers can render tooltips like *"5 columns
 * (~240 px / tile)"* without recomputing.
 */
export function computeColumnSnapPoints(rootWidth: number): SnapPoint[] {
  const points: SnapPoint[] = [];
  for (let perRow = MIN_TILES_PER_ROW; perRow <= MAX_TILES_PER_ROW; perRow += 1) {
    points.push({
      perRow,
      tileWidth: tileWidthFromColumnCount(perRow, rootWidth),
      sliderValue: perRowToSliderPosition(perRow),
    });
  }
  return points;
}


/**
 * HS-7950 — pixel offset of a snap-point tick relative to the slider's left
 * edge, accounting for the fact that the native `input[type="range"]` thumb
 * occupies a fixed `thumbWidthPx` regardless of `value`. Without this
 * compensation, a tick rendered at `left: 0%` sits under the slider's
 * geometric edge while the thumb's *center* at `value=0` sits half a thumb
 * inwards — and the misalignment grows toward both ends of the track,
 * making the leftmost ticks bunch under non-existent thumb positions and
 * the rightmost ticks fall off into empty rail.
 *
 * Effective travel range of the thumb centre is
 * `[thumbWidthPx/2, sliderWidthPx - thumbWidthPx/2]`. The tick at
 * `sliderValue=v` (0..100) lands at:
 *
 *     leftPx = thumbWidthPx/2 + (v/100) * (sliderWidthPx - thumbWidthPx)
 *
 * Pure helper so the production wire-up + tests can both call it with the
 * exact same numbers — alignment is a fiddly mental model and an empirical
 * regression is easy to introduce.
 */
export function tickLeftPx(sliderValue: number, sliderWidthPx: number, thumbWidthPx: number): number {
  const v = Math.max(0, Math.min(100, sliderValue));
  const usable = Math.max(0, sliderWidthPx - thumbWidthPx);
  return thumbWidthPx / 2 + (v / 100) * usable;
}


export interface TileScale {
  /** Uniform scale factor applied via `transform: scale(scale)`. X and Y share
   *  the same factor so text keeps its natural metrics — a two-axis scale
   *  stretches cells anisotropically and makes the tile look distorted
   *  (HS-6931). */
  scale: number;
  /** Explicit width to set on the xterm root — the xterm's natural pixel
   *  width at its pinned 80 × 60 grid. Without an explicit width xterm's
   *  absolutely-positioned viewport / canvas layers collapse (HS-6865). */
  width: number;
  /** Explicit height to set on the xterm root — same reasoning as width. */
  height: number;
  /** HS-6997: CSS `left` offset that centers the scaled xterm horizontally
   *  within the tile preview area. Zero when the scaled width equals the
   *  tile width (common landscape-PTY case — horizontal is the tight axis). */
  left: number;
  /** HS-6997: CSS `top` offset. Always zero — the scaled xterm is top-
   *  aligned inside the tile so content reads from the top like a real
   *  macOS Terminal pane, with any vertical dead space falling below the
   *  content rather than sandwiching it top-and-bottom. Since the tile
   *  preview background matches xterm's theme background (both `--bg`, per
   *  HS-6866), the dead space is visually indistinguishable from empty
   *  terminal rows — the tile reads as a live terminal whose content
   *  hasn't filled the widget yet. */
  top: number;
}

/**
 * HS-6865 + HS-6931: pick a uniform scale factor + explicit pixel dims for a
 * dashboard tile's xterm root. The caller places the element at the tile's
 * top-left and centers the scaled box within `tileWidth × tileHeight`.
 *
 * Since HS-6931 follow-up the tile's xterm is sized (via `computeTileGridDims`)
 * so natural aspect ≈ 4:3, which matches the tile. Uniform fit-inside then
 * fills the tile with negligible dead space. Uniform scale — rather than
 * two-axis — was still the right call: font hinting + cell metrics are
 * never exactly uniform across platforms, so the xterm's measured natural
 * may be a few pixels off 4:3. Uniform scaling handles that by leaving a
 * tiny letterbox rather than stretching cells.
 */
export function computeTileScale(
  tileWidth: number,
  tileHeight: number,
  naturalWidth: number,
  naturalHeight: number,
): TileScale | null {
  if (naturalWidth <= 0 || naturalHeight <= 0) return null;
  if (tileWidth <= 0 || tileHeight <= 0) return null;
  const scale = Math.min(tileWidth / naturalWidth, tileHeight / naturalHeight);
  const scaledWidth = naturalWidth * scale;
  return {
    scale,
    width: naturalWidth,
    height: naturalHeight,
    // HS-6997: horizontally centered letterbox, top-aligned vertically. See
    // the TileScale `top` JSDoc for why the vertical axis is pinned to 0.
    left: Math.max(0, (tileWidth - scaledWidth) / 2),
    top: 0,
  };
}

export interface TileGridDims {
  cols: number;
  rows: number;
}

/**
 * HS-7097 follow-up: pick tile-native 4:3 cols × rows from measured cell
 * metrics. Used by the dashboard's grid tiles after `replayHistoryToTerm`
 * has replayed the PTY's scrollback at the PTY's own dims — the tile then
 * resizes its xterm down to these tile-native dims so the natural pixel
 * aspect matches the 4:3 preview frame.
 *
 * The earlier HS-6965 policy (`tileTargetFromHistory`) returned the PTY's
 * cols × rows verbatim. That guaranteed byte-perfect wrapping of live bytes
 * but also meant wide drawer-attached PTYs (typical 235 × 41 ≈ 5.7:1) left
 * most of the 4:3 tile's vertical space empty — the "full-screen view and
 * grid tile use the same dims" symptom the user flagged. The trade-off
 * accepted here: live bytes broadcast at the PTY's cols now wrap inside the
 * tile's narrower xterm buffer, but the tile visually fills its 4:3 frame
 * and reads as an aspect-correct preview.
 *
 * Thin wrapper around `computeTileGridDims` so call-sites read clearly.
 */
export function tileNativeGridFromCellMetrics(
  cellWidth: number,
  cellHeight: number,
): TileGridDims {
  return computeTileGridDims(cellWidth, cellHeight);
}

/**
 * HS-6931 follow-up: given measured cell metrics, pick cols × rows so the
 * xterm's natural pixel size approximates the 4:3 target (1280 × 960). The
 * tile's 4:3 preview frame then matches the terminal's natural aspect and
 * uniform scaling fills the tile without letterboxing or stretching.
 *
 * Math: cellWidth ≈ 8, cellHeight ≈ 16 on macOS at 13px `ui-monospace`, so
 * this picks ~160 × 60. Exotic fonts or DPI configurations just produce a
 * different cols×rows that still lands on 1280×960 ±1 cell.
 *
 * Falls back to the original 80 × 60 when cell metrics can't be read.
 */
export function computeTileGridDims(
  cellWidth: number,
  cellHeight: number,
  targetWidth: number = DASHBOARD_TARGET_NATURAL_WIDTH_PX,
  targetHeight: number = DASHBOARD_TARGET_NATURAL_HEIGHT_PX,
): TileGridDims {
  if (cellWidth <= 0 || cellHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return { cols: DASHBOARD_FALLBACK_COLS, rows: DASHBOARD_FALLBACK_ROWS };
  }
  const cols = Math.max(DASHBOARD_MIN_COLS, Math.round(targetWidth / cellWidth));
  const rows = Math.max(DASHBOARD_MIN_ROWS, Math.round(targetHeight / cellHeight));
  return { cols, rows };
}

