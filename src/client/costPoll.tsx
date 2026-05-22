import { api } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import { updateSidebarWidgetCost } from './dashboardMode.js';

/**
 * HS-8147 — per-project "today's cost" refresh loop. Subscribes to
 * the bell-state long-poll so cost refreshes piggyback on the cadence
 * the §67.10.1 ticket prescribed ("same as the existing tab-bell-state
 * poll").
 *
 * HS-8527 — the original surface was a small chip in every project
 * tab header; that chip is gone and the cost now lives in the sidebar
 * dashboard widget instead (right-aligned next to "N in progress").
 * We still fetch the bulk by-project map (same endpoint, same cost,
 * cheap to keep so the receiver can switch back to a per-tab surface
 * in the future without re-plumbing the route).
 *
 * Every bell-state tick fires an independent `GET /api/telemetry/today-cost-by-project`
 * fetch and pipes the response into `updateSidebarWidgetCost`. The
 * cost query is a single indexed SUM (one row per project with
 * non-zero cost today) so it's cheap to run alongside the bell poll.
 *
 * Subscribers fire immediately on subscribe with the current state,
 * which means the chip values populate on first paint without waiting
 * for the next poll cycle.
 */

let unsubscribe: (() => void) | null = null;

interface TodayCostByProjectResponse {
  costs: Record<string, number>;
}

async function refreshCostChips(): Promise<void> {
  try {
    const data = await api<TodayCostByProjectResponse>('/telemetry/today-cost-by-project');
    updateSidebarWidgetCost(data.costs);
  } catch {
    // Network hiccup / telemetry table absent → leave the value as-is.
    // The next tick will retry.
  }
}

/**
 * One-time init from `app.tsx`. Idempotent — subsequent calls swap
 * the existing subscription (no-op effect since the new one fires
 * immediately too).
 */
export function initCostPoll(): void {
  if (unsubscribe !== null) unsubscribe();
  unsubscribe = subscribeToBellState(() => {
    void refreshCostChips();
  });
}
