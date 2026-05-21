// @vitest-environment happy-dom
/**
 * HS-8495 — regression tests for the Telemetry drawer renderer. Pins the
 * "DOM elements cannot be passed as children" bug closed: `renderPayload`
 * previously embedded `renderScopeToggle()` + `renderEmptyState()` (both
 * return DOM nodes built via `toElement`) as JSX children inside another
 * `toElement(...)` call, which throws because the JSX runtime renders to
 * HTML strings. The bug manifested only in the empty-data branch (no
 * telemetry rows yet), which is the first thing a user sees after
 * enabling telemetry.
 *
 * Tests exercise the full `renderPayload` surface in both the no-data and
 * with-data branches to ensure every helper that returns a DOM element
 * stays inside an `appendChild` call, not embedded as JSX children.
 */
import { describe, expect, it } from 'vitest';

import { _setTelemetryCostModeForTesting } from './telemetryCostMode.js';
import { _testing } from './telemetryDrawer.js';

const { renderPayload } = _testing;

const EMPTY_TOTALS = { cost: 0, tokens: 0, promptCount: 0 };

const NONEMPTY_TOTALS = { cost: 1.23, tokens: 4567, promptCount: 12 };

describe('renderPayload — empty-data branch (HS-8495 regression)', () => {
  it('does not throw when the payload has no telemetry data', () => {
    const payload = {
      today: EMPTY_TOTALS,
      thisWeek: EMPTY_TOTALS,
      allTime: EMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    expect(() => renderPayload(payload)).not.toThrow();
  });

  it('renders the scope toggle AND the empty-state hint when no data is present', () => {
    const payload = {
      today: EMPTY_TOTALS,
      thisWeek: EMPTY_TOTALS,
      allTime: EMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    const root = renderPayload(payload);
    expect(root.querySelector('.telemetry-scope-toggle')).not.toBeNull();
    expect(root.querySelector('.telemetry-empty')).not.toBeNull();
    expect(root.querySelectorAll('.telemetry-scope-btn').length).toBe(2);
  });

  it('treats zero-cost zero-prompt as empty even when sub-totals exist', () => {
    const payload = {
      today: EMPTY_TOTALS,
      thisWeek: { cost: 0, tokens: 100, promptCount: 0 },
      allTime: { cost: 0, tokens: 100, promptCount: 0 },
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    const root = renderPayload(payload);
    expect(root.querySelector('.telemetry-empty')).not.toBeNull();
  });

  // HS-8496 — pin the layout-driving class names + structure of the empty
  // state so a future refactor cannot silently strip the hooks the SCSS
  // uses to vertically center the message + paint the onboarding card.
  // (Visual centering itself is verified manually; happy-dom does not
  // compute layout.)
  it('wraps the empty state in `.telemetry-drawer-content` so the flex container can stretch it', () => {
    const payload = {
      today: EMPTY_TOTALS,
      thisWeek: EMPTY_TOTALS,
      allTime: EMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    const root = renderPayload(payload);
    expect(root.classList.contains('telemetry-drawer-content')).toBe(true);
    const empty = root.querySelector('.telemetry-empty');
    expect(empty).not.toBeNull();
    // The empty card must be a direct child of the drawer-content flex
    // container — otherwise `flex: 1` on `.telemetry-empty` cannot stretch
    // it to fill the drawer's vertical space.
    expect(empty?.parentElement).toBe(root);
  });

  it('renders the empty-state heading and hint as separate elements so the SCSS can style them distinctly', () => {
    const payload = {
      today: EMPTY_TOTALS,
      thisWeek: EMPTY_TOTALS,
      allTime: EMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    const root = renderPayload(payload);
    const empty = root.querySelector('.telemetry-empty');
    expect(empty).not.toBeNull();
    const paragraphs = empty?.querySelectorAll('p') ?? [];
    expect(paragraphs.length).toBe(2);
    expect(paragraphs[0]?.classList.contains('telemetry-empty-hint')).toBe(false);
    expect(paragraphs[1]?.classList.contains('telemetry-empty-hint')).toBe(true);
    // The hint paragraph should reference the user-action `claude` binary
    // inside an inline `<code>` so the SCSS pill-styling applies.
    expect(paragraphs[1]?.querySelector('code')?.textContent).toBe('claude');
  });
});

describe('renderPayload — with-data branch', () => {
  it('does not throw when payload has data and renders the window chips + scope toggle', () => {
    const payload = {
      today: NONEMPTY_TOTALS,
      thisWeek: NONEMPTY_TOTALS,
      allTime: NONEMPTY_TOTALS,
      costByModel: [{ model: 'sonnet-4', cost: 1.0, tokens: 1000, promptCount: 3 }],
      toolRollup: [{ tool: 'bash', count: 5, avgDurationMs: 120 }],
      toolLatencyHistogram: [{
        tool: 'bash',
        count: 5,
        totalMs: 600,
        p50: 100,
        p90: 200,
        p99: 250,
        buckets: [0, 1, 2, 1, 1, 0, 0, 0],
      }],
      querySourceRollup: [{ source: 'cli', cost: 1.0, tokens: 1000, promptCount: 3 }],
      recentPrompts: [{ promptId: 'prompt-abcdef123456', ts: '2026-05-21T10:00:00Z', projectSecret: 's', model: 'sonnet-4' }],
    };
    expect(() => renderPayload(payload)).not.toThrow();

    const root = renderPayload(payload);
    expect(root.querySelector('.telemetry-scope-toggle')).not.toBeNull();
    expect(root.querySelectorAll('.telemetry-chip').length).toBe(3);
    expect(root.querySelector('.telemetry-window-chips')).not.toBeNull();
  });

  it('renders by-model, by-tool, histogram, by-source, and recent-prompts sections when data is present', () => {
    const payload = {
      today: NONEMPTY_TOTALS,
      thisWeek: NONEMPTY_TOTALS,
      allTime: NONEMPTY_TOTALS,
      costByModel: [{ model: 'sonnet-4', cost: 1.0, tokens: 1000, promptCount: 3 }],
      toolRollup: [{ tool: 'bash', count: 5, avgDurationMs: 120 }],
      toolLatencyHistogram: [{
        tool: 'bash',
        count: 5,
        totalMs: 600,
        p50: 100,
        p90: 200,
        p99: 250,
        buckets: [0, 1, 2, 1, 1, 0, 0, 0],
      }],
      querySourceRollup: [{ source: 'cli', cost: 1.0, tokens: 1000, promptCount: 3 }],
      recentPrompts: [{ promptId: 'prompt-abcdef123456', ts: '2026-05-21T10:00:00Z', projectSecret: 's', model: 'sonnet-4' }],
    };
    const root = renderPayload(payload);
    // 5 sections (model + tool + histogram + source + prompts).
    expect(root.querySelectorAll('section.telemetry-section').length).toBe(5);
    expect(root.querySelectorAll('#telemetry-tbody-model tr').length).toBe(1);
    expect(root.querySelectorAll('#telemetry-tbody-tool tr').length).toBe(1);
    expect(root.querySelectorAll('#telemetry-tbody-source tr').length).toBe(1);
    expect(root.querySelectorAll('.telemetry-recent-prompt').length).toBe(1);
    expect(root.querySelectorAll('.telemetry-histogram-row').length).toBe(1);
  });

  // HS-8498 — pin the with-data layout structure so a future refactor
  // cannot silently strip the grid + card class hooks the SCSS uses.
  // (Visual layout itself is verified manually; happy-dom does not
  // compute grid layout.)
  it('places the window-chips row and every section as direct children of the drawer-content flex container', () => {
    const payload = {
      today: NONEMPTY_TOTALS,
      thisWeek: NONEMPTY_TOTALS,
      allTime: NONEMPTY_TOTALS,
      costByModel: [{ model: 'sonnet-4', cost: 1.0, tokens: 1000, promptCount: 3 }],
      toolRollup: [{ tool: 'bash', count: 5, avgDurationMs: 120 }],
      toolLatencyHistogram: [],
      querySourceRollup: [{ source: 'cli', cost: 1.0, tokens: 1000, promptCount: 3 }],
      recentPrompts: [{ promptId: 'p-abc', ts: '2026-05-21T10:00:00Z', projectSecret: 's', model: 'sonnet-4' }],
    };
    const root = renderPayload(payload);
    expect(root.classList.contains('telemetry-drawer-content')).toBe(true);
    const chipsRow = root.querySelector('.telemetry-window-chips');
    expect(chipsRow).not.toBeNull();
    expect(chipsRow?.parentElement).toBe(root);
    // Every section must be a direct child of the drawer-content container
    // so the gap-based vertical rhythm applies uniformly.
    for (const sec of root.querySelectorAll('section.telemetry-section')) {
      expect(sec.parentElement).toBe(root);
    }
    // Every chip in the window-chips row carries the label + cost + meta
    // triplet the SCSS styles as a vertical stack.
    for (const chip of root.querySelectorAll('.telemetry-chip')) {
      expect(chip.querySelector('.telemetry-chip-label')).not.toBeNull();
      expect(chip.querySelector('.telemetry-chip-cost')).not.toBeNull();
      expect(chip.querySelector('.telemetry-chip-meta')).not.toBeNull();
    }
  });

  // HS-8497 — subscription-mode banner appears only when the global
  // cost mode is `'subscription'`. Pins the gating + the link element
  // so a future refactor cannot silently break the wiring that lets
  // the user open Settings → Telemetry from the banner.
  it('hides the subscription notice in api mode (HS-8497)', () => {
    _setTelemetryCostModeForTesting('api');
    const payload = {
      today: NONEMPTY_TOTALS,
      thisWeek: NONEMPTY_TOTALS,
      allTime: NONEMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    const root = renderPayload(payload);
    expect(root.querySelector('.telemetry-subscription-notice')).toBeNull();
  });

  it('renders the subscription notice in subscription mode for both branches (HS-8497)', () => {
    _setTelemetryCostModeForTesting('subscription');
    // With-data branch.
    const withData = renderPayload({
      today: NONEMPTY_TOTALS,
      thisWeek: NONEMPTY_TOTALS,
      allTime: NONEMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    });
    expect(withData.querySelector('.telemetry-subscription-notice')).not.toBeNull();
    expect(withData.querySelector('.telemetry-subscription-notice-link')).not.toBeNull();
    // Empty-data branch.
    const empty = renderPayload({
      today: EMPTY_TOTALS,
      thisWeek: EMPTY_TOTALS,
      allTime: EMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    });
    expect(empty.querySelector('.telemetry-subscription-notice')).not.toBeNull();
    // Reset so the rest of the suite sees the default.
    _setTelemetryCostModeForTesting('api');
  });

  it('skips empty sections without crashing', () => {
    const payload = {
      today: NONEMPTY_TOTALS,
      thisWeek: NONEMPTY_TOTALS,
      allTime: NONEMPTY_TOTALS,
      costByModel: [],
      toolRollup: [],
      toolLatencyHistogram: [],
      querySourceRollup: [],
      recentPrompts: [],
    };
    const root = renderPayload(payload);
    expect(root.querySelectorAll('section.telemetry-section').length).toBe(0);
    expect(root.querySelector('.telemetry-window-chips')).not.toBeNull();
  });
});
