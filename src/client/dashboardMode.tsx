import { unmountColumnView } from './columnView.js';
import { renderDashboard, renderSidebarWidget } from './dashboard.js';
import { byId, byIdOrNull } from './dom.js';
import { state } from './state.js';
import { unmountBindList } from './ticketList.js';

const DASHBOARD_HIDDEN_IDS = ['search-input', 'layout-toggle', 'sort-select', 'detail-position-toggle', 'glassbox-btn'];

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

/** Initialize the dashboard sidebar widget and return the click handler. */
export async function initDashboardWidget() {
  const widget = await renderSidebarWidget();
  const statsBar = byIdOrNull('stats-bar');
  if (statsBar) statsBar.after(widget);
  widget.addEventListener('click', () => enterDashboardMode());
}

/** Refresh the sidebar widget with the active project's data. */
export async function refreshDashboardWidget() {
  const existing = byIdOrNull('sidebar-dashboard-widget');
  if (!existing) return;
  const fresh = await renderSidebarWidget();
  fresh.addEventListener('click', () => enterDashboardMode());
  existing.replaceWith(fresh);
}
