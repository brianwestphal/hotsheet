/**
 * §78 Announcer live mode (HS-8770) — per-project summarization call budget.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { _resetCallBudgetForTesting, LIVE_MAX_CALLS_PER_WINDOW, LIVE_WINDOW_MS, tryConsumeCall } from './callBudget.js';

afterEach(() => { _resetCallBudgetForTesting(); });

describe('live call budget (HS-8770)', () => {
  it('allows up to the cap within a window, then blocks', () => {
    _resetCallBudgetForTesting();
    for (let i = 0; i < LIVE_MAX_CALLS_PER_WINDOW; i++) {
      expect(tryConsumeCall('secA', 1000)).toBe(true);
    }
    expect(tryConsumeCall('secA', 1000)).toBe(false); // over budget
  });

  it('resets after the window elapses', () => {
    _resetCallBudgetForTesting();
    for (let i = 0; i < LIVE_MAX_CALLS_PER_WINDOW; i++) tryConsumeCall('secA', 1000);
    expect(tryConsumeCall('secA', 1000)).toBe(false);
    expect(tryConsumeCall('secA', 1000 + LIVE_WINDOW_MS)).toBe(true); // new window
  });

  it('budgets each project independently', () => {
    _resetCallBudgetForTesting();
    for (let i = 0; i < LIVE_MAX_CALLS_PER_WINDOW; i++) tryConsumeCall('secA', 1000);
    expect(tryConsumeCall('secA', 1000)).toBe(false);
    expect(tryConsumeCall('secB', 1000)).toBe(true); // secB has its own budget
  });
});
