import { api } from './api.js';
import { subscribeToBellState } from './bellPoll.js';
import { updateProjectCostChips } from './projectTabs.js';

/**
 * HS-8147 — per-project "today's cost" chip refresh loop. Subscribes
 * to the bell-state long-poll so chip refreshes piggyback on the
 * cadence the §67.10.1 ticket prescribed ("same as the existing
 * tab-bell-state poll").
 *
 * We don't introduce a new timer or new long-poll endpoint — every
 * bell-state tick fires an independent `GET /api/telemetry/today-cost-by-project`
 * fetch and pipes the response into `updateProjectCostChips`. The
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
    updateProjectCostChips(data.costs);
  } catch {
    // Network hiccup / telemetry table absent → leave chips as-is.
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
