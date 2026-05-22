/**
 * HS-8526 — shared "which full-window surface owns `#ticket-list` /
 * `#dashboard-container` right now?" flags. Lives in its own module
 * so `dashboardMode.tsx` and `crossProjectStatsPage.tsx` (each owns
 * one surface) can read each other's active flag without importing
 * the other (the surfaces ARE entry points — circular imports here
 * are a real problem at module-load time).
 *
 * Each surface owns its enter / exit logic and writes the flag at
 * the same time it mutates the DOM. When one surface takes over from
 * the other, it ALSO clears the other surface's flag synchronously
 * via the `mark*Supplanted` helper. The second-click-toggle handlers
 * read the flag to decide between "open" and "close + restore."
 *
 * The terminal dashboard (`terminalDashboard.tsx`) is orthogonal —
 * it renders into its own `#terminal-dashboard-root` element, not
 * `#ticket-list`, so it tracks its own active flag without coupling
 * into this module.
 */

let analyticsDashboardActive = false;
let crossProjectStatsActive = false;

export function isAnalyticsDashboardActive(): boolean {
  return analyticsDashboardActive;
}

export function isCrossProjectStatsPageActive(): boolean {
  return crossProjectStatsActive;
}

export function markAnalyticsDashboardActive(value: boolean): void {
  analyticsDashboardActive = value;
}

export function markCrossProjectStatsActive(value: boolean): void {
  crossProjectStatsActive = value;
}

/** Convenience aliases — read better at the callsite than the raw
 *  setters when the intent is "another surface just took over." */
export function markAnalyticsDashboardSupplanted(): void {
  analyticsDashboardActive = false;
}

export function markCrossProjectStatsSupplanted(): void {
  crossProjectStatsActive = false;
}

/** **TEST ONLY** — clear both flags between cases. */
export function _resetMainSurfaceStateForTesting(): void {
  analyticsDashboardActive = false;
  crossProjectStatsActive = false;
}
