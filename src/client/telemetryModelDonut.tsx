/**
 * HS-8508 — Shared cost-by-model donut renderer. Extracted out of
 * `crossProjectStatsPage.tsx` (where it lived as a private
 * `renderCostByModelDonut`) so the new HS-8508 analytics-dashboard
 * telemetry section can reuse the exact same render.
 *
 * Pure: takes the row list + an optional `formatCost` formatter and
 * returns a self-contained HTMLElement.
 *
 * SVG donut via the `stroke-dasharray` slice technique — one
 * `<circle>` per slice on the same path with different dash patterns
 * + offsets layered to produce the ring. No `<path>` arc math
 * needed. Color per slice cycles `MODEL_DONUT_COLORS` modulo, sorted
 * by cost DESC so the largest slice goes first and the legend
 * mirrors the order top-down by impact.
 */

import { toElement } from './dom.js';
import { MODEL_DONUT_COLORS } from './telemetryColors.js';

export interface ModelRollupRow {
  readonly model: string;
  readonly cost: number;
  readonly tokens?: number;
  readonly promptCount?: number;
}

export interface RenderCostByModelDonutOpts {
  /** Format a cost number for legend entries. Default `$N.NN`. */
  readonly formatCost?: (n: number) => string;
}

function defaultFormatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function renderCostByModelDonut(
  rows: readonly ModelRollupRow[],
  opts: RenderCostByModelDonutOpts = {},
): HTMLElement {
  const formatCost = opts.formatCost ?? defaultFormatCost;
  const totalCost = rows.reduce((acc, r) => acc + r.cost, 0);
  const sorted = [...rows].sort((a, b) => b.cost - a.cost);

  const size = 140;
  const center = size / 2;
  const radius = 50;
  const strokeWidth = 24;
  const circumference = 2 * Math.PI * radius;

  let accumulated = 0;
  const slices = sorted.map((row, i) => {
    const fraction = totalCost === 0 ? 0 : row.cost / totalCost;
    const sliceLen = fraction * circumference;
    const dasharray = `${String(sliceLen)} ${String(circumference - sliceLen)}`;
    const dashoffset = -accumulated;
    accumulated += sliceLen;
    const color = MODEL_DONUT_COLORS[i % MODEL_DONUT_COLORS.length];
    return (
      <circle cx={String(center)} cy={String(center)} r={String(radius)} fill="none" stroke={color} stroke-width={String(strokeWidth)} stroke-dasharray={dasharray} stroke-dashoffset={String(dashoffset)} transform={`rotate(-90 ${String(center)} ${String(center)})`} />
    );
  });

  const isSingleSlice = sorted.length === 1;
  return toElement(
    <div className="telemetry-dashboard-model-donut-wrap">
      <svg className="telemetry-dashboard-model-donut" width={String(size)} height={String(size)} viewBox={`0 0 ${String(size)} ${String(size)}`} role="img" aria-label="Cost by model donut chart">
        {slices}
      </svg>
      <ul className="telemetry-dashboard-model-legend">
        {sorted.map((row, i) => {
          const fraction = totalCost === 0 ? 0 : row.cost / totalCost;
          const pct = (fraction * 100).toFixed(1);
          const color = MODEL_DONUT_COLORS[i % MODEL_DONUT_COLORS.length];
          return (
            <li className="telemetry-dashboard-model-legend-row">
              <span className="telemetry-dashboard-model-legend-swatch" style={`background:${color}`}></span>
              <span className="telemetry-dashboard-model-legend-name">{row.model}</span>
              <span className="telemetry-dashboard-model-legend-pct">{pct}%</span>
              <span className="telemetry-dashboard-model-legend-cost">{formatCost(row.cost)}</span>
            </li>
          );
        })}
      </ul>
      {isSingleSlice
        ? <p className="telemetry-dashboard-model-single-caption">100% — only one model used this window.</p>
        : null}
    </div>
  );
}
