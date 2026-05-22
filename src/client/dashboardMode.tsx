import { unmountColumnView } from './columnView.js';
import { renderDashboard, renderSidebarWidget } from './dashboard.js';
import { byId, byIdOrNull } from './dom.js';
import {
  isAnalyticsDashboardActive,
  isCrossProjectStatsPageActive,
  markAnalyticsDashboardActive,
  markCrossProjectStatsSupplanted,
} from './mainSurfaceState.js';
import { getActiveProject, state } from './state.js';
import { getTelemetryCostMode } from './telemetryCostMode.js';
import { unmountBindList } from './ticketList.js';

export { isAnalyticsDashboardActive, markAnalyticsDashboardSupplanted } from './mainSurfaceState.js';

const DASHBOARD_HIDDEN_IDS = ['search-input', 'layout-toggle', 'sort-select', 'detail-position-toggle', 'glassbox-btn'];

/** HS-8526 — the `state.view` that was active when the user first
 *  opened the analytics dashboard. Restored on the second-click
 *  toggle-off via `toggleDashboardMode`. Lives in this module rather
 *  than `mainSurfaceState.ts` because the "previous view" semantics
 *  only matter to this surface's restore-on-toggle-off path. */
let viewBeforeDashboard: string | null = null;

/** Restore the ticket list view from dashboard mode. */
export function restoreTicketList() {
  const dashContainer = byIdOrNull('dashboard-container');
  if (dashContainer) {
    // HS-8504 (follow-up) — the list-view bindList and column-view
    // disposers both track DOM nodes that are about to be wiped here.
    // Tear them down so the next render starts from a clean slate
    // rather than hitting same-key early-return paths in
    // `ensureBindListMount` / `renderColumnView` against detached DOM.
    // Without this, returning to the same view that was active before
    // entering the dashboard left the rebuilt container empty until
    // the user clicked a different view.
    unmountBindList();
    unmountColumnView();
    dashContainer.id = 'ticket-list';
    dashContainer.innerHTML = '';
    dashContainer.classList.remove('ticket-list-columns');
    exitDashboardMode();
  }
}

/** Enter dashboard mode: hide toolbar elements and render the dashboard. */
export function enterDashboardMode() {
  // HS-8516 — if we're already on another full-window surface that
  // renamed `#ticket-list` to `#dashboard-container` (the cross-
  // project stats page), normalize the id back to `#ticket-list`
  // first so `byId('ticket-list')` below succeeds. Without this the
  // call threw silently inside a document-level click listener and
  // the user saw "nothing happens" on the chip click.
  const existingDashContainer = byIdOrNull('dashboard-container');
  if (existingDashContainer !== null) {
    existingDashContainer.id = 'ticket-list';
    existingDashContainer.innerHTML = '';
    existingDashContainer.classList.remove('ticket-list-columns');
  }
  // HS-8526 + HS-8524 — if the cross-project stats page is the
  // surface currently visible, tear it down (clear body class + hide
  // root + drop active flag) so the analytics dashboard's
  // takeover doesn't compound on top of the still-visible cross-
  // project root. Pre-HS-8524 the cross-project page rendered into
  // `#dashboard-container` and the rename trick above tore it down;
  // post-HS-8524 it owns its own root + body class so we hand off
  // through `teardownCrossProjectStatsPage`. Lazy import to keep
  // the cross-project page out of the dashboard-mode initial
  // bundle.
  if (isCrossProjectStatsPageActive()) {
    void import('./crossProjectStatsPage.js').then(({ teardownCrossProjectStatsPage }) => {
      teardownCrossProjectStatsPage();
    }).catch(() => { /* module not present */ });
    markCrossProjectStatsSupplanted();
  }

  // HS-8526 — capture the view to restore on toggle-off. Skip when
  // re-entering (we don't want to overwrite the captured view with
  // 'dashboard' itself).
  if (!isAnalyticsDashboardActive() && state.view !== 'dashboard') {
    viewBeforeDashboard = state.view;
  }
  markAnalyticsDashboardActive(true);
  state.view = 'dashboard';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  // Hide toolbar elements
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = byIdOrNull(id);
    if (el) {
      const container = el.closest('.search-box, .layout-toggle, .sort-controls') || el;
      (container as HTMLElement).style.display = 'none';
    }
  }
  // Hide batch toolbar and detail panel
  const batchToolbar = byIdOrNull('batch-toolbar');
  if (batchToolbar) batchToolbar.style.display = 'none';
  const detailPanel = byIdOrNull('detail-panel');
  if (detailPanel) detailPanel.style.display = 'none';
  const resizeHandle = byIdOrNull('detail-resize-handle');
  if (resizeHandle) resizeHandle.style.display = 'none';

  const ticketList = byId('ticket-list');
  // HS-8504 (follow-up) — dispose any live bindList / column-view
  // disposers before wiping, mirroring the symmetric teardown in
  // `restoreTicketList`. Pre-fix the disposers kept references to
  // the wiped DOM and the next exit-back-to-list render saw stale
  // mount keys.
  unmountBindList();
  unmountColumnView();
  ticketList.innerHTML = '';
  ticketList.id = 'dashboard-container';
  ticketList.classList.remove('ticket-list-columns');
  void renderDashboard(ticketList);
}

function exitDashboardMode() {
  markAnalyticsDashboardActive(false);
  // Restore toolbar elements
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = byIdOrNull(id);
    if (el) {
      const container = el.closest('.search-box, .layout-toggle, .sort-controls') || el;
      (container as HTMLElement).style.display = '';
    }
  }
  // HS-8504 (follow-up) — restore batch-toolbar visibility. Pre-fix
  // `enterDashboardMode` set it to display:none but only the list-view
  // `renderTicketList` branch restored it; column-view returned with
  // the toolbar still hidden until the app was restarted.
  const batchToolbar = byIdOrNull('batch-toolbar');
  if (batchToolbar) batchToolbar.style.display = '';
  // Detail panel and resize handle are restored by syncDetailPanel on next render
}

/** HS-8526 — toggle the analytics dashboard. Second click on the
 *  sidebar widget restores the `state.view` that was active when the
 *  user first opened the dashboard. Re-uses the sidebar-item click
 *  path (matching `bindSidebar`'s handler) so view restoration goes
 *  through exactly the same sequence as a user-driven view switch:
 *  clear selection, restore toolbar visibility, `loadTickets()`, etc.
 *  Falls back to the "All" view when the captured view no longer maps
 *  to a sidebar item (e.g. a custom view that was deleted in the
 *  meantime). */
export function toggleDashboardMode(): void {
  if (isAnalyticsDashboardActive()) {
    const target = viewBeforeDashboard ?? 'all';
    const item = document.querySelector<HTMLElement>(`.sidebar-item[data-view="${target}"]`)
      ?? document.querySelector<HTMLElement>('.sidebar-item[data-view="all"]');
    if (item !== null) {
      item.click();
      return;
    }
    // Last-resort fallback — exit without a target view. Leaves
    // `state.view` as 'dashboard' which the next sidebar click will
    // fix; this branch is unreachable in practice since the "All"
    // sidebar item is hard-coded into `pages.tsx`.
    restoreTicketList();
    return;
  }
  enterDashboardMode();
}

/** HS-8527 — position the dashboard widget directly below the git
 *  status chip (was previously appended after the bottom-of-sidebar
 *  `#stats-bar`). The git chip itself toggles visibility based on
 *  whether the project is a git repo; the widget renders unconditionally
 *  so its position stays stable across non-git projects (it just falls
 *  in next-after the channel-play section instead). */
function placeDashboardWidget(widget: HTMLElement): void {
  const gitChip = byIdOrNull('sidebar-git-chip');
  if (gitChip !== null) {
    gitChip.after(widget);
    return;
  }
  const statsBar = byIdOrNull('stats-bar');
  if (statsBar !== null) statsBar.after(widget);
}

/** Initialize the dashboard sidebar widget and return the click handler. */
export async function initDashboardWidget() {
  const widget = await renderSidebarWidget();
  placeDashboardWidget(widget);
  // HS-8526 — toggle: click while in dashboard mode restores the
  // previous view; click otherwise enters dashboard mode.
  widget.addEventListener('click', () => toggleDashboardMode());
  refreshSidebarWidgetCost();
}

/** Refresh the sidebar widget with the active project's data. */
export async function refreshDashboardWidget() {
  const existing = byIdOrNull('sidebar-dashboard-widget');
  if (!existing) return;
  const fresh = await renderSidebarWidget();
  fresh.addEventListener('click', () => toggleDashboardMode());
  existing.replaceWith(fresh);
  refreshSidebarWidgetCost();
}

// --- HS-8527 — sidebar cost element ----------------------------------

/** Most recently observed `today-cost-by-project` map. Cached so the
 *  widget repopulates immediately after re-render without waiting for
 *  the next bell-state tick. */
let lastCostsForSidebar: Record<string, number> = {};

/** Update the active project's cost in the sidebar widget. `costs` is
 *  the bulk `/api/telemetry/today-cost-by-project` response keyed by
 *  project secret. A secret missing from the map (or zero) hides the
 *  cost span; subscription billing-mode also hides it (the dollar
 *  amount is an API-equivalent estimate, not what the user pays). */
export function updateSidebarWidgetCost(costs: Record<string, number>): void {
  lastCostsForSidebar = costs;
  const el = document.querySelector<HTMLElement>('.sidebar-widget-cost');
  if (el === null) return;
  const secret = getActiveProject()?.secret ?? '';
  const cost = costs[secret] ?? 0;
  const mode = getTelemetryCostMode();
  if (cost > 0 && mode === 'api') {
    el.textContent = cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
    el.style.display = '';
  } else {
    el.textContent = '';
    el.style.display = 'none';
  }
}

/** Re-render the sidebar cost using the cached map. Called after the
 *  widget is re-mounted (project switch) and from the Settings dialog
 *  immediately after a billing-mode change. */
export function refreshSidebarWidgetCost(): void {
  updateSidebarWidgetCost(lastCostsForSidebar);
}
