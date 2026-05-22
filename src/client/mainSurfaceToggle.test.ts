// @vitest-environment happy-dom
/**
 * HS-8526 — second click on the project stats buttons (the sidebar
 * analytics-dashboard widget + the cross-project stats header
 * button) should restore the surface that was visible when the
 * button was first clicked. Mirrors the toggle behavior of the
 * `#terminal-dashboard-toggle` button.
 *
 * These tests pin the surface-flag state machine in
 * `mainSurfaceState.ts` (the shared active-flag store both surfaces
 * read + write to coordinate the takeover/restore handoff). The
 * full enter/exit DOM paths in `dashboardMode.tsx` +
 * `crossProjectStatsPage.tsx` depend on a lot of additional state
 * (`state.view`, sidebar items, project tabs, /api fetches) that
 * aren't easily mocked in a happy-dom harness; the state-machine
 * test pins the contract that the user-visible toggle relies on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetMainSurfaceStateForTesting,
  isAnalyticsDashboardActive,
  isCrossProjectStatsPageActive,
  markAnalyticsDashboardActive,
  markAnalyticsDashboardSupplanted,
  markCrossProjectStatsActive,
  markCrossProjectStatsSupplanted,
} from './mainSurfaceState.js';

beforeEach(() => {
  _resetMainSurfaceStateForTesting();
});

afterEach(() => {
  _resetMainSurfaceStateForTesting();
});

describe('mainSurfaceState — analytics dashboard + cross-project stats coordination', () => {
  it('starts with both flags false', () => {
    expect(isAnalyticsDashboardActive()).toBe(false);
    expect(isCrossProjectStatsPageActive()).toBe(false);
  });

  it('analytics-dashboard active flag flips with markAnalyticsDashboardActive', () => {
    markAnalyticsDashboardActive(true);
    expect(isAnalyticsDashboardActive()).toBe(true);
    expect(isCrossProjectStatsPageActive()).toBe(false);

    markAnalyticsDashboardActive(false);
    expect(isAnalyticsDashboardActive()).toBe(false);
  });

  it('cross-project stats active flag flips with markCrossProjectStatsActive', () => {
    markCrossProjectStatsActive(true);
    expect(isCrossProjectStatsPageActive()).toBe(true);
    expect(isAnalyticsDashboardActive()).toBe(false);

    markCrossProjectStatsActive(false);
    expect(isCrossProjectStatsPageActive()).toBe(false);
  });

  it('cross-project takeover clears the analytics-dashboard flag via the supplanted helper', () => {
    // Simulate: user opens analytics dashboard, then clicks the
    // cross-project stats header button. The cross-project entry
    // path calls markAnalyticsDashboardSupplanted() so a subsequent
    // sidebar-widget click is treated as "open from scratch"
    // (not "second click while active").
    markAnalyticsDashboardActive(true);
    markCrossProjectStatsActive(true);
    markAnalyticsDashboardSupplanted();

    expect(isAnalyticsDashboardActive()).toBe(false);
    expect(isCrossProjectStatsPageActive()).toBe(true);
  });

  it('analytics-dashboard takeover clears the cross-project flag via the supplanted helper', () => {
    // Symmetric: user is on cross-project stats, clicks the
    // sidebar widget. The dashboard entry path calls
    // markCrossProjectStatsSupplanted() so the next header-button
    // click is "open from scratch" rather than "second click."
    markCrossProjectStatsActive(true);
    markAnalyticsDashboardActive(true);
    markCrossProjectStatsSupplanted();

    expect(isCrossProjectStatsPageActive()).toBe(false);
    expect(isAnalyticsDashboardActive()).toBe(true);
  });

  it('reset clears both flags (test helper)', () => {
    markAnalyticsDashboardActive(true);
    markCrossProjectStatsActive(true);
    _resetMainSurfaceStateForTesting();
    expect(isAnalyticsDashboardActive()).toBe(false);
    expect(isCrossProjectStatsPageActive()).toBe(false);
  });
});
