/**
 * HS-8506 (HS-8503 Phase 2) — Shared cost-over-time chart component used
 * by the cross-project telemetry page (HS-8507) AND the per-project
 * analytics-dashboard telemetry sub-region (HS-8508). Spec lives in
 * `docs/69-telemetry-dashboard.md` §69.10.4. HS-8518 — non-stacked
 * mode rewritten as a per-project line chart (the original "By
 * project" overlapping-bars overlay was unreadable when project
 * stacks overlapped, since the translucent fills blended into
 * colors that didn't match the legend swatches).
 *
 * Pure render — no fetching. The caller hands over the densified
 * `CostOverTimePoint[]` returned by `getCostOverTime` from HS-8505
 * (one entry per (date, projectSecret, model) tuple, all with the
 * same set of dates because the backend densifies zero rows for every
 * tuple that has data on at least one day in the window).
 *
 * Inline SVG (no chart library dep, matching the §67.10.5 histogram +
 * §69.3.4 heatmap precedent). Width fills the container via viewBox +
 * `preserveAspectRatio="none"`; height is configurable with a sensible
 * default.
 *
 * Two render modes:
 *
 * - **Stacked** (default). All (project, model) bands fully stacked.
 *   Total column height on day D = total cross-project cost on D.
 *   Bands ordered by project (alpha) then model (alpha) so the
 *   visual order is stable across re-renders.
 *
 * - **Lines.** One polyline per project (per-day costs summed
 *   across models), drawn with the project's base color from the
 *   shared palette. Trades model-level detail for clear
 *   project-trend comparison.
 *
 * Toggle UI is a single "Stacked" button — `is-active` when stacked
 * is on (default), inactive when the lines mode is showing. The
 * toggle is hidden entirely when only one project is present in
 * the data (both modes render the same trend and the toggle chrome
 * would be noise).
 *
 * Theming: per-project palette uses `MODEL_DONUT_COLORS` from
 * `telemetryColors.ts`; within each project, models are
 * distinguished by an opacity step (`1 - 0.18 * modelIdx`, clamped
 * at `0.46`) so the same project family stays visually coherent.
 * Lines mode uses the project's base color at full opacity for
 * direct legend correlation.
 *
 * Hover tooltips: each stacked band carries a `<title>` element with
 * `{date} — {projectLabel} / {model}: {cost}`. Lines mode renders
 * a per-data-point `<circle>` with its own `<title>` for daily-cost
 * readability. Pure SVG-native; works in every browser without JS
 * event handlers.
 */

import { toElement } from './dom.js';
import { MODEL_DONUT_COLORS } from './telemetryColors.js';
// HS-8566 — default delegates to the shared formatter so the Y-axis ticks
// + tooltips inherit the >= $1000 no-cents rule.
import { formatCost as defaultFormatCost } from './telemetryFormat.js';

/**
 * Densified daily cost point. Matches the server-side
 * `CostOverTimePoint` shape returned by
 * `src/db/otelQueries.ts::getCostOverTime` (HS-8505). Redeclared
 * locally so the client doesn't reach across the wire-boundary
 * import line — the codebase convention is to redeclare wire shapes
 * per module (see `DashboardPayload` in `telemetryDashboard.tsx`).
 */
export interface CostOverTimePoint {
  readonly date: string;
  readonly projectSecret: string;
  readonly model: string;
  readonly cost: number;
}

export type CostOverTimeChartMode = 'stacked' | 'lines';

export interface RenderCostOverTimeChartOpts {
  /** `'stacked'` (default) or `'lines'`. Ignored when the data has at
   *  most one project — toggle hidden. */
  readonly mode?: CostOverTimeChartMode;
  /** Chart-area height in CSS pixels. Default 220. Width is
   *  responsive (viewBox-driven). */
  readonly height?: number;
  /** Resolve a project secret to a human label for tooltips + legend.
   *  Default: the secret's first 8 characters. */
  readonly resolveProjectLabel?: (secret: string) => string;
  /** Format a cost number for tooltips + axis ticks. Default: USD
   *  with 2 decimals (`$0.42`). */
  readonly formatCost?: (n: number) => string;
  /** HS-8810 — local-calendar days (YYYY-MM-DD) that had ≥1 ingested metric
   *  point. A charted day NOT in this set is shaded as "no telemetry captured"
   *  (the OTLP receiver wasn't running / Claude ran outside Hot Sheet) to set it
   *  apart from a genuine $0 day. Omit (undefined) to disable the shading
   *  entirely — prior behavior. */
  readonly ingestedDates?: readonly string[];
}

const DEFAULT_HEIGHT = 220;
const MARGIN_LEFT = 56;
const MARGIN_RIGHT = 16;
const MARGIN_TOP = 12;
const MARGIN_BOTTOM = 28;
const Y_TICK_COUNT = 4;
const LINE_STROKE_WIDTH = 2;
const LINE_POINT_RADIUS = 3;
const EMPTY_MESSAGE = 'No cost data in this window.';


function defaultResolveProjectLabel(secret: string): string {
  return secret.length > 8 ? secret.slice(0, 8) : secret;
}

/** Distinct projects in `points`, sorted by secret so the visual
 *  order is stable across re-renders. */
function uniqueProjectSecrets(points: readonly CostOverTimePoint[]): string[] {
  const set = new Set<string>();
  for (const p of points) set.add(p.projectSecret);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Distinct (project, model) tuples in `points`, sorted by project
 *  then model. */
function uniqueProjectModelTuples(points: readonly CostOverTimePoint[]): Array<{ projectSecret: string; model: string }> {
  const map = new Map<string, { projectSecret: string; model: string }>();
  for (const p of points) {
    const key = `${p.projectSecret} ${p.model}`;
    if (!map.has(key)) map.set(key, { projectSecret: p.projectSecret, model: p.model });
  }
  return [...map.values()].sort((a, b) => {
    const cmp = a.projectSecret.localeCompare(b.projectSecret);
    return cmp !== 0 ? cmp : a.model.localeCompare(b.model);
  });
}

/** Distinct dates in `points`, sorted ascending lexicographically
 *  (safe because the wire format is `YYYY-MM-DD`). */
function uniqueDates(points: readonly CostOverTimePoint[]): string[] {
  const set = new Set<string>();
  for (const p of points) set.add(p.date);
  return [...set].sort();
}

/** Models within a project, sorted alpha — used to assign the
 *  model-opacity step deterministically per project. */
function modelsForProject(
  tuples: readonly { projectSecret: string; model: string }[],
  projectSecret: string,
): string[] {
  return tuples
    .filter(t => t.projectSecret === projectSecret)
    .map(t => t.model);
}

/** Per-(project, model) cost lookup keyed by `date secret model`.
 *  The ` ` separator avoids the delimiter-collision class that
 *  HS-8505's densifier already guards against on the backend side. */
function buildCostLookup(points: readonly CostOverTimePoint[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of points) m.set(`${p.date} ${p.projectSecret} ${p.model}`, p.cost);
  return m;
}

/** Color resolver shared by both modes: project base color from
 *  `MODEL_DONUT_COLORS` (cycled), model differentiated by opacity
 *  step within that project. */
function bandFill(projectIdx: number, modelIdxWithinProject: number): { color: string; opacity: number } {
  const color = MODEL_DONUT_COLORS[projectIdx % MODEL_DONUT_COLORS.length];
  const opacity = Math.max(0.46, 1 - 0.18 * modelIdxWithinProject);
  return { color, opacity };
}

/** Format a `YYYY-MM-DD` date string as `MMM D` (e.g. `May 21`) for
 *  the x-axis tick labels. Pure string parse — no Date object so DST
 *  + timezone don't intrude. */
function formatDateLabel(dateStr: string): string {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const monthIdx = Number.parseInt(parts[1], 10) - 1;
  const day = Number.parseInt(parts[2], 10);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthName = monthNames[monthIdx] ?? '';
  if (monthName === '' || Number.isNaN(day)) return dateStr;
  return `${monthName} ${String(day)}`;
}

/** Compute a sensible step for x-axis labels so the labels don't
 *  overlap. Up to 8 visible labels across the axis. */
function xAxisLabelStep(dateCount: number): number {
  return Math.max(1, Math.ceil(dateCount / 8));
}

/** Round `max` up to a "nice" axis bound — the next multiple of an
 *  even power of 10 / 5 / 2 step. Falls back to `max` itself when
 *  `max <= 0`. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.floor(Math.log10(max));
  const pow = 10 ** exp;
  const norm = max / pow;
  let nice;
  if (norm <= 1) nice = 1;
  else if (norm <= 2) nice = 2;
  else if (norm <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

interface StackBand {
  readonly date: string;
  readonly projectSecret: string;
  readonly model: string;
  readonly cost: number;
  readonly cumulativeBelow: number; // For y-stack
  readonly projectIdx: number;
  readonly modelIdxWithinProject: number;
}

/** Build stacked-mode bands: one entry per (date × project × model),
 *  with `cumulativeBelow` = sum of every band below it in the same
 *  date column. */
function buildStackedBands(
  dates: readonly string[],
  tuples: readonly { projectSecret: string; model: string }[],
  projectIdxOf: Map<string, number>,
  modelIdxOf: Map<string, number>,
  costLookup: Map<string, number>,
): { bands: StackBand[]; maxStackTotal: number } {
  const bands: StackBand[] = [];
  let maxStackTotal = 0;
  for (const date of dates) {
    let cumul = 0;
    for (const t of tuples) {
      const cost = costLookup.get(`${date} ${t.projectSecret} ${t.model}`) ?? 0;
      if (cost > 0) {
        bands.push({
          date,
          projectSecret: t.projectSecret,
          model: t.model,
          cost,
          cumulativeBelow: cumul,
          projectIdx: projectIdxOf.get(t.projectSecret) ?? 0,
          modelIdxWithinProject: modelIdxOf.get(`${t.projectSecret} ${t.model}`) ?? 0,
        });
      }
      cumul += cost;
    }
    if (cumul > maxStackTotal) maxStackTotal = cumul;
  }
  return { bands, maxStackTotal };
}

interface ProjectSeries {
  readonly projectSecret: string;
  /** One entry per date in the shared dates axis (same length + order
   *  as the `dates` array the caller threads in). */
  readonly dailyCosts: readonly number[];
}

/** Build per-project daily totals for the lines render. Returns one
 *  series per project, each holding the per-date cost summed across
 *  models. `maxDailyTotal` is the largest single-day per-project
 *  total — the y-axis bound for the lines mode. */
function buildProjectDailyTotals(
  dates: readonly string[],
  projectSecrets: readonly string[],
  tuples: readonly { projectSecret: string; model: string }[],
  costLookup: Map<string, number>,
): { series: ProjectSeries[]; maxDailyTotal: number } {
  const series: ProjectSeries[] = [];
  let maxDailyTotal = 0;
  for (const secret of projectSecrets) {
    const modelsForThis = tuples.filter(t => t.projectSecret === secret);
    const dailyCosts: number[] = [];
    for (const date of dates) {
      let total = 0;
      for (const t of modelsForThis) {
        total += costLookup.get(`${date} ${t.projectSecret} ${t.model}`) ?? 0;
      }
      dailyCosts.push(total);
      if (total > maxDailyTotal) maxDailyTotal = total;
    }
    series.push({ projectSecret: secret, dailyCosts });
  }
  return { series, maxDailyTotal };
}

/** Render the y-axis (gridlines + tick labels) into a parent `<g>`.
 *  Shared between stacked + lines modes. */
function renderYAxis(opts: {
  parent: HTMLElement;
  chartLeft: number;
  chartTop: number;
  chartWidth: number;
  chartHeight: number;
  yMax: number;
  formatCost: (n: number) => string;
}): void {
  const { parent, chartLeft, chartTop, chartWidth, chartHeight, yMax, formatCost } = opts;
  const niceMaxVal = niceMax(yMax);
  const drawableYMax = Math.max(yMax, 1e-9);
  const yScale = (cost: number): number => (cost / drawableYMax) * chartHeight;
  const yAxis = toElement(<g className="telemetry-cost-over-time-yaxis"></g>);
  for (let i = 0; i <= Y_TICK_COUNT; i++) {
    const tickVal = (niceMaxVal * i) / Y_TICK_COUNT;
    const yPx = chartTop + chartHeight - yScale(tickVal);
    yAxis.appendChild(toElement(
      <line
        x1={String(chartLeft)} y1={String(yPx)}
        x2={String(chartLeft + chartWidth)} y2={String(yPx)}
        className="telemetry-cost-over-time-gridline"
      ></line>
    ));
    yAxis.appendChild(toElement(
      <text
        x={String(chartLeft - 6)} y={String(yPx + 4)}
        className="telemetry-cost-over-time-ytick"
        text-anchor="end"
      >{formatCost(tickVal)}</text>
    ));
  }
  parent.appendChild(yAxis);
}

/** Render the x-axis (date tick labels) into a parent `<g>`. Shared
 *  between stacked + lines modes. */
function renderXAxis(opts: {
  parent: HTMLElement;
  chartLeft: number;
  chartTop: number;
  chartHeight: number;
  colWidth: number;
  dates: readonly string[];
}): void {
  const { parent, chartLeft, chartTop, chartHeight, colWidth, dates } = opts;
  const dateCount = dates.length;
  const xStep = xAxisLabelStep(dateCount);
  const xAxis = toElement(<g className="telemetry-cost-over-time-xaxis"></g>);
  for (let i = 0; i < dateCount; i++) {
    if (i % xStep !== 0) continue;
    const date = dates[i];
    const xPx = chartLeft + i * colWidth + colWidth / 2;
    xAxis.appendChild(toElement(
      <text
        x={String(xPx)} y={String(chartTop + chartHeight + 16)}
        className="telemetry-cost-over-time-xtick"
        text-anchor="middle"
      >{formatDateLabel(date)}</text>
    ));
  }
  parent.appendChild(xAxis);
}

/** Render the SVG chart body for stacked-bar mode. Returns a `<g>`
 *  group that the outer `<svg>` slots in. */
function renderStackedBody(opts: {
  width: number;
  height: number;
  dates: readonly string[];
  bands: readonly StackBand[];
  yMax: number;
  formatCost: (n: number) => string;
  resolveProjectLabel: (secret: string) => string;
}): HTMLElement {
  const { width, height, dates, bands, yMax, formatCost, resolveProjectLabel } = opts;

  const chartLeft = MARGIN_LEFT;
  const chartTop = MARGIN_TOP;
  const chartWidth = Math.max(0, width - MARGIN_LEFT - MARGIN_RIGHT);
  const chartHeight = Math.max(0, height - MARGIN_TOP - MARGIN_BOTTOM);

  const dateCount = dates.length;
  const colWidth = dateCount > 0 ? chartWidth / dateCount : 0;
  const bandPad = colWidth > 4 ? 1 : 0;
  const drawableYMax = Math.max(yMax, 1e-9);
  const yScale = (cost: number): number => (cost / drawableYMax) * chartHeight;

  const g = toElement(<g className="telemetry-cost-over-time-chart-body" data-render-mode="stacked"></g>);

  renderYAxis({ parent: g, chartLeft, chartTop, chartWidth, chartHeight, yMax, formatCost });

  const bandsG = toElement(<g className="telemetry-cost-over-time-bands"></g>);
  for (const b of bands) {
    const colIdx = dates.indexOf(b.date);
    if (colIdx < 0) continue;
    const xPx = chartLeft + colIdx * colWidth + bandPad / 2;
    const wPx = Math.max(0, colWidth - bandPad);
    const yBottom = chartTop + chartHeight - yScale(b.cumulativeBelow);
    const yTop = chartTop + chartHeight - yScale(b.cumulativeBelow + b.cost);
    const hPx = Math.max(0, yBottom - yTop);
    const { color, opacity } = bandFill(b.projectIdx, b.modelIdxWithinProject);
    const tooltip = `${b.date} — ${resolveProjectLabel(b.projectSecret)} / ${b.model}: ${formatCost(b.cost)}`;
    const rect = toElement(
      <rect
        x={String(xPx)} y={String(yTop)}
        width={String(wPx)} height={String(hPx)}
        fill={color}
        fill-opacity={String(opacity)}
        className="telemetry-cost-over-time-band"
        data-project-secret={b.projectSecret}
        data-model={b.model}
        data-date={b.date}
      ></rect>
    );
    rect.appendChild(toElement(<title>{tooltip}</title>));
    bandsG.appendChild(rect);
  }
  g.appendChild(bandsG);

  renderXAxis({ parent: g, chartLeft, chartTop, chartHeight, colWidth, dates });

  return g;
}

/** Render the SVG chart body for lines mode (one polyline per
 *  project, models summed). Returns a `<g>` group that the outer
 *  `<svg>` slots in. */
function renderLinesBody(opts: {
  width: number;
  height: number;
  dates: readonly string[];
  series: readonly ProjectSeries[];
  yMax: number;
  projectIdxOf: Map<string, number>;
  formatCost: (n: number) => string;
  resolveProjectLabel: (secret: string) => string;
}): HTMLElement {
  const { width, height, dates, series, yMax, projectIdxOf, formatCost, resolveProjectLabel } = opts;

  const chartLeft = MARGIN_LEFT;
  const chartTop = MARGIN_TOP;
  const chartWidth = Math.max(0, width - MARGIN_LEFT - MARGIN_RIGHT);
  const chartHeight = Math.max(0, height - MARGIN_TOP - MARGIN_BOTTOM);

  const dateCount = dates.length;
  const colWidth = dateCount > 0 ? chartWidth / dateCount : 0;
  const drawableYMax = Math.max(yMax, 1e-9);
  const yScale = (cost: number): number => (cost / drawableYMax) * chartHeight;
  // Each daily x position is the center of the date's "column" so
  // points align with the stacked-mode bars when the user toggles.
  const xFor = (idx: number): number => chartLeft + idx * colWidth + colWidth / 2;

  const g = toElement(<g className="telemetry-cost-over-time-chart-body" data-render-mode="lines"></g>);

  renderYAxis({ parent: g, chartLeft, chartTop, chartWidth, chartHeight, yMax, formatCost });

  const linesG = toElement(<g className="telemetry-cost-over-time-lines"></g>);
  for (const s of series) {
    const projectIdx = projectIdxOf.get(s.projectSecret) ?? 0;
    const color = MODEL_DONUT_COLORS[projectIdx % MODEL_DONUT_COLORS.length];
    const projectLabel = resolveProjectLabel(s.projectSecret);

    // Polyline: connect every day's point. Days with cost === 0
    // are kept (the line dips to baseline) so gaps in activity are
    // visible rather than silently bridged.
    const pointsAttr = s.dailyCosts
      .map((cost, i) => `${String(xFor(i))},${String(chartTop + chartHeight - yScale(cost))}`)
      .join(' ');
    const line = toElement(
      <polyline
        points={pointsAttr}
        fill="none"
        stroke={color}
        stroke-width={String(LINE_STROKE_WIDTH)}
        stroke-linejoin="round"
        stroke-linecap="round"
        className="telemetry-cost-over-time-line"
        data-project-secret={s.projectSecret}
      ></polyline>
    );
    linesG.appendChild(line);

    // Per-day point markers (so hover tooltips can attach + the
    // single-day-of-data case still shows a visible dot rather than
    // an invisible single-point polyline). Only emit a circle on
    // days with cost > 0 to keep the chart legible when most days
    // are zero.
    for (let i = 0; i < s.dailyCosts.length; i++) {
      const cost = s.dailyCosts[i];
      if (cost <= 0) continue;
      const cx = xFor(i);
      const cy = chartTop + chartHeight - yScale(cost);
      const tooltip = `${dates[i]} — ${projectLabel}: ${formatCost(cost)}`;
      const dot = toElement(
        <circle
          cx={String(cx)} cy={String(cy)}
          r={String(LINE_POINT_RADIUS)}
          fill={color}
          className="telemetry-cost-over-time-line-point"
          data-project-secret={s.projectSecret}
          data-date={dates[i]}
        ></circle>
      );
      dot.appendChild(toElement(<title>{tooltip}</title>));
      linesG.appendChild(dot);
    }
  }
  g.appendChild(linesG);

  renderXAxis({ parent: g, chartLeft, chartTop, chartHeight, colWidth, dates });

  return g;
}

/** Build the legend block: one row per project, with a per-project
 *  color swatch + label + nested model rows underneath. */
function renderLegend(opts: {
  projectSecrets: readonly string[];
  tuples: readonly { projectSecret: string; model: string }[];
  projectIdxOf: Map<string, number>;
  modelIdxOf: Map<string, number>;
  resolveProjectLabel: (secret: string) => string;
}): HTMLElement {
  const { projectSecrets, tuples, projectIdxOf, modelIdxOf, resolveProjectLabel } = opts;
  const wrap = toElement(<div className="telemetry-cost-over-time-legend"></div>);
  for (const secret of projectSecrets) {
    const projectIdx = projectIdxOf.get(secret) ?? 0;
    const projectColor = MODEL_DONUT_COLORS[projectIdx % MODEL_DONUT_COLORS.length];
    const models = tuples.filter(t => t.projectSecret === secret).map(t => t.model);

    const block = toElement(<div className="telemetry-cost-over-time-legend-project"></div>);
    block.appendChild(toElement(
      <div className="telemetry-cost-over-time-legend-project-row">
        <span
          className="telemetry-cost-over-time-legend-swatch"
          style={`background-color: ${projectColor};`}
        ></span>
        <span className="telemetry-cost-over-time-legend-project-name">{resolveProjectLabel(secret)}</span>
      </div>
    ));
    for (const model of models) {
      const modelIdx = modelIdxOf.get(`${secret} ${model}`) ?? 0;
      const { opacity } = bandFill(projectIdx, modelIdx);
      block.appendChild(toElement(
        <div className="telemetry-cost-over-time-legend-model-row">
          <span
            className="telemetry-cost-over-time-legend-swatch is-model"
            style={`background-color: ${projectColor}; opacity: ${String(opacity)};`}
          ></span>
          <span className="telemetry-cost-over-time-legend-model-name">{model}</span>
        </div>
      ));
    }
    wrap.appendChild(block);
  }
  return wrap;
}

/**
 * Render the cost-over-time chart for the supplied `points`.
 *
 * Returns a self-contained `HTMLElement` ready to append into the
 * caller's section. The element exposes a `data-mode` attribute so
 * tests + downstream consumers can introspect the current render
 * mode without re-running mode detection.
 *
 * The mode toggle is hidden when there's only one project in the
 * data. When toggled, the chart body is re-rendered in place; the
 * toggle button survives the re-render to avoid focus thrash.
 */
/** HS-8810 — the tooltip suffix appended to a no-telemetry day. */
const NO_TELEMETRY_NOTE = 'no telemetry captured';

/**
 * HS-8810 — derive the set of charted dates that had NO ingested telemetry.
 * Returns an empty set when `ingestedDates` is undefined (shading disabled).
 * A no-telemetry day is necessarily $0 (no points → no cost), so this is the
 * sole signal needed to tell it apart from a real $0 day.
 */
function computeNoTelemetryDates(
  dates: readonly string[],
  ingestedDates: readonly string[] | undefined,
): Set<string> {
  if (ingestedDates === undefined) return new Set();
  const ingested = new Set(ingestedDates);
  return new Set(dates.filter(d => !ingested.has(d)));
}

/**
 * HS-8810 — a faint full-height band behind each no-telemetry date column, so
 * the gap reads differently from a $0 day at a glance (mode-independent: drawn
 * once behind both the stacked bars and the lines). Returns null when there's
 * nothing to shade.
 */
function renderNoTelemetryBands(
  dates: readonly string[],
  noTelemetry: Set<string>,
  width: number,
  height: number,
): HTMLElement | null {
  if (noTelemetry.size === 0 || dates.length === 0) return null;
  const chartLeft = MARGIN_LEFT;
  const chartTop = MARGIN_TOP;
  const chartWidth = Math.max(0, width - MARGIN_LEFT - MARGIN_RIGHT);
  const chartHeight = Math.max(0, height - MARGIN_TOP - MARGIN_BOTTOM);
  const colWidth = chartWidth / dates.length;
  const g = toElement(<g className="telemetry-cost-over-time-no-telemetry"></g>);
  dates.forEach((date, idx) => {
    if (!noTelemetry.has(date)) return;
    const rect = toElement(
      <rect
        className="telemetry-cost-over-time-no-telemetry-band"
        x={String(chartLeft + idx * colWidth)}
        y={String(chartTop)}
        width={String(colWidth)}
        height={String(chartHeight)}
      ></rect>
    );
    rect.appendChild(toElement(<title>{`${date} — ${NO_TELEMETRY_NOTE}`}</title>));
    g.appendChild(rect);
  });
  return g;
}

export function renderCostOverTimeChart(
  points: readonly CostOverTimePoint[],
  opts: RenderCostOverTimeChartOpts = {},
): HTMLElement {
  const height = opts.height ?? DEFAULT_HEIGHT;
  const formatCost = opts.formatCost ?? defaultFormatCost;
  const resolveProjectLabel = opts.resolveProjectLabel ?? defaultResolveProjectLabel;
  const initialMode: CostOverTimeChartMode = opts.mode ?? 'stacked';

  const root = toElement(
    <div className="telemetry-cost-over-time-chart" data-mode={initialMode}></div>
  );

  if (points.length === 0) {
    root.appendChild(toElement(
      <div className="telemetry-cost-over-time-empty">{EMPTY_MESSAGE}</div>
    ));
    return root;
  }

  const projectSecrets = uniqueProjectSecrets(points);
  const tuples = uniqueProjectModelTuples(points);
  const dates = uniqueDates(points);
  const projectIdxOf = new Map<string, number>(projectSecrets.map((s, i) => [s, i]));
  const modelIdxOf = new Map<string, number>();
  for (const secret of projectSecrets) {
    const models = modelsForProject(tuples, secret);
    models.forEach((m, i) => modelIdxOf.set(`${secret} ${m}`, i));
  }
  const costLookup = buildCostLookup(points);
  // HS-8810 — days with no ingested telemetry (shaded distinctly from $0 days).
  const noTelemetryDates = computeNoTelemetryDates(dates, opts.ingestedDates);

  const showToggle = projectSecrets.length > 1;
  let currentMode: CostOverTimeChartMode = initialMode;

  // HS-8518 — single "Stacked" toggle button. `is-active` when the
  // chart is in stacked mode, plain when in lines mode. Hidden when
  // only one project is present in the data.
  let toggleBtn: HTMLButtonElement | null = null;
  if (showToggle) {
    const toggle = toElement(
      <div className="telemetry-cost-over-time-mode-toggle" role="group" aria-label="Chart mode">
        <button
          type="button"
          className={`telemetry-cost-over-time-mode-btn${currentMode === 'stacked' ? ' is-active' : ''}`}
          data-mode="stacked"
          aria-pressed={currentMode === 'stacked' ? 'true' : 'false'}
        >Stacked</button>
      </div>
    );
    toggleBtn = toggle.querySelector<HTMLButtonElement>('.telemetry-cost-over-time-mode-btn');
    toggle.addEventListener('click', (e) => {
      if ((e.target as HTMLElement | null)?.closest('.telemetry-cost-over-time-mode-btn') === null) return;
      const next: CostOverTimeChartMode = currentMode === 'stacked' ? 'lines' : 'stacked';
      currentMode = next;
      root.dataset.mode = next;
      if (toggleBtn !== null) {
        toggleBtn.classList.toggle('is-active', next === 'stacked');
        toggleBtn.setAttribute('aria-pressed', next === 'stacked' ? 'true' : 'false');
      }
      rerenderBody();
    });
    root.appendChild(toggle);
  }

  // SVG container — width-responsive via viewBox + preserveAspectRatio.
  // Use a fixed-aspect viewBox derived from a reference width so the
  // band coordinate math has stable units. The CSS sets width: 100%
  // and height: auto, so the displayed size adapts to the parent.
  const viewBoxWidth = 800;
  const svgWrap = toElement(<div className="telemetry-cost-over-time-svg-wrap"></div>);
  root.appendChild(svgWrap);

  function rerenderBody(): void {
    svgWrap.replaceChildren();
    let body: HTMLElement;
    if (currentMode === 'stacked') {
      const r = buildStackedBands(dates, tuples, projectIdxOf, modelIdxOf, costLookup);
      body = renderStackedBody({
        width: viewBoxWidth,
        height,
        dates,
        bands: r.bands,
        yMax: r.maxStackTotal,
        formatCost,
        resolveProjectLabel,
      });
    } else {
      const r = buildProjectDailyTotals(dates, projectSecrets, tuples, costLookup);
      body = renderLinesBody({
        width: viewBoxWidth,
        height,
        dates,
        series: r.series,
        yMax: r.maxDailyTotal,
        projectIdxOf,
        formatCost,
        resolveProjectLabel,
      });
    }
    const svg = toElement(
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={`0 0 ${String(viewBoxWidth)} ${String(height)}`}
        preserveAspectRatio="none"
        className="telemetry-cost-over-time-svg"
        role="img"
        aria-label="Cost over time"
      ></svg>
    );
    // HS-8810 — no-telemetry shading goes in FIRST so it sits behind the bars /
    // lines; the hover overlay is appended last (inside attachCostOverTimeHover).
    const bands = renderNoTelemetryBands(dates, noTelemetryDates, viewBoxWidth, height);
    if (bands !== null) svg.appendChild(bands);
    svg.appendChild(body);
    svgWrap.appendChild(svg);

    // HS-8534 — rich hover feedback (vertical cursor line + tooltip
    // listing every project's per-day cost) layered on top of the
    // chart body so the reading experience matches the analytics
    // dashboard's `addChartHover`. Native `<title>` tooltips stay as
    // a screen-reader fallback; the overlay catches `mousemove` first
    // because it's the last child of the SVG.
    attachCostOverTimeHover({
      svgWrap,
      svg,
      dates,
      projectSecrets,
      tuples,
      costLookup,
      viewBoxWidth,
      height,
      formatCost,
      resolveProjectLabel,
      noTelemetryDates,
    });
  }
  rerenderBody();

  // Legend below the chart.
  root.appendChild(renderLegend({
    projectSecrets,
    tuples,
    projectIdxOf,
    modelIdxOf,
    resolveProjectLabel,
  }));

  return root;
}

/**
 * HS-8534 — wire a vertical-cursor + per-column tooltip on top of the
 * chart's SVG. Mirrors the analytics-dashboard `addChartHover` pattern
 * from `dashboard.tsx`: the cursor follows the closest date column, the
 * tooltip lists every project's per-day cost (summed across models) at
 * that date, and the tooltip's grand-total reads the day's stacked
 * height.
 *
 * The overlay (transparent capture rect + cursor line + tooltip div)
 * is appended LAST so it catches `mousemove` ahead of the per-band
 * `<title>` elements. The native `<title>` tooltips stay in the tree
 * as a screen-reader fallback — they only fire on long stationary
 * hovers in browsers, so the overlap is invisible to mouse users.
 */
function attachCostOverTimeHover(args: {
  svgWrap: HTMLElement;
  svg: HTMLElement;
  dates: readonly string[];
  projectSecrets: readonly string[];
  tuples: readonly { projectSecret: string; model: string }[];
  costLookup: Map<string, number>;
  viewBoxWidth: number;
  height: number;
  formatCost: (n: number) => string;
  resolveProjectLabel: (secret: string) => string;
  /** HS-8810 — charted dates with no ingested telemetry (the empty-day tooltip
   *  reads "No telemetry captured" for these vs. "No cost" for a real $0 day). */
  noTelemetryDates: Set<string>;
}): void {
  const { svgWrap, svg, dates, projectSecrets, tuples, costLookup, viewBoxWidth, height, formatCost, resolveProjectLabel, noTelemetryDates } = args;
  if (dates.length === 0) return;

  const chartLeft = MARGIN_LEFT;
  const chartTop = MARGIN_TOP;
  const chartWidth = Math.max(0, viewBoxWidth - MARGIN_LEFT - MARGIN_RIGHT);
  const chartHeight = Math.max(0, height - MARGIN_TOP - MARGIN_BOTTOM);
  if (chartWidth === 0 || chartHeight === 0) return;
  const colWidth = chartWidth / dates.length;

  // Vertical cursor line (sits inside the SVG so it shares the same
  // coordinate space as the bands/lines).
  const cursor = toElement(
    <line
      x1={String(chartLeft)} x2={String(chartLeft)}
      y1={String(chartTop)} y2={String(chartTop + chartHeight)}
      className="telemetry-cost-over-time-cursor"
      style="display:none"
    ></line>
  );
  svg.appendChild(cursor);

  // Transparent overlay rect that captures pointer events for the
  // whole chart area — drawn last so it sits above every band / dot.
  const overlay = toElement(
    <rect
      x={String(chartLeft)} y={String(chartTop)}
      width={String(chartWidth)} height={String(chartHeight)}
      fill="transparent"
      className="telemetry-cost-over-time-hover-capture"
    ></rect>
  );
  svg.appendChild(overlay);

  // Tooltip lives in the HTML layer so we can use flow layout +
  // dynamic width. Anchored relative to `svgWrap` (which is
  // position:relative via the SCSS rule below).
  const tooltip = toElement(
    <div className="telemetry-cost-over-time-tooltip" style="display:none"></div>
  );
  svgWrap.appendChild(tooltip);

  function hide(): void {
    cursor.style.display = 'none';
    tooltip.style.display = 'none';
  }

  function update(e: MouseEvent): void {
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const mouseVbX = (e.clientX - rect.left) * (viewBoxWidth / rect.width);
    const relX = mouseVbX - chartLeft;
    let idx = Math.floor(relX / colWidth);
    if (idx < 0) idx = 0;
    if (idx >= dates.length) idx = dates.length - 1;

    const date = dates[idx];
    const columnCenterVbX = chartLeft + idx * colWidth + colWidth / 2;
    cursor.setAttribute('x1', String(columnCenterVbX));
    cursor.setAttribute('x2', String(columnCenterVbX));
    cursor.style.display = '';

    // Per-project total at this date (sum across models). Filter to
    // non-zero entries so days where a project has zero cost don't
    // clutter the tooltip — but always show the grand total.
    const perProject: Array<{ secret: string; label: string; cost: number }> = [];
    let grand = 0;
    for (const secret of projectSecrets) {
      let sum = 0;
      for (const t of tuples) {
        if (t.projectSecret !== secret) continue;
        const cost = costLookup.get(`${date} ${secret} ${t.model}`) ?? 0;
        sum += cost;
      }
      grand += sum;
      if (sum > 0) {
        perProject.push({ secret, label: resolveProjectLabel(secret), cost: sum });
      }
    }
    perProject.sort((a, b) => b.cost - a.cost);

    const rows: HTMLElement[] = [];
    rows.push(toElement(
      <div className="telemetry-cost-over-time-tooltip-date">{date}</div>
    ));
    for (const row of perProject) {
      const projectIdx = projectSecrets.indexOf(row.secret);
      const color = MODEL_DONUT_COLORS[projectIdx % MODEL_DONUT_COLORS.length];
      rows.push(toElement(
        <div className="telemetry-cost-over-time-tooltip-row">
          <span
            className="telemetry-cost-over-time-tooltip-swatch"
            style={`background-color: ${color};`}
          ></span>
          <span className="telemetry-cost-over-time-tooltip-label">{row.label}</span>
          <span className="telemetry-cost-over-time-tooltip-cost">{formatCost(row.cost)}</span>
        </div>
      ));
    }
    if (perProject.length > 1) {
      rows.push(toElement(
        <div className="telemetry-cost-over-time-tooltip-total">
          <span className="telemetry-cost-over-time-tooltip-label">Total</span>
          <span className="telemetry-cost-over-time-tooltip-cost">{formatCost(grand)}</span>
        </div>
      ));
    } else if (perProject.length === 0) {
      // HS-8793 — a full-width line, NOT a `tooltip-row`: that row is a
      // `grid-template-columns: 10px 1fr auto` (swatch / label / cost), so a
      // lone label landed in the 10px swatch track and the label's
      // `overflow:hidden; text-overflow:ellipsis` crushed "No cost" down to
      // "N…" — the mysterious "N." the user saw on no-data days.
      // HS-8810 — distinguish a day with no telemetry ingested at all (receiver
      // down / Claude outside Hot Sheet) from a day that genuinely cost $0.
      rows.push(toElement(
        <div className="telemetry-cost-over-time-tooltip-empty">
          {noTelemetryDates.has(date) ? 'No telemetry captured' : 'No cost'}
        </div>
      ));
    }
    tooltip.replaceChildren(...rows);
    tooltip.style.display = '';

    // Position the tooltip near the cursor in HTML-pixel space.
    // `svgWrap` is position:relative so its bounding-rect is the
    // anchor. Clamp so the tooltip stays inside the wrap.
    const wrapRect = svgWrap.getBoundingClientRect();
    const cursorPxX = (columnCenterVbX / viewBoxWidth) * rect.width + (rect.left - wrapRect.left);
    const ttRect = tooltip.getBoundingClientRect();
    let left = cursorPxX + 10;
    if (left + ttRect.width > wrapRect.width) {
      left = cursorPxX - ttRect.width - 10;
    }
    if (left < 0) left = 0;
    const top = Math.max(0, e.clientY - wrapRect.top - ttRect.height - 8);
    tooltip.style.left = `${String(Math.round(left))}px`;
    tooltip.style.top = `${String(Math.round(top))}px`;
  }

  overlay.addEventListener('mousemove', update as EventListener);
  overlay.addEventListener('mouseleave', hide);
}
