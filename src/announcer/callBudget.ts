/**
 * §78 Announcer live mode (HS-8770) — per-project summarization call budget.
 *
 * Live mode can fire a summarize on every burst of work; the `CoalescingTrigger`
 * already collapses bursts, but a steady stream could still spend faster than a
 * user expects. This caps actual Anthropic calls to `LIVE_MAX_CALLS_PER_WINDOW`
 * per rolling `LIVE_WINDOW_MS` per project. When the budget is spent the live
 * pass skips generation — the project cursor doesn't advance, so the deferred
 * work simply rolls into the next (larger, more-compressed) batch rather than
 * being lost. Pure module state + injectable `now`, so it's unit-tested.
 */
export const LIVE_MAX_CALLS_PER_WINDOW = 6;
export const LIVE_WINDOW_MS = 60_000;

interface BudgetWindow { count: number; windowStart: number }
const windows = new Map<string, BudgetWindow>();

/**
 * Try to spend one call for `secret`. Returns true (and records it) when under
 * budget for the current window; false when the budget is exhausted.
 */
export function tryConsumeCall(secret: string, now: number): boolean {
  const w = windows.get(secret);
  if (w === undefined || now - w.windowStart >= LIVE_WINDOW_MS) {
    windows.set(secret, { count: 1, windowStart: now });
    return true;
  }
  if (w.count >= LIVE_MAX_CALLS_PER_WINDOW) return false;
  w.count += 1;
  return true;
}

/** **TEST ONLY** — clear all budget windows. */
export function _resetCallBudgetForTesting(): void {
  windows.clear();
}
