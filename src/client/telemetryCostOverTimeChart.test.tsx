// @vitest-environment happy-dom
//
// HS-8506 — tests for the shared cost-over-time chart component used
// by the cross-project telemetry page (HS-8507) and the per-project
// analytics-dashboard telemetry sub-region (HS-8508).
// HS-8518 — rewrites: byProject mode replaced with lines mode +
// single "Stacked" toggle button. Covers:
//
// - empty-state render
// - densification → SVG-element-count contract (one band per non-zero
//   (date, project, model) tuple in stacked mode)
// - toggle visibility (shown when >1 project, hidden when 1)
// - toggle button is the single "Stacked" button (not a 2-button mode group)
// - toggling switches between stacked bars and per-project polylines
// - lines mode renders one polyline per project + a circle per
//   non-zero day
// - tooltip text format for both modes
// - data-mode attribute reflecting the current mode
import { describe, expect, it } from 'vitest';

import {
  type CostOverTimePoint,
  renderCostOverTimeChart,
} from './telemetryCostOverTimeChart.js';

function pt(date: string, projectSecret: string, model: string, cost: number): CostOverTimePoint {
  return { date, projectSecret, model, cost };
}

describe('renderCostOverTimeChart (HS-8506 / HS-8518)', () => {
  it('renders an empty-state message when no points are supplied', () => {
    const el = renderCostOverTimeChart([]);
    expect(el.querySelector('.telemetry-cost-over-time-empty')?.textContent).toMatch(/no cost data/i);
    expect(el.querySelector('svg')).toBeNull();
  });

  it('renders one band per non-zero (date, project, model) tuple in stacked mode', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretA', 'haiku', 0.0),  // zero — no band
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
      pt('2026-05-20', 'secretA', 'sonnet', 0.0), // zero — no band
      pt('2026-05-20', 'secretB', 'sonnet', 0.7),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'stacked' });
    expect(el.querySelectorAll('.telemetry-cost-over-time-band').length).toBe(3);
  });

  it('hides the mode toggle when only one project is present', () => {
    const points = [
      pt('2026-05-19', 'onlyOne', 'sonnet', 1.0),
      pt('2026-05-20', 'onlyOne', 'haiku', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    expect(el.querySelector('.telemetry-cost-over-time-mode-toggle')).toBeNull();
  });

  it('shows a single "Stacked" toggle button when >1 project is present', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    const toggle = el.querySelector('.telemetry-cost-over-time-mode-toggle');
    expect(toggle).not.toBeNull();
    const btns = toggle?.querySelectorAll('.telemetry-cost-over-time-mode-btn');
    expect(btns?.length).toBe(1);
    expect(btns?.[0].textContent).toBe('Stacked');
  });

  it('starts in stacked mode by default; toggle button is is-active', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    expect(el.dataset.mode).toBe('stacked');
    expect(el.querySelector('.telemetry-cost-over-time-mode-btn')?.classList.contains('is-active')).toBe(true);
    expect(el.querySelector('.telemetry-cost-over-time-mode-btn')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('honors opts.mode === "lines" at initial render', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'lines' });
    expect(el.dataset.mode).toBe('lines');
    expect(el.querySelector('.telemetry-cost-over-time-mode-btn')?.classList.contains('is-active')).toBe(false);
    expect(el.querySelector('.telemetry-cost-over-time-mode-btn')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking the Stacked button toggles between stacked and lines mode', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    const btn = el.querySelector<HTMLButtonElement>('.telemetry-cost-over-time-mode-btn');
    expect(btn).not.toBeNull();
    btn?.click();
    expect(el.dataset.mode).toBe('lines');
    expect(btn?.classList.contains('is-active')).toBe(false);
    btn?.click();
    expect(el.dataset.mode).toBe('stacked');
    expect(btn?.classList.contains('is-active')).toBe(true);
  });

  it('renders one polyline per project + one circle per non-zero day in lines mode', () => {
    // Two projects (A, B). A has cost on May 19 + May 20. B has cost only on May 20.
    // Expected: 2 polylines (one per project), 3 circles (A on 19, A on 20, B on 20).
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.0),
      pt('2026-05-20', 'secretA', 'sonnet', 0.5),
      pt('2026-05-20', 'secretB', 'sonnet', 0.7),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'lines' });
    expect(el.querySelectorAll('.telemetry-cost-over-time-line').length).toBe(2);
    expect(el.querySelectorAll('.telemetry-cost-over-time-line-point').length).toBe(3);
    expect(el.querySelectorAll('.telemetry-cost-over-time-band').length).toBe(0);
  });

  it('sums per-day costs across models in lines mode (one circle per day, not per model)', () => {
    // Project A has both sonnet + haiku on May 19. Lines mode should
    // collapse them into a single (A, May 19) point.
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretA', 'haiku', 0.5),
      pt('2026-05-19', 'secretB', 'sonnet', 0.4),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'lines' });
    const aCircles = el.querySelectorAll('.telemetry-cost-over-time-line-point[data-project-secret="secretA"]');
    expect(aCircles.length).toBe(1);
    const tooltip = aCircles[0].querySelector('title')?.textContent;
    expect(tooltip).toBe('2026-05-19 — secretA: $1.50');
  });

  it('renders a tooltip <title> with date, project label, model, and formatted cost on stacked bands', () => {
    const points = [pt('2026-05-19', 'secretA', 'sonnet', 1.23)];
    const el = renderCostOverTimeChart(points, {
      resolveProjectLabel: (s) => s === 'secretA' ? 'Alpha' : s,
    });
    const band = el.querySelector('.telemetry-cost-over-time-band');
    const title = band?.querySelector('title');
    expect(title?.textContent).toBe('2026-05-19 — Alpha / sonnet: $1.23');
  });

  it('renders tooltip with date, project label, and formatted cost on lines mode circles', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.23),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points, {
      mode: 'lines',
      resolveProjectLabel: (s) => s === 'secretA' ? 'Alpha' : 'Beta',
    });
    const aCircle = el.querySelector('.telemetry-cost-over-time-line-point[data-project-secret="secretA"]');
    expect(aCircle?.querySelector('title')?.textContent).toBe('2026-05-19 — Alpha: $1.23');
  });

  it('renders a legend block per project with nested model rows', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretA', 'haiku', 0.5),
      pt('2026-05-19', 'secretB', 'sonnet', 0.4),
    ];
    const el = renderCostOverTimeChart(points, {
      resolveProjectLabel: (s) => s === 'secretA' ? 'Alpha' : 'Beta',
    });
    const projects = el.querySelectorAll('.telemetry-cost-over-time-legend-project');
    expect(projects.length).toBe(2);
    expect(projects[0].querySelectorAll('.telemetry-cost-over-time-legend-model-row').length).toBe(2);
    expect(projects[1].querySelectorAll('.telemetry-cost-over-time-legend-model-row').length).toBe(1);
    expect(projects[0].textContent).toContain('Alpha');
    expect(projects[0].textContent).toContain('sonnet');
    expect(projects[0].textContent).toContain('haiku');
    expect(projects[1].textContent).toContain('Beta');
  });

  it('uses the supplied formatCost for tooltips and axis ticks', () => {
    const points = [pt('2026-05-19', 'secretA', 'sonnet', 1.0)];
    const el = renderCostOverTimeChart(points, {
      formatCost: (n) => `${(n * 100).toFixed(0)}¢`,
    });
    const title = el.querySelector('.telemetry-cost-over-time-band title');
    expect(title?.textContent).toMatch(/100¢/);
    const tick = el.querySelector('.telemetry-cost-over-time-ytick');
    expect(tick?.textContent).toMatch(/¢/);
  });

  // HS-8534 — the chart wires a vertical cursor line + tooltip overlay
  // on top of the SVG body so the hover experience matches the
  // analytics-dashboard `addChartHover` (instead of relying solely on
  // the native `<title>` long-hover tooltips).
  it('attaches a hover overlay (cursor line + capture rect + tooltip) on every render', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-20', 'secretA', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    expect(el.querySelector('.telemetry-cost-over-time-cursor')).not.toBeNull();
    expect(el.querySelector('.telemetry-cost-over-time-hover-capture')).not.toBeNull();
    expect(el.querySelector('.telemetry-cost-over-time-tooltip')).not.toBeNull();
  });

  it('hides the cursor + tooltip by default (no hover yet)', () => {
    const points = [pt('2026-05-19', 'secretA', 'sonnet', 1.0)];
    const el = renderCostOverTimeChart(points);
    const cursor = el.querySelector<SVGElement>('.telemetry-cost-over-time-cursor');
    const tooltip = el.querySelector<HTMLElement>('.telemetry-cost-over-time-tooltip');
    expect(cursor?.style.display).toBe('none');
    expect(tooltip?.style.display).toBe('none');
  });

  it('does NOT attach a hover overlay when there are zero data points (empty-state branch)', () => {
    const el = renderCostOverTimeChart([]);
    expect(el.querySelector('.telemetry-cost-over-time-cursor')).toBeNull();
    expect(el.querySelector('.telemetry-cost-over-time-hover-capture')).toBeNull();
    expect(el.querySelector('.telemetry-cost-over-time-tooltip')).toBeNull();
  });

  // HS-8793 — hovering a day with no cost (e.g. the reported Jun 3/4 gap) must
  // show the full "No cost" line. The regression: the empty row reused the
  // `tooltip-row` swatch grid, so the lone label was crushed into the 10px
  // swatch track and ellipsis-truncated to "N…" (the mysterious "N." the user
  // saw). clientX=0 clamps to the first column, so dates[0] (cost 0) is hit.
  it('renders the full "No cost" empty state — not a crushed "N." — on a zero-cost day (HS-8793)', () => {
    const points = [
      pt('2026-06-03', 'secretA', 'sonnet', 0),   // dates[0] — the no-cost day
      pt('2026-06-04', 'secretA', 'sonnet', 2.5),
    ];
    const el = renderCostOverTimeChart(points);
    const svg = el.querySelector('svg');
    if (svg === null) throw new Error('expected an SVG');
    // happy-dom returns a 0×0 rect → `update` early-returns; stub a real size.
    svg.getBoundingClientRect = () => new DOMRect(0, 0, 100, 100);
    const overlay = el.querySelector('.telemetry-cost-over-time-hover-capture');
    if (overlay === null) throw new Error('expected a hover-capture overlay');
    overlay.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0, bubbles: true }));

    const empty = el.querySelector('.telemetry-cost-over-time-tooltip-empty');
    expect(empty?.textContent).toBe('No cost');
    // Must NOT reuse the 3-column swatch grid that truncated the text.
    expect(empty?.classList.contains('telemetry-cost-over-time-tooltip-row')).toBe(false);
  });
});
