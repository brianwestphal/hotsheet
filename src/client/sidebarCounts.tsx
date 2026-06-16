/**
 * HS-8511 — sidebar view-count badges. Fetches the per-view ticket counts from
 * `GET /api/sidebar-counts` and writes a small count badge into each
 * `.sidebar-item[data-view]` (built-in views, category:* / priority:* views, the
 * special backlog/archive/trash views, and custom:* views). Refreshed alongside
 * the ticket list so the badges stay live as tickets move between views.
 */
import { getSidebarCounts } from '../api/index.js';
import { toElement } from './dom.js';

/**
 * Distribute a `viewId → count` map onto the rendered sidebar items. Pure DOM
 * (no fetch) so it's unit-testable. Creates the `.sidebar-count` badge on first
 * use; a count of 0 (or a view absent from the map) renders an empty,
 * `is-zero`-flagged badge so the layout stays stable without showing "0".
 */
export function applySidebarCounts(counts: Record<string, number>): void {
  for (const item of document.querySelectorAll<HTMLElement>('.sidebar-item[data-view]')) {
    const view = item.dataset.view;
    if (view === undefined || view === '') continue;
    const n = counts[view] ?? 0;
    let badge = item.querySelector<HTMLElement>('.sidebar-count');
    if (badge === null) {
      badge = toElement(<span className="sidebar-count" aria-hidden="true"></span>);
      item.appendChild(badge);
    }
    badge.textContent = n > 0 ? String(n) : '';
    badge.classList.toggle('is-zero', n === 0);
  }
}

/** Fetch the counts and apply them. Best-effort — a failure leaves the existing
 *  badges untouched rather than clearing them. */
async function fetchAndApplySidebarCounts(): Promise<void> {
  let counts: Record<string, number>;
  try {
    counts = (await getSidebarCounts()).counts;
  } catch {
    return;
  }
  applySidebarCounts(counts);
}

// HS-8809 — `refreshSidebarCounts` is called on every `updateStats()` (after each
// list render / ticket change) and every custom-view re-render, so a burst of
// changes used to fire a burst of `/sidebar-counts` requests (each of which runs
// a COUNT per custom view). Debounce on the trailing edge so a burst collapses
// into a single fetch.
const SIDEBAR_COUNT_DEBOUNCE_MS = 150;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Schedule a (debounced) refresh of the sidebar count badges. Rapid calls
 *  within the window coalesce into one fetch (the last call wins). */
export function refreshSidebarCounts(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void fetchAndApplySidebarCounts();
  }, SIDEBAR_COUNT_DEBOUNCE_MS);
}
