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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ApiTransport, setApiTransport } from '../api/_runner.js';
import { api } from './api.js';
import {
  _testingHS8572,
  type DashboardPayload,
  renderShell,
  resolveProjectName,
  showCrossProjectStatsPage,
  teardownCrossProjectStatsPage,
} from './crossProjectStatsPage.js';
import { _resetMainSurfaceStateForTesting, markAnalyticsDashboardActive } from './mainSurfaceState.js';
import { _setProjectsForTesting } from './projectTabs.js';
import type { ProjectInfo } from './state.js';

// HS-8576 — the re-open-blank regression test drives `fetchAndRender`, which
// hits the network helper. Stub it so the test stays a pure DOM unit test.
// (`vi.mock` is hoisted above the imports by vitest's transform regardless of
// its position here, so keeping it below the imports satisfies `import/first`.)
vi.mock('./api.js', () => ({ api: vi.fn() }));

// HS-8632 — the page fetches via the typed `getTelemetryDashboard` (→ `_runner`
// transport). Route the transport at the same `api` mock so the existing
// `vi.mocked(api).mockResolvedValue(...)` payload control + assertions hold.
beforeEach(() => { setApiTransport((path, opts) => vi.mocked(api)(path, opts)); });
afterEach(() => { setApiTransport(null as unknown as ApiTransport); });

interface WindowTotals {
  cost: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  promptCount: number;
}

function emptyTotals(): WindowTotals {
  return { cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, promptCount: 0 };
}

function nonEmptyTotals(cost = 1): WindowTotals {
  return { cost, tokens: 1000, inputTokens: 700, outputTokens: 300, promptCount: 5 };
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

  // HS-8543 — every chrome render carries the always-visible
  // subscription-cost disclaimer above the chips. Distinct from the
  // HS-8497 `.telemetry-subscription-notice` which only fires when
  // `cost_mode === 'subscription'`.
  it('renders the subscription-cost disclaimer above the window-totals chips (HS-8543)', () => {
    const container = document.createElement('div');
    renderShell(makePayload(), container);
    const disclaimer = container.querySelector('.telemetry-subscription-disclaimer');
    expect(disclaimer).not.toBeNull();
    expect(disclaimer?.textContent ?? '').toMatch(/subscription/i);
    expect(disclaimer?.textContent ?? '').toMatch(/estimate/i);
    // Order: disclaimer must precede the chips row.
    const root = container.querySelector('.cross-project-stats-page');
    expect(root).not.toBeNull();
    const chips = root?.querySelector('.telemetry-dashboard-chips');
    expect(disclaimer?.compareDocumentPosition(chips as Node) ?? 0)
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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

// HS-8576 — the cross-project stats page rendered fully blank when re-opened
// after a prior visit. Root cause: `#cross-project-stats-root` is a single
// reused element, the lifecycle teardown empties it via `replaceChildren()`
// without clearing the `lastPaintedFor` paint-skip record (HS-8572), so on
// re-open with unchanged data BOTH `fetchAndRender` short-circuits fired and
// nothing was painted into the just-emptied root. The fix gates the paint-skip
// on the container actually still holding content (`isPaintCurrent`).
describe('fetchAndRender — re-paints after the container is externally emptied (HS-8576)', () => {
  beforeEach(() => {
    _testingHS8572.reset();
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    _testingHS8572.reset();
  });

  it('repaints an unchanged cached payload into an emptied container instead of leaving it blank', async () => {
    const payload = makePayload();
    vi.mocked(api).mockResolvedValue(payload);

    const container = document.createElement('div');

    // First open: fetch + paint.
    await _testingHS8572.fetchAndRender(container, 'month');
    expect(container.querySelector('.cross-project-stats-page')).not.toBeNull();
    expect(container.childElementCount).toBeGreaterThan(0);

    // Simulate the lifecycle teardown emptying the reused root element
    // (showCrossProjectStatsPage / hide / teardown all call replaceChildren()).
    // `lastPaintedFor` still records the previous paint — the stale state that
    // caused the blank page.
    container.replaceChildren();
    expect(container.childElementCount).toBe(0);

    // Re-open with the SAME (cached + unchanged) payload. Pre-fix this left the
    // container blank; the fix must repaint it.
    await _testingHS8572.fetchAndRender(container, 'month');
    expect(container.querySelector('.cross-project-stats-page')).not.toBeNull();
    expect(container.childElementCount).toBeGreaterThan(0);
  });

  it('still skips a redundant repaint while the content is on-screen (optimization intact)', async () => {
    const payload = makePayload();
    vi.mocked(api).mockResolvedValue(payload);

    const container = document.createElement('div');
    await _testingHS8572.fetchAndRender(container, 'month');
    const firstRoot = container.querySelector('.cross-project-stats-page');
    expect(firstRoot).not.toBeNull();

    // A poll-tick re-fetch with identical data must NOT rebuild the DOM (so
    // sort / scroll / hover state survives) — the same root node should remain.
    await _testingHS8572.fetchAndRender(container, 'month');
    const secondRoot = container.querySelector('.cross-project-stats-page');
    expect(secondRoot).toBe(firstRoot);
  });
});

// HS-8622 — the "Cost by project" table labels each row via resolveProjectName.
// Telemetry rows outlive the project that produced them, so a closed /
// unregistered project's secret can't resolve to a name. Pre-fix we showed the
// bare 8-char hex prefix (e.g. "116305a6"), which reads as a "weird project
// name"; the fix labels it as an unknown project while keeping the prefix.
describe('resolveProjectName (HS-8622)', () => {
  const NAMED: ProjectInfo = { name: 'Glassbox', dataDir: '/Users/x/Documents/glassbox', secret: 'sec-named' };
  const NAMELESS: ProjectInfo = { name: '', dataDir: '/Users/x/Documents/cue-car', secret: 'sec-nameless' };

  beforeEach(() => { _setProjectsForTesting([NAMED, NAMELESS], NAMED.secret); });
  afterEach(() => { _setProjectsForTesting([], null); });

  it('returns the registered project name', () => {
    expect(resolveProjectName('sec-named')).toBe('Glassbox');
  });

  it('falls back to the dataDir basename when the name is empty', () => {
    expect(resolveProjectName('sec-nameless')).toBe('cue-car');
  });

  it('labels an unknown/closed project clearly, keeping the short prefix for disambiguation', () => {
    const name = resolveProjectName('116305a6deadbeefcafef00d');
    expect(name).toBe('Unknown project (116305a6)');
    // The bare hex prefix must NOT be the whole label (the reported bug).
    expect(name).not.toBe('116305a6');
  });
});

// HS-8626 — "toolbar controls have gone missing." When the cross-project stats
// page supplants an ACTIVE analytics dashboard, it must restore the header
// controls the dashboard hid — `restoreTicketList`'s own restore is gated on
// `#dashboard-container` still existing, which this path renames away, so the
// restore has to happen in the supplant path itself. Pre-fix
// `exitDashboardModeIfActive` only claimed (in a comment) to restore them.
describe('showCrossProjectStatsPage restores dashboard-hidden controls when supplanting (HS-8626)', () => {
  afterEach(() => {
    teardownCrossProjectStatsPage(); // stops the live-refresh poll
    _resetMainSurfaceStateForTesting();
    _testingHS8572.reset();
    document.body.innerHTML = '';
  });

  it('un-hides search / layout / sort / detail-position after taking over the analytics dashboard', () => {
    vi.mocked(api).mockResolvedValue(makePayload());

    // Simulate the state the analytics dashboard leaves behind: the header
    // controls hidden, `#ticket-list` renamed to `#dashboard-container`, and
    // the analytics-active flag set. Plus the cross-project root to render into.
    document.body.innerHTML = `
      <div class="header-controls">
        <div class="search-box" style="display:none"><input id="search-input" /></div>
        <div class="layout-toggle" id="layout-toggle" style="display:none"></div>
        <select id="sort-select" style="display:none"></select>
        <div class="layout-toggle" id="detail-position-toggle" style="display:none"></div>
        <button id="glassbox-btn" style="display:none"></button>
      </div>
      <div id="dashboard-container"></div>
      <div id="cross-project-stats-root" style="display:none"></div>
    `;
    markAnalyticsDashboardActive(true);

    showCrossProjectStatsPage();

    // The supplant path must have restored every hidden control (asserted on
    // the wrapper element that actually toggles, per pages.tsx structure).
    const searchBox = document.querySelector<HTMLElement>('.search-box')!;
    expect(searchBox.style.display).toBe('');
    expect(document.getElementById('layout-toggle')!.style.display).toBe('');
    expect(document.getElementById('sort-select')!.style.display).toBe('');
    expect(document.getElementById('detail-position-toggle')!.style.display).toBe('');
    expect(document.getElementById('glassbox-btn')!.style.display).toBe('');
    // And the dashboard container was renamed back to the ticket list.
    expect(document.getElementById('dashboard-container')).toBeNull();
    expect(document.getElementById('ticket-list')).not.toBeNull();
  });
});

