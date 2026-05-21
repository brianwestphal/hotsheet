// @vitest-environment happy-dom
//
// HS-8506 — tests for the shared cost-over-time chart component used
// by the cross-project telemetry page (HS-8507) and the per-project
// analytics-dashboard telemetry sub-region (HS-8508). Covers:
//
// - empty-state render
// - densification → SVG-element-count contract (one band per non-zero
//   (date, project, model) tuple)
// - mode toggle visibility (shown when >1 project, hidden when 1)
// - mode toggle producing different band geometries (the by-project
//   mode resets the y-stack at each project, the stacked mode keeps
//   one running total)
// - tooltip text format
// - data-mode attribute reflecting the current mode
import { describe, expect, it } from 'vitest';

import {
  type CostOverTimePoint,
  renderCostOverTimeChart,
} from './telemetryCostOverTimeChart.js';

function pt(date: string, projectSecret: string, model: string, cost: number): CostOverTimePoint {
  return { date, projectSecret, model, cost };
}

describe('renderCostOverTimeChart (HS-8506)', () => {
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

  it('shows the mode toggle when more than one project is present', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    const toggle = el.querySelector('.telemetry-cost-over-time-mode-toggle');
    expect(toggle).not.toBeNull();
    expect(toggle?.querySelectorAll('.telemetry-cost-over-time-mode-btn').length).toBe(2);
  });

  it('starts in stacked mode by default and reflects mode in data-mode', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    expect(el.dataset.mode).toBe('stacked');
    const activeBtn = el.querySelector<HTMLElement>('.telemetry-cost-over-time-mode-btn.is-active');
    expect(activeBtn?.dataset.mode).toBe('stacked');
  });

  it('honors the opts.mode override at initial render', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'byProject' });
    expect(el.dataset.mode).toBe('byProject');
    expect(el.querySelector<HTMLElement>('.telemetry-cost-over-time-mode-btn.is-active')?.dataset.mode).toBe('byProject');
  });

  it('switches mode when the toggle is clicked', () => {
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points);
    const byProjectBtn = el.querySelector<HTMLElement>('.telemetry-cost-over-time-mode-btn[data-mode="byProject"]');
    expect(byProjectBtn).not.toBeNull();
    byProjectBtn?.click();
    expect(el.dataset.mode).toBe('byProject');
    expect(el.querySelector<HTMLElement>('.telemetry-cost-over-time-mode-btn.is-active')?.dataset.mode).toBe('byProject');
  });

  it('renders identical band counts in either mode for a single-project slice', () => {
    // Per-project analytics dashboard variant: only one project is
    // in the data. The toggle is hidden and both modes look the
    // same visually — the band count must match exactly.
    const points = [
      pt('2026-05-19', 'onlyOne', 'sonnet', 1.0),
      pt('2026-05-19', 'onlyOne', 'haiku', 0.5),
      pt('2026-05-20', 'onlyOne', 'sonnet', 0.7),
    ];
    const stacked = renderCostOverTimeChart(points, { mode: 'stacked' });
    const byProject = renderCostOverTimeChart(points, { mode: 'byProject' });
    expect(stacked.querySelectorAll('.telemetry-cost-over-time-band').length).toBe(3);
    expect(byProject.querySelectorAll('.telemetry-cost-over-time-band').length).toBe(3);
  });

  it('stacks stacked-mode bands on top of each other within a date column', () => {
    // Two projects, one date, one model each — stacked mode means
    // the bands sit at different y positions in the same column.
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'stacked' });
    const bands = [...el.querySelectorAll<SVGRectElement>('.telemetry-cost-over-time-band')];
    expect(bands.length).toBe(2);
    const ys = bands.map(r => Number(r.getAttribute('y'))).sort((a, b) => a - b);
    expect(ys[0]).not.toBe(ys[1]);
  });

  it('starts each project at y = 0 in by-project mode (overlapping bands)', () => {
    // Two projects, one date, one model each — by-project mode
    // means each project's stack starts at y = 0, so both bands
    // share the SAME bottom-y (the chart baseline).
    const points = [
      pt('2026-05-19', 'secretA', 'sonnet', 1.0),
      pt('2026-05-19', 'secretB', 'sonnet', 0.5),
    ];
    const el = renderCostOverTimeChart(points, { mode: 'byProject' });
    const bands = [...el.querySelectorAll<SVGRectElement>('.telemetry-cost-over-time-band')];
    expect(bands.length).toBe(2);
    // Each band's bottom = y + height. Both project stacks share
    // the chart baseline in by-project mode.
    const bottoms = bands.map(r => Number(r.getAttribute('y')) + Number(r.getAttribute('height')));
    expect(bottoms[0]).toBeCloseTo(bottoms[1], 1);
  });

  it('renders a tooltip <title> with date, project label, model, and formatted cost', () => {
    const points = [pt('2026-05-19', 'secretA', 'sonnet', 1.23)];
    const el = renderCostOverTimeChart(points, {
      resolveProjectLabel: (s) => s === 'secretA' ? 'Alpha' : s,
    });
    const band = el.querySelector('.telemetry-cost-over-time-band');
    const title = band?.querySelector('title');
    expect(title?.textContent).toBe('2026-05-19 — Alpha / sonnet: $1.23');
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
});
