/** HS-9131 — full-window surface ownership flags (`mainSurfaceState.ts`). */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _resetMainSurfaceStateForTesting,
  isAnalyticsDashboardActive,
  isCrossProjectStatsPageActive,
  markAnalyticsDashboardActive,
  markAnalyticsDashboardSupplanted,
  markCrossProjectStatsActive,
  markCrossProjectStatsSupplanted,
} from './mainSurfaceState.js';

beforeEach(() => { _resetMainSurfaceStateForTesting(); });

describe('mainSurfaceState', () => {
  it('both flags default false', () => {
    expect(isAnalyticsDashboardActive()).toBe(false);
    expect(isCrossProjectStatsPageActive()).toBe(false);
  });
  it('mark* setters flip the matching flag', () => {
    markAnalyticsDashboardActive(true);
    expect(isAnalyticsDashboardActive()).toBe(true);
    markCrossProjectStatsActive(true);
    expect(isCrossProjectStatsPageActive()).toBe(true);
  });
  it('supplant helpers clear the matching flag', () => {
    markAnalyticsDashboardActive(true);
    markCrossProjectStatsActive(true);
    markAnalyticsDashboardSupplanted();
    expect(isAnalyticsDashboardActive()).toBe(false);
    markCrossProjectStatsSupplanted();
    expect(isCrossProjectStatsPageActive()).toBe(false);
  });
  it('reset clears both', () => {
    markAnalyticsDashboardActive(true);
    markCrossProjectStatsActive(true);
    _resetMainSurfaceStateForTesting();
    expect(isAnalyticsDashboardActive()).toBe(false);
    expect(isCrossProjectStatsPageActive()).toBe(false);
  });
});
