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
 * HS-7031: map a slider value (0..100) to a tile width in pixels.
 *
 * - `value = 0` → `SLIDER_MIN_TILE_WIDTH` (~133 px — the 100 px preview-height floor).
 * - `value = 100` → `rootWidth` (the full available width the dashboard can
 *   give to a single tile, i.e. `root.clientWidth - 2 * ROOT_PADDING` — the
 *   caller passes the already-padding-adjusted width).
 * - Intermediate values interpolate linearly between those two bounds, so
 *   50 → midpoint. That matches the ticket's example (`133..1000` slider
 *   mid = 567).
 *
 * If `rootWidth` is smaller than the min tile width (very narrow window),
 * the min wins — the caller then lets the dashboard horizontally scroll or
 * the tile wraps as it would at the floor.
 */
export function tileWidthFromSlider(value: number, rootWidth: number): number {
  const clampedValue = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 50));
  const max = Math.max(SLIDER_MIN_TILE_WIDTH, Math.floor(rootWidth));
  const span = max - SLIDER_MIN_TILE_WIDTH;
  return Math.round(SLIDER_MIN_TILE_WIDTH + span * (clampedValue / 100));
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

