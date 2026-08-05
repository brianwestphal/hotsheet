// @vitest-environment happy-dom
//
// HS-8508 / §71 — tests for the analytics-dashboard per-project
// telemetry section. The mounted section is self-managing (fetches
// `/api/telemetry/project-rollup` on mount + window-selector change),
// so most tests drive the pure render path via the `_testing.renderBody`
// escape hatch with fixture payloads.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { costAvailabilityFor } from '../aiTools/costAvailability.js';
import { _testing, renderAnalyticsTelemetrySection, telemetrySectionTitle } from './analyticsTelemetrySection.js';

interface WindowTotals {
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** HS-9607 — a breakdown of `outputTokens`, never added to `tokens`. */
  reasoningOutputTokens?: number;
  promptCount: number;
}

function emptyTotals(): WindowTotals {
  return { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, promptCount: 0 };
}

function nonEmptyTotals(cost = 1): WindowTotals {
  return { cost, tokens: 1000, inputTokens: 700, outputTokens: 300, promptCount: 5 };
}

interface FixtureOverrides {
  costByModel?: { model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number; promptCount: number }[];
  toolLatencyHistogram?: { tool: string; count: number; totalMs: number; p50: number | null; p90: number | null; p99: number | null; buckets: number[] }[];
  recentPrompts?: { promptId: string; ts: string; projectSecret: string; model: string | null }[];
  costOverTime?: { date: string; projectSecret: string; model: string; cost: number }[];
  windowTotalsAllTime?: WindowTotals;
  emitters?: string[];
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
    emitters: overrides.emitters,
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

  // HS-8536 — single-project chips were widened to mirror the
  // cross-project page's 4-chip layout (today / week / month / all time)
  // and stretched to fill the dashboard width via a 4-col CSS grid.
  it('renders 4 chips (Today / This week / This month / All time) — mirrors the cross-project layout', () => {
    const body = _testing.renderBody(makePayload(), 'secretA');
    const chips = body.querySelectorAll('.telemetry-chip');
    expect(chips.length).toBe(4);
    const labels = [...chips].map(c => c.querySelector('.telemetry-chip-label')?.textContent);
    expect(labels).toEqual(['Today', 'This week', 'This month', 'All time']);
  });

  // HS-8543 — every populated body (i.e. anywhere chips render) leads
  // with the always-visible subscription-cost disclaimer above the
  // chips. Empty-state branch correctly skips it.
  it('renders the subscription-cost disclaimer above the chips when data is present (HS-8543)', () => {
    const body = _testing.renderBody(makePayload(), 'secretA');
    const disclaimer = body.querySelector('.telemetry-subscription-disclaimer');
    expect(disclaimer).not.toBeNull();
    expect(disclaimer?.textContent ?? '').toMatch(/subscription/i);
    const chips = body.querySelector('.telemetry-window-chips');
    expect(disclaimer?.compareDocumentPosition(chips as Node) ?? 0)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('does NOT render the disclaimer on the empty-state branch', () => {
    const body = _testing.renderBody(
      makePayload({ windowTotalsAllTime: emptyTotals() }),
      'secretA',
    );
    expect(body.querySelector('.telemetry-subscription-disclaimer')).toBeNull();
  });

  it('warns under the cost CHART when the window mixes a tool that reports no cost (HS-9605)', () => {
    // The dangerous shape: a real Claude cost curve over a window that also
    // holds codex turns. Nothing about the chart looks wrong — it is simply
    // lower than the truth — so the only honest fix is to say so in words.
    const body = _testing.renderBody(
      makePayload({
        emitters: ['claude', 'codex'],
        costOverTime: [{ date: '2026-05-19', projectSecret: 'secretA', model: 'sonnet', cost: 1.0 }],
      }),
      'secretA',
    );
    const caveat = body.querySelector('[data-section="cost-over-time"] .telemetry-cost-caveat');
    expect(caveat?.textContent).toContain('Codex');
    // The DIRECTION matters — a reader deciding whether to trust the curve
    // needs to know which way it is wrong.
    expect(caveat?.textContent).toContain('higher');
  });

  it('leaves the cost chart and donut unannotated for an all-Claude window', () => {
    // The caveat has to be absent in the ordinary case, or it becomes noise
    // everyone learns to skip past.
    const body = _testing.renderBody(
      makePayload({
        emitters: ['claude'],
        costOverTime: [{ date: '2026-05-19', projectSecret: 'secretA', model: 'sonnet', cost: 1.0 }],
        costByModel: [{ model: 'sonnet', cost: 1, tokens: 10, inputTokens: 7, outputTokens: 3, promptCount: 1 }],
      }),
      'secretA',
    );
    expect(body.querySelector('.telemetry-cost-caveat')).toBeNull();
  });

  it('warns under the cost DONUT too — the same under-count, split by model', () => {
    const body = _testing.renderBody(
      makePayload({
        emitters: ['claude', 'codex'],
        costByModel: [{ model: 'sonnet', cost: 1, tokens: 10, inputTokens: 7, outputTokens: 3, promptCount: 1 }],
      }),
      'secretA',
    );
    expect(body.querySelector('[data-section="cost-by-model"] .telemetry-cost-caveat')).not.toBeNull();
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
          { model: 'sonnet', cost: 5, tokens: 1000, inputTokens: 700, outputTokens: 300, promptCount: 3 },
          { model: 'haiku', cost: 2, tokens: 500, inputTokens: 400, outputTokens: 100, promptCount: 2 },
        ],
      }),
      'secretA',
    );
    const section = body.querySelector('[data-section="cost-by-model"]');
    expect(section).not.toBeNull();
    expect(section?.querySelector('.telemetry-dashboard-model-donut')).not.toBeNull();
    expect(section?.querySelectorAll('.telemetry-dashboard-model-legend-row').length).toBe(2);
    // HS-8628 — each legend row carries an input/output split + the derived
    // $/Mtok estimate. sonnet: $5 / 1000 tok = $5,000.00/Mtok.
    const metas = section?.querySelectorAll('.telemetry-dashboard-model-legend-meta');
    expect(metas?.length).toBe(2);
    expect(metas?.[0].textContent).toContain('700 in / 300 out');
    expect(metas?.[0].textContent).toContain('$5,000.00/Mtok');
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
  it('renders the section header with a neutral title and no window selector (HS-8512)', () => {
    const root = renderAnalyticsTelemetrySection();
    const title = root.querySelector('.analytics-telemetry-title');
    // HS-9602 — the mount shell renders BEFORE any payload arrives, so it must
    // not assert a vendor. The heading is replaced once the data says whose it
    // is (see `telemetrySectionTitle`).
    expect(title?.textContent).toBe('AI Usage');
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

/**
 * HS-9602 — the section names the tool whose telemetry it is SHOWING, not the
 * tool the project is configured to use.
 *
 * Renaming the old hard-coded "Claude Usage" to the project's `ai_tool` was the
 * obvious move and would have been worse: a codex project would claim "Codex
 * Usage" over Claude's data, or over an empty chart. So the label follows the
 * payload.
 */
describe('telemetrySectionTitle (HS-9602)', () => {
  it('names a single recognized tool', () => {
    expect(telemetrySectionTitle(['claude'])).toBe('Claude Code Usage');
    expect(telemetrySectionTitle(['codex'])).toBe('Codex Usage');
  });

  it('stays neutral when several tools contributed', () => {
    // Naming one of them would misattribute the other's spend.
    expect(telemetrySectionTitle(['claude', 'codex'])).toBe('AI Usage');
  });

  it('stays neutral for an empty window rather than naming a vendor over a blank panel', () => {
    expect(telemetrySectionTitle([])).toBe('AI Usage');
  });

  it('stays neutral for an unrecognized emitter', () => {
    // "we received data and cannot attribute it" must not be dressed up as a
    // specific product.
    expect(telemetrySectionTitle(['unknown'])).toBe('AI Usage');
    expect(telemetrySectionTitle(['claude', 'unknown'])).toBe('AI Usage');
  });
});

/**
 * HS-9605 — a missing cost must not look like a zero.
 *
 * Codex reports no cost at all, so once its telemetry arrives (HS-9603 switched
 * its exporter on) every cost chip would otherwise read `$0.00` — "this work was
 * free", which is a stronger and more wrong claim than "we don't know".
 */
describe('cost chip availability (HS-9605)', () => {
  const totals = { cost: 0, tokens: 1000, promptCount: 3, inputTokens: 600, outputTokens: 400 };

  it('shows an em dash, not $0.00, when no tool reports cost', () => {
    const chip = _testing.renderWindowChip('Today', totals, costAvailabilityFor(['codex']));
    const cost = chip.querySelector('.telemetry-chip-cost');
    expect(cost?.textContent).toBe('—');
    expect(cost?.textContent).not.toContain('$');
    // The reason has to be reachable — a bare dash otherwise reads as a bug.
    expect(cost?.getAttribute('title')).toMatch(/does not report cost/);
  });

  it('still shows the figure for a MIXED window, flagged as an under-count', () => {
    // The number is real; it just omits every codex turn. Hiding it would throw
    // away true information, so it is shown and qualified instead.
    const chip = _testing.renderWindowChip('Today', { ...totals, cost: 1.25 }, costAvailabilityFor(['claude', 'codex']));
    const cost = chip.querySelector('.telemetry-chip-cost');
    expect(cost?.textContent).toContain('$1.25');
    expect(cost?.getAttribute('title')).toMatch(/higher/);
    expect(chip.querySelector('.telemetry-chip-cost-flag')).not.toBeNull();
  });

  it('renders a Claude-only window exactly as before', () => {
    // The common case must not regress: no dash, no flag, no warning.
    const chip = _testing.renderWindowChip('Today', { ...totals, cost: 2.5 }, costAvailabilityFor(['claude']));
    const cost = chip.querySelector('.telemetry-chip-cost');
    expect(cost?.textContent).toContain('$2.50');
    expect(chip.querySelector('.telemetry-chip-cost-flag')).toBeNull();
    expect(cost?.className).not.toContain('unavailable');
  });

  it('renders an empty window as before rather than warning about nothing', () => {
    const chip = _testing.renderWindowChip('Today', { ...totals, cost: 0 }, costAvailabilityFor([]));
    expect(chip.querySelector('.telemetry-chip-cost')?.textContent).toContain('$0.00');
  });
});

describe('reasoning tokens as a breakdown, not an addend (HS-9607)', () => {
  it('phrases reasoning as "of that", since it is inside the output figure', () => {
    const body = _testing.renderBody(
      makePayload({ windowTotalsAllTime: { ...nonEmptyTotals(3), reasoningOutputTokens: 120 } }),
      'secretA',
    );
    expect(body.textContent).toContain('of that reasoning');
  });

  it('does not render a permanent "0 reasoning" line for tools that never report it', () => {
    // Every Claude dashboard would otherwise carry a zero forever, which is
    // noise, not information.
    const body = _testing.renderBody(makePayload(), 'secretA');
    expect(body.textContent).not.toContain('reasoning');
  });
});
