import { renderDashboard, renderSidebarWidget } from './dashboard.js';
import { state } from './state.js';

const DASHBOARD_HIDDEN_IDS = ['search-input', 'layout-toggle', 'sort-select', 'detail-position-toggle', 'glassbox-btn'];

/** Restore the ticket list view from dashboard mode. */
export function restoreTicketList() {
  const dashContainer = document.getElementById('dashboard-container');
  if (dashContainer) {
    dashContainer.id = 'ticket-list';
    dashContainer.innerHTML = '';
    exitDashboardMode();
  }
}

/** Enter dashboard mode: hide toolbar elements and render the dashboard. */
export function enterDashboardMode() {
  state.view = 'dashboard';
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
  // Hide toolbar elements
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = document.getElementById(id);
    if (el) {
      const container = el.closest('.search-box, .layout-toggle, .sort-controls') || el;
      (container as HTMLElement).style.display = 'none';
    }
  }
  // Hide batch toolbar and detail panel
  const batchToolbar = document.getElementById('batch-toolbar');
  if (batchToolbar) batchToolbar.style.display = 'none';
  const detailPanel = document.getElementById('detail-panel');
  if (detailPanel) detailPanel.style.display = 'none';
  const resizeHandle = document.getElementById('detail-resize-handle');
  if (resizeHandle) resizeHandle.style.display = 'none';

  const ticketList = document.getElementById('ticket-list')!;
  ticketList.innerHTML = '';
  ticketList.id = 'dashboard-container';
  ticketList.classList.remove('ticket-list-columns');
  void renderDashboard(ticketList);
}

function exitDashboardMode() {
  // Restore toolbar elements
  for (const id of DASHBOARD_HIDDEN_IDS) {
    const el = document.getElementById(id);
    if (el) {
      const container = el.closest('.search-box, .layout-toggle, .sort-controls') || el;
      (container as HTMLElement).style.display = '';
    }
  }
  restoreTicketList();
  // Detail panel and resize handle are restored by syncDetailPanel on next render
}

/** Initialize the dashboard sidebar widget and return the click handler. */
export async function initDashboardWidget() {
  const widget = await renderSidebarWidget();
  const statsBar = document.getElementById('stats-bar');
  if (statsBar) statsBar.after(widget);
  widget.addEventListener('click', () => enterDashboardMode());
}
