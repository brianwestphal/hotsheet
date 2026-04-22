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
