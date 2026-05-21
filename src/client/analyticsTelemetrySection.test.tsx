// @vitest-environment happy-dom
//
// HS-8508 / §71 — tests for the analytics-dashboard per-project
// telemetry section. The mounted section is self-managing (fetches
// `/api/telemetry/project-rollup` on mount + window-selector change),
// so most tests drive the pure render path via the `_testing.renderBody`
// escape hatch with fixture payloads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _testing, renderAnalyticsTelemetrySection } from './analyticsTelemetrySection.js';

interface WindowTotals {
  cost: number;
  tokens: number;
  promptCount: number;
}

function emptyTotals(): WindowTotals {
  return { cost: 0, tokens: 0, promptCount: 0 };
}

function nonEmptyTotals(cost = 1): WindowTotals {
  return { cost, tokens: 1000, promptCount: 5 };
}

interface FixtureOverrides {
  costByModel?: { model: string; cost: number; tokens: number; promptCount: number }[];
  toolLatencyHistogram?: { tool: string; count: number; totalMs: number; p50: number | null; p90: number | null; p99: number | null; buckets: number[] }[];
  recentPrompts?: { promptId: string; ts: string; projectSecret: string; model: string | null }[];
  costOverTime?: { date: string; projectSecret: string; model: string; cost: number }[];
  windowTotalsAllTime?: WindowTotals;
}

function makePayload(overrides: FixtureOverrides = {}): Parameters<typeof _testing.renderBody>[0] {
  return {
    window: 'month',
    windowTotals: {
      today: nonEmptyTotals(),
      week: nonEmptyTotals(2),
      month: nonEmptyTotals(5),
      allTime: overrides.windowTotalsAllTime ?? nonEmptyTotals(10),
    },
    costByModel: overrides.costByModel ?? [],
    toolLatencyHistogram: overrides.toolLatencyHistogram ?? [],
    recentPrompts: overrides.recentPrompts ?? [],
    costOverTime: overrides.costOverTime ?? [],
  };
}

beforeEach(() => {
  _testing.setWindow('month');
});

afterEach(() => {
  _testing.setWindow('month');
});

describe('renderBody (HS-8508 analytics-dashboard telemetry section)', () => {
  it('renders the empty-placeholder when all-time totals are zero (telemetry off OR no data yet)', () => {
    const body = _testing.renderBody(
      makePayload({ windowTotalsAllTime: emptyTotals() }),
      'secretA',
    );
    expect(body.classList.contains('analytics-telemetry-empty')).toBe(true);
    expect(body.querySelector('.analytics-telemetry-empty-hint')).not.toBeNull();
    expect(body.textContent).toMatch(/Enable telemetry in Settings/i);
  });

  it('renders 3 chips (Today / This week / All time) — NOT 4', () => {
    const body = _testing.renderBody(makePayload(), 'secretA');
    const chips = body.querySelectorAll('.telemetry-chip');
    expect(chips.length).toBe(3);
    const labels = [...chips].map(c => c.querySelector('.telemetry-chip-label')?.textContent);
    expect(labels).toEqual(['Today', 'This week', 'All time']);
  });

  it('renders the cost-over-time section when payload.costOverTime has data', () => {
    const body = _testing.renderBody(
      makePayload({
        costOverTime: [
          { date: '2026-05-19', projectSecret: 'secretA', model: 'sonnet', cost: 1.0 },
          { date: '2026-05-20', projectSecret: 'secretA', model: 'sonnet', cost: 0.5 },
        ],
      }),
      'secretA',
    );
    const section = body.querySelector('[data-section="cost-over-time"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector('.telemetry-cost-over-time-chart')).not.toBeNull();
  });

  it('hides the chart mode toggle for a single-project slice (the analytics-dashboard variant always has one project)', () => {
    const body = _testing.renderBody(
      makePayload({
        costOverTime: [
          { date: '2026-05-19', projectSecret: 'secretA', model: 'sonnet', cost: 1.0 },
          { date: '2026-05-19', projectSecret: 'secretA', model: 'haiku', cost: 0.5 },
        ],
      }),
      'secretA',
    );
    expect(body.querySelector('.telemetry-cost-over-time-mode-toggle')).toBeNull();
  });

  it('renders the cost-by-model donut when payload.costByModel has data', () => {
    const body = _testing.renderBody(
      makePayload({
        costByModel: [
          { model: 'sonnet', cost: 5, tokens: 1000, promptCount: 3 },
          { model: 'haiku', cost: 2, tokens: 500, promptCount: 2 },
        ],
      }),
      'secretA',
    );
    const section = body.querySelector('[data-section="cost-by-model"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector('.telemetry-dashboard-model-donut')).not.toBeNull();
    expect(section?.querySelectorAll('.telemetry-dashboard-model-legend-row').length).toBe(2);
  });

  it('renders per-tool latency histograms when payload.toolLatencyHistogram has data', () => {
    const body = _testing.renderBody(
      makePayload({
        toolLatencyHistogram: [
          { tool: 'bash', count: 10, totalMs: 1234, p50: 50, p90: 500, p99: 800, buckets: [1, 2, 3, 0, 0, 0, 0, 0] },
        ],
      }),
      'secretA',
    );
    const section = body.querySelector('[data-section="tool-latency"]');
    expect(section).not.toBeNull();
    const histograms = section?.querySelectorAll('.telemetry-histogram-row');
    expect(histograms?.length).toBe(1);
    expect(histograms?.[0].textContent).toContain('bash');
    expect(histograms?.[0].textContent).toContain('p50');
  });

  it('renders the recent-prompts list when payload.recentPrompts has data (sorted ts DESC by the backend)', () => {
    const body = _testing.renderBody(
      makePayload({
        recentPrompts: [
          { promptId: 'prompt-1', ts: '2026-05-21T00:00:00Z', projectSecret: 'secretA', model: 'sonnet' },
          { promptId: 'prompt-2', ts: '2026-05-20T00:00:00Z', projectSecret: 'secretA', model: 'haiku' },
        ],
      }),
      'secretA',
    );
    const section = body.querySelector('[data-section="recent-prompts"]');
    expect(section).not.toBeNull();
    const items = section?.querySelectorAll('.telemetry-recent-prompt');
    expect(items?.length).toBe(2);
    expect((items?.[0] as HTMLElement | undefined)?.dataset['promptId']).toBe('prompt-1');
  });

  it('does NOT render any section block when its corresponding payload field is empty', () => {
    const body = _testing.renderBody(makePayload(), 'secretA');
    // With only window-totals populated (other fields empty arrays),
    // only the chips render — no section blocks.
    expect(body.querySelector('[data-section="cost-over-time"]')).toBeNull();
    expect(body.querySelector('[data-section="cost-by-model"]')).toBeNull();
    expect(body.querySelector('[data-section="tool-latency"]')).toBeNull();
    expect(body.querySelector('[data-section="recent-prompts"]')).toBeNull();
  });
});

describe('renderAnalyticsTelemetrySection (mount shell)', () => {
  it('renders the section header with the "Claude usage" title and no window selector (HS-8512)', () => {
    const root = renderAnalyticsTelemetrySection();
    const title = root.querySelector('.analytics-telemetry-title');
    expect(title?.textContent).toBe('Claude usage');
    // HS-8512 — the in-section window selector was removed; the
    // dashboard's top-level 7/30/90 day range bar drives the
    // telemetry window now.
    expect(root.querySelector('#analytics-telemetry-window-select')).toBeNull();
    expect(root.querySelector('.analytics-telemetry-window-selector')).toBeNull();
  });

  it('starts in the "month" window by default', () => {
    renderAnalyticsTelemetrySection();
    expect(_testing.getWindow()).toBe('month');
  });

  it('maps the supplied dashboard days to the matching telemetry window (HS-8512)', () => {
    renderAnalyticsTelemetrySection(7);
    expect(_testing.getWindow()).toBe('week');
    renderAnalyticsTelemetrySection(30);
    expect(_testing.getWindow()).toBe('month');
    renderAnalyticsTelemetrySection(90);
    expect(_testing.getWindow()).toBe('90d');
  });
});
