import { unmountColumnView } from './columnView.js';
import { renderDashboard, renderSidebarWidget } from './dashboard.js';
import { hideDashboardToolbarControls, restoreDashboardToolbarControls } from './dashboardToolbarVisibility.js';
import { byId, byIdOrNull } from './dom.js';
import {
  isAnalyticsDashboardActive,
  isCrossProjectStatsPageActive,
  markAnalyticsDashboardActive,
  markCrossProjectStatsSupplanted,
} from './mainSurfaceState.js';
import { getActiveProject, state } from './state.js';
import { getTelemetryCostMode } from './telemetryCostMode.js';
import { formatCost } from './telemetryFormat.js';
import { unmountBindList } from './ticketList.js';

export { isAnalyticsDashboardActive, markAnalyticsDashboardSupplanted } from './mainSurfaceState.js';

/** HS-8526 — the `state.view` that was active when the user first
 *  opened the analytics dashboard. Restored on the second-click
 *  toggle-off via `toggleDashboardMode`. Lives in this module rather
 *  than `mainSurfaceState.ts` because the "previous view" semantics
 *  only matter to this surface's restore-on-toggle-off path. */
let viewBeforeDashboard: string | null = null;

/** Restore the ticket list view from dashboard mode. */
export function restoreTicketList() {
  // HS-8626 — belt-and-suspenders: always restore the header toolbar
  // controls when returning to the ticket view. The `exitDashboardMode()`
  // call below (which restores them) only runs when `#dashboard-container`
  // still exists, but a surface that supplanted the analytics dashboard may
  // have renamed it away while leaving the controls hidden. Idempotent on
  // already-visible controls, so safe on every restore path (sidebar click,
  // project-tab click, category buttons).
  restoreDashboardToolbarControls();
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
  // Hide toolbar elements (shared list — see dashboardToolbarVisibility.ts).
  hideDashboardToolbarControls();
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
  // Restore toolbar elements (shared list — see dashboardToolbarVisibility.ts).
  restoreDashboardToolbarControls();
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

/** Sticky per-project cost cache. HS-8531 — switched from a "latest
 *  fetch snapshot" map to a "best known value per project" cache so a
 *  freshly-mounted sidebar widget (project-tab switch) renders the
 *  previously-displayed cost immediately, instead of flashing blank
 *  while the next bell-poll round-trip resolves.
 *
 *  Semantics: every entry in an incoming fetch updates the cache (so
 *  the cost can move up + down during the day). Entries the server
 *  omits — which means "zero cost today for that project" per the
 *  `/api/telemetry/today-cost-by-project` server contract — do NOT
 *  blank the cache; the user already saw a value and we keep showing
 *  it until the next confirmed update for that secret arrives. The
 *  trade-off (a stale value across midnight rollover) is acceptable
 *  per the user's stated preference: caching takes priority over
 *  zero-correctness on the day boundary; the first nonzero point of
 *  the new day will correct it on the next fetch. */
const stickyCostCache = new Map<string, number>();

/** Update the active project's cost in the sidebar widget. `costs` is
 *  the bulk `/api/telemetry/today-cost-by-project` response keyed by
 *  project secret. Subscription billing-mode hides the cost (the
 *  dollar amount is an API-equivalent estimate, not what the user
 *  pays). HS-8531 — projects missing from `costs` keep their cached
 *  value rather than disappearing. */
export function updateSidebarWidgetCost(costs: Record<string, number>): void {
  // HS-8531 — merge into the sticky cache rather than replacing it.
  // Only entries the server actually returns update the cache.
  for (const [secret, cost] of Object.entries(costs)) {
    stickyCostCache.set(secret, cost);
  }
  const el = document.querySelector<HTMLElement>('.sidebar-widget-cost');
  if (el === null) return;
  const secret = getActiveProject()?.secret ?? '';
  const cost = stickyCostCache.get(secret) ?? 0;
  const mode = getTelemetryCostMode();
  if (cost > 0 && mode === 'api') {
    // HS-8543 — append a `*` superscript so users on a Pro/Max
    // subscription understand the dollar amount is the API-equivalent
    // cost rather than what they actually pay. The full disclaimer
    // lives in the stats pages' header notices; the superscript here
    // is the breadcrumb that points there. Title attribute carries
    // a tooltip so hovering reveals the short explanation inline.
    // HS-8566 — use the shared formatter so the dashboard widget
    // matches the cross-project page + per-ticket stats display.
    const label = formatCost(cost);
    el.replaceChildren(
      document.createTextNode(label),
      Object.assign(document.createElement('sup'), {
        className: 'sidebar-widget-cost-asterisk',
        textContent: '*',
        title: 'Estimate only for Claude Pro / Max / other-subscription users. See cost overview pages for details.',
      }),
    );
    el.style.display = '';
  } else {
    el.replaceChildren();
    el.style.display = 'none';
  }
}

/** Re-render the sidebar cost using the cached values. Called after
 *  the widget is re-mounted (project switch) and from the Settings
 *  dialog immediately after a billing-mode change. HS-8531 — passes
 *  an empty record so the cache is read-only this call (no merge),
 *  but the active project still gets its sticky-cached value rendered.
 */
export function refreshSidebarWidgetCost(): void {
  updateSidebarWidgetCost({});
}

/** HS-8620 — after a telemetry clear, the active project's cost is 0 (every
 *  row was deleted). `refreshSidebarWidgetCost()` can't express that: it
 *  passes an empty record, and the sticky cache (HS-8531) deliberately KEEPS
 *  the last value for projects the next fetch omits — but a just-cleared
 *  project IS omitted by `today-cost-by-project` (zero cost today), so the
 *  stale value would otherwise persist until the next NEW prompt arrives
 *  (the reported symptom: "didn't clear cost until next telemetry received").
 *  Force the active project's cached cost to 0 and re-render so the widget
 *  drops to $0 / hides immediately. */
export function clearSidebarWidgetCostForActiveProject(): void {
  const secret = getActiveProject()?.secret;
  if (secret === undefined || secret === '') return;
  stickyCostCache.set(secret, 0);
  updateSidebarWidgetCost({});
}

/** Test-only escape hatch — exposed so unit tests can reset the
 *  module-private sticky cache between cases. HS-8531. */
export const _testingSidebarCost = {
  resetCache(): void { stickyCostCache.clear(); },
  cacheSize(): number { return stickyCostCache.size; },
  getCached(secret: string): number | undefined { return stickyCostCache.get(secret); },
};
