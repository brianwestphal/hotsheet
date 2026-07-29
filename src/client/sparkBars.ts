/**
 * HS-9463 — bar geometry for the sidebar dashboard sparkline.
 *
 * Two things were wrong with the inline version this replaces, and both made the
 * widget read as "missing data" rather than as a chart:
 *
 *  1. **It was a fixed 98px wide** (7 bars × a 14px pitch) inside a sidebar that is
 *     wider than that, so the bars ended two-thirds of the way across and the rest
 *     was blank. Geometry is now computed from the viewBox width and the number of
 *     days, so the row spans the full width whatever it is — the first bar starts
 *     at 0 and the last one ends exactly at the right edge.
 *  2. **A day with no completions produced `height: 0`** — an invisible rect, i.e. a
 *     hole in the middle of the week. A gap is indistinguishable from "the chart is
 *     broken"; a flat baseline reads as "that day, nothing happened", which is the
 *     actual fact.
 *
 * `minHeight` also floors NON-empty bars, so a day with a single completion can
 * never render shorter than an empty one. Without that floor the ordering inverts
 * at the bottom of the scale (1 completed out of a max of 21 is 0.95 units, less
 * than the 1.5-unit empty baseline) and the chart would be actively misleading.
 *
 * Pure — no DOM. Exported for the unit test.
 */

export interface SparkBar {
  x: number;
  y: number;
  width: number;
  height: number;
  /** No activity that day: render as the flat gray baseline, not a value bar. */
  empty: boolean;
}

export interface SparkBarOptions {
  /** viewBox width the bars must span edge to edge. */
  viewWidth?: number;
  /** viewBox height; a full-scale bar is this tall. */
  viewHeight?: number;
  /** Gutter between bars, in viewBox units. */
  gap?: number;
  /** Floor for every bar, so an empty day is visible and a tiny day is never shorter. */
  minHeight?: number;
}

export function sparkBarGeometry(values: readonly number[], opts: SparkBarOptions = {}): SparkBar[] {
  const viewWidth = opts.viewWidth ?? 100;
  const viewHeight = opts.viewHeight ?? 20;
  const gap = opts.gap ?? 4;
  const minHeight = opts.minHeight ?? 1.5;
  const n = values.length;
  if (n === 0) return [];

  // Solve for a bar width that makes N bars + (N-1) gutters exactly fill the width.
  // Clamped at 0 so an absurd gap for the space available degenerates to touching
  // zero-width bars rather than negative ones.
  const width = Math.max(0, (viewWidth - (n - 1) * gap) / n);
  const max = Math.max(...values, 1);

  return values.map((value, i) => {
    const empty = value <= 0;
    const scaled = (value / max) * viewHeight;
    const height = empty ? minHeight : Math.max(scaled, minHeight);
    return {
      x: i * (width + gap),
      y: viewHeight - height,
      width,
      height,
      empty,
    };
  });
}
