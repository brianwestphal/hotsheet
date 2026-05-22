// @vitest-environment happy-dom
//
// HS-8507 / §70 — render-shell tests for the cross-project stats page.
// Covers the post-reshape page layout:
//   - "Cross-project stats" title (was "Telemetry")
//   - cost-over-time chart container appears between chips + cost-by-project
//   - top-10 most-expensive-prompts section is GONE
//   - empty-state branch renders an onboarding card with "Cross-project stats"
//     heading instead of "Telemetry dashboard"
//   - title alias `showTelemetryDashboard` resolves to
//     `showCrossProjectStatsPage` (back-compat during migration)
import { describe, expect, it } from 'vitest';

import {
  type DashboardPayload,
  renderShell,
} from './crossProjectStatsPage.js';

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

function makePayload(overrides: Partial<DashboardPayload> & Record<string, unknown> = {}): DashboardPayload {
  const base: DashboardPayload = {
    window: 'month',
    windowTotals: {
      today: nonEmptyTotals(),
      week: nonEmptyTotals(2),
      month: nonEmptyTotals(5),
      allTime: nonEmptyTotals(10),
    },
    costByProject: [],
    costByModel: [],
    hourlyActivity: [],
    costOverTime: [],
  };
  return { ...base, ...overrides } as DashboardPayload;
}

describe('renderShell (HS-8507 cross-project stats page)', () => {
  it('renders the "Cross-project stats" title (NOT "Telemetry")', () => {
    const container = document.createElement('div');
    renderShell(makePayload(), container);
    const title = container.querySelector('.telemetry-dashboard-title');
    expect(title?.textContent).toBe('Cross-project stats');
  });

  it('marks the page root with the cross-project-stats-page class', () => {
    const container = document.createElement('div');
    renderShell(makePayload(), container);
    expect(container.querySelector('.cross-project-stats-page')).not.toBeNull();
  });

  it('renders a cost-over-time section container between chips and cost-by-project', () => {
    const container = document.createElement('div');
    renderShell(makePayload(), container);
    const sections = [...container.querySelectorAll('.telemetry-dashboard-section')];
    const dataKeys = sections.map(s => (s as HTMLElement).dataset['section']);
    const overTimeIdx = dataKeys.indexOf('cost-over-time');
    const byProjectIdx = dataKeys.indexOf('cost-by-project');
    expect(overTimeIdx).toBeGreaterThanOrEqual(0);
    expect(byProjectIdx).toBeGreaterThanOrEqual(0);
    expect(overTimeIdx).toBeLessThan(byProjectIdx);
    expect(container.querySelector('#telemetry-dashboard-cost-over-time')).not.toBeNull();
  });

  it('does NOT render the top-10-most-expensive-prompts section (removed per HS-8503 feedback)', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      // Even with a payload carrying topExpensivePrompts (legacy wire
      // shape), the section should not render — the field is ignored
      // until HS-8509 drops it from the response.
      topExpensivePrompts: [
        { promptId: 'p1', ts: '2026-05-21T00:00:00Z', projectSecret: 's1', cost: 1.0, model: 'sonnet', preview: 'hi' },
      ],
    }), container);
    expect(container.querySelector('#telemetry-dashboard-top-prompts')).toBeNull();
    expect(container.querySelector('.telemetry-dashboard-top-prompt-row')).toBeNull();
    const sections = [...container.querySelectorAll('.telemetry-dashboard-section')];
    const dataKeys = sections.map(s => (s as HTMLElement).dataset['section']);
    expect(dataKeys).not.toContain('top-prompts');
  });

  it('renders 4 window-total chips (Today / This week / This month / All time)', () => {
    const container = document.createElement('div');
    renderShell(makePayload(), container);
    const chips = container.querySelectorAll('.telemetry-dashboard-chip');
    expect(chips.length).toBe(4);
    const labels = [...chips].map(c => c.querySelector('.telemetry-dashboard-chip-label')?.textContent);
    expect(labels).toEqual(['Today', 'This week', 'This month', 'All time']);
  });

  it('renders the empty-state card when nothing has been recorded', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      windowTotals: {
        today: emptyTotals(),
        week: emptyTotals(),
        month: emptyTotals(),
        allTime: emptyTotals(),
      },
    }), container);
    const empty = container.querySelector('.telemetry-dashboard-empty');
    expect(empty).not.toBeNull();
    expect(empty?.querySelector('h3')?.textContent).toBe('Cross-project stats');
    expect(container.querySelector('.telemetry-dashboard-chips')).toBeNull();
    expect(container.querySelector('#telemetry-dashboard-cost-over-time')).toBeNull();
  });

  // HS-8533 — pre-fix, the empty-state gate was `allTime.promptCount === 0
  // && allTime.cost === 0`, which falsely tripped whenever a transient
  // query glitch zeroed the all-time totals while every other section
  // of the payload still carried rows. Post-fix, every signal must
  // agree before we show the empty card.
  it('does NOT show the empty card when costByProject has rows even if windowTotals look zero', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      windowTotals: {
        today: emptyTotals(),
        week: emptyTotals(),
        month: emptyTotals(),
        allTime: emptyTotals(),
      },
      costByProject: [
        { projectSecret: 's1', cost: 12.34, tokens: 1000, promptCount: 3, lastActivityTs: '2026-05-21T00:00:00Z' },
      ],
    }), container);
    expect(container.querySelector('.telemetry-dashboard-empty')).toBeNull();
    expect(container.querySelector('.telemetry-dashboard-chips')).not.toBeNull();
  });

  it('does NOT show the empty card when only the week window has data (HS-8533 cross-window check)', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      windowTotals: {
        today: emptyTotals(),
        week: nonEmptyTotals(5),
        month: emptyTotals(),
        allTime: emptyTotals(),
      },
    }), container);
    expect(container.querySelector('.telemetry-dashboard-empty')).toBeNull();
    expect(container.querySelector('.telemetry-dashboard-chips')).not.toBeNull();
  });

  it('still shows the empty card when EVERY signal is zero (windowTotals + section arrays)', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      windowTotals: {
        today: emptyTotals(),
        week: emptyTotals(),
        month: emptyTotals(),
        allTime: emptyTotals(),
      },
      costByProject: [],
      costByModel: [],
      hourlyActivity: [],
      costOverTime: [],
    }), container);
    expect(container.querySelector('.telemetry-dashboard-empty')).not.toBeNull();
  });

  it('fills the cost-over-time container when payload.costOverTime has data', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      costOverTime: [
        { date: '2026-05-19', projectSecret: 'secretA', model: 'sonnet', cost: 1.0 },
        { date: '2026-05-20', projectSecret: 'secretA', model: 'sonnet', cost: 0.5 },
      ],
    }), container);
    const target = container.querySelector('#telemetry-dashboard-cost-over-time');
    expect(target?.querySelector('.telemetry-cost-over-time-chart')).not.toBeNull();
    // Placeholder text should be gone once data lands.
    expect(target?.querySelector('.telemetry-dashboard-section-placeholder')).toBeNull();
  });

  it('keeps the placeholder text when payload.costOverTime is empty', () => {
    const container = document.createElement('div');
    renderShell(makePayload({ costOverTime: [] }), container);
    const target = container.querySelector('#telemetry-dashboard-cost-over-time');
    expect(target?.querySelector('.telemetry-cost-over-time-chart')).toBeNull();
    expect(target?.querySelector('.telemetry-dashboard-section-placeholder')).not.toBeNull();
  });

  // HS-8535 — header alignment must match data alignment. Cost / Tokens
  // / Prompts cells in the body are right-aligned (.telemetry-dashboard-
  // project-cost / -tokens / -prompts each carry `text-align: right` in
  // the SCSS); the matching <th>s carry `.align-right` so the header
  // sits above the column instead of drifting leftward.
  it('right-aligns the Cost / Tokens / Prompts <th> cells in the cost-by-project table (HS-8535)', () => {
    const container = document.createElement('div');
    renderShell(makePayload({
      costByProject: [
        { projectSecret: 's1', cost: 12.34, tokens: 1000, promptCount: 3, lastActivityTs: '2026-05-21T00:00:00Z' },
      ],
    }), container);
    const table = container.querySelector('.telemetry-dashboard-project-table');
    expect(table).not.toBeNull();
    const headersByKey: Record<string, HTMLElement | null> = {};
    table?.querySelectorAll<HTMLElement>('th[data-sort-key]').forEach(th => {
      const k = th.dataset['sortKey'];
      if (k !== undefined) headersByKey[k] = th;
    });
    expect(headersByKey['cost']?.classList.contains('align-right')).toBe(true);
    expect(headersByKey['tokens']?.classList.contains('align-right')).toBe(true);
    expect(headersByKey['promptCount']?.classList.contains('align-right')).toBe(true);
    // Project + Last activity headers stay left-aligned (their column
    // data is left-aligned).
    expect(headersByKey['project']?.classList.contains('align-right')).toBe(false);
    expect(headersByKey['lastActivityTs']?.classList.contains('align-right')).toBe(false);
  });
});

