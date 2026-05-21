/**
 * HS-8481 / §69.3 — cross-project Telemetry dashboard view. Hidden
 * full-window surface activated from the conditional sidebar entry
 * (HS-8479). When `showTelemetryDashboard` runs it takes over the
 * main view region (mirroring the analytics-dashboard pattern in
 * `src/client/dashboardMode.tsx`): hides the toolbar + detail panel,
 * swaps `#ticket-list` for `#dashboard-container`, and renders the
 * dashboard chrome.
 *
 * Sections rendered here (HS-8481 owns the shell):
 *   - Three large monospace dollar-amount tiles: Today / This week
 *     / This month — sourced from `payload.windowTotals`.
 *   - Empty-state onboarding card when no usage has been recorded.
 *   - Per-section container divs for HS-8482 (cost-by-project +
 *     model donut) and HS-8483 (heatmap + top-10) to fill.
 *
 * Re-fetch on mount + on the window-selector change (when added in
 * a later ticket). NOT live — the dashboard is a "look at the
 * numbers" surface, not a live monitor.
 *
 * Sourced from `GET /api/telemetry/dashboard?window=…&tz=…`
 * (HS-8480). Single bundled round-trip per refresh.
 */

import { api } from './api.js';
import { byId, byIdOrNull, toElement } from './dom.js';

interface WindowTotals {
  cost: number;
  tokens: number;
  promptCount: number;
}

interface ProjectCostRow {
  projectSecret: string;
  cost: number;
  tokens: number;
  promptCount: number;
  lastActivityTs: string | null;
}

interface ModelRollup {
  model: string;
  cost: number;
  tokens: number;
  promptCount: number;
}

interface HourlyActivityCell {
  dow: number;
  hour: number;
  cost: number;
  promptCount: number;
}

interface TopPromptRow {
  promptId: string;
  ts: string;
  projectSecret: string;
  cost: number;
  model: string | null;
  preview: string | null;
}

type DashboardWindow = 'today' | 'week' | 'month' | '90d' | 'all';

interface DashboardPayload {
  window: DashboardWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByProject: ProjectCostRow[];
  costByModel: ModelRollup[];
  hourlyActivity: HourlyActivityCell[];
  topExpensivePrompts: TopPromptRow[];
}

const TOOLBAR_HIDDEN_IDS = ['search-input', 'layout-toggle', 'sort-select', 'detail-position-toggle', 'glassbox-btn'];

function hideToolbar(): void {
  for (const id of TOOLBAR_HIDDEN_IDS) {
    const el = byIdOrNull(id);
    if (el === null) continue;
    const container = el.closest('.search-box, .layout-toggle, .sort-controls') ?? el;
    (container as HTMLElement).style.display = 'none';
  }
  const batchToolbar = byIdOrNull('batch-toolbar');
  if (batchToolbar !== null) batchToolbar.style.display = 'none';
  const detailPanel = byIdOrNull('detail-panel');
  if (detailPanel !== null) detailPanel.style.display = 'none';
  const resizeHandle = byIdOrNull('detail-resize-handle');
  if (resizeHandle !== null) resizeHandle.style.display = 'none';
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function renderWindowChip(label: string, totals: WindowTotals): HTMLElement {
  return toElement(
    <div className="telemetry-dashboard-chip">
      <div className="telemetry-dashboard-chip-label">{label}</div>
      <div className="telemetry-dashboard-chip-cost">{formatCost(totals.cost)}</div>
      <div className="telemetry-dashboard-chip-meta">{`${formatTokens(totals.tokens)} tokens · ${String(totals.promptCount)} prompts`}</div>
    </div>
  );
}

function openSettingsTelemetry(): void {
  // The existing settings-btn click opens the settings dialog; the
  // bindTelemetryTab() hook fetches the file-settings + populates
  // the form. Switching to the Telemetry tab from here would require
  // a tabs-bus hook we don't yet have — defer the auto-switch as a
  // polish follow-up; opening the dialog is enough to surface the
  // toggle row near the bottom.
  const settingsBtn = byIdOrNull('settings-btn');
  if (settingsBtn !== null) settingsBtn.click();
}

function renderEmptyState(): HTMLElement {
  const card = toElement(
    <div className="telemetry-dashboard-empty">
      <h3>Telemetry dashboard</h3>
      <p>
        No usage recorded yet. To start collecting, open Settings → Telemetry in any project,
        enable the master toggle, then run <code>claude</code> in a Hot Sheet terminal.
        Cost data appears here within a minute of the first prompt.
      </p>
      <div className="telemetry-dashboard-empty-actions">
        <button type="button" className="telemetry-dashboard-empty-settings-btn">Open Settings</button>
        <a className="telemetry-dashboard-empty-doc-link" href="https://github.com/anthropics/hot-sheet/blob/main/docs/67-telemetry.md" target="_blank" rel="noopener noreferrer">Read docs/67-telemetry.md</a>
      </div>
    </div>
  );
  card.querySelector('.telemetry-dashboard-empty-settings-btn')?.addEventListener('click', () => {
    openSettingsTelemetry();
  });
  return card;
}

function renderShell(payload: DashboardPayload, container: HTMLElement): void {
  container.replaceChildren();
  const isEmpty = payload.windowTotals.allTime.promptCount === 0 && payload.windowTotals.allTime.cost === 0;
  if (isEmpty) {
    container.appendChild(renderEmptyState());
    return;
  }

  const root = toElement(
    <div className="telemetry-dashboard">
      <div className="telemetry-dashboard-header">
        <h2 className="telemetry-dashboard-title">Telemetry</h2>
        <div className="telemetry-dashboard-window-selector">
          <label>Window:&nbsp;</label>
          <select className="telemetry-dashboard-window-select" id="telemetry-dashboard-window-select">
            <option value="today">Today</option>
            <option value="week">This week</option>
            <option value="month" selected={payload.window === 'month'}>This month</option>
            <option value="90d">90 days</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>
      <div className="telemetry-dashboard-chips" id="telemetry-dashboard-chips"></div>
      <div className="telemetry-dashboard-sections">
        <section className="telemetry-dashboard-section" data-section="cost-by-project">
          <h3>Cost by project</h3>
          <div className="telemetry-dashboard-section-body" id="telemetry-dashboard-cost-by-project">
            <p className="telemetry-dashboard-section-placeholder">No data for this window.</p>
          </div>
        </section>
        <section className="telemetry-dashboard-section" data-section="cost-by-model">
          <h3>Cost by model</h3>
          <div className="telemetry-dashboard-section-body" id="telemetry-dashboard-cost-by-model">
            <p className="telemetry-dashboard-section-placeholder">No data for this window.</p>
          </div>
        </section>
        <section className="telemetry-dashboard-section" data-section="heatmap">
          <h3>Hourly activity (last 90 days)</h3>
          <div className="telemetry-dashboard-section-body" id="telemetry-dashboard-heatmap">
            <p className="telemetry-dashboard-section-placeholder">No data for this window.</p>
          </div>
        </section>
        <section className="telemetry-dashboard-section" data-section="top-prompts">
          <h3>Top 10 most expensive prompts</h3>
          <div className="telemetry-dashboard-section-body" id="telemetry-dashboard-top-prompts">
            <p className="telemetry-dashboard-section-placeholder">No data for this window.</p>
          </div>
        </section>
      </div>
    </div>
  );

  // Populate the chips row.
  const chips = root.querySelector<HTMLElement>('#telemetry-dashboard-chips');
  if (chips !== null) {
    chips.appendChild(renderWindowChip('Today', payload.windowTotals.today));
    chips.appendChild(renderWindowChip('This week', payload.windowTotals.week));
    chips.appendChild(renderWindowChip('This month', payload.windowTotals.month));
    chips.appendChild(renderWindowChip('All time', payload.windowTotals.allTime));
  }

  // Window-selector re-fetch (no live polling — per §69.6).
  const select = root.querySelector<HTMLSelectElement>('#telemetry-dashboard-window-select');
  if (select !== null) {
    select.addEventListener('change', () => {
      const window = select.value as DashboardWindow;
      void fetchAndRender(container, window);
    });
  }

  container.appendChild(root);
}

async function fetchAndRender(container: HTMLElement, window: DashboardWindow = 'month'): Promise<void> {
  container.replaceChildren(toElement(<p className="telemetry-dashboard-loading">Loading dashboard…</p>));
  try {
    const tz = typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'UTC';
    const payload = await api<DashboardPayload>(`/telemetry/dashboard?window=${encodeURIComponent(window)}&tz=${encodeURIComponent(tz)}`);
    renderShell(payload, container);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    container.replaceChildren(toElement(
      <div className="telemetry-dashboard-error">
        <p>Failed to load telemetry dashboard.</p>
        <p className="telemetry-dashboard-error-detail">{message}</p>
      </div>
    ));
  }
}

/**
 * HS-8479 entry-point. Hides the standard toolbar + detail panel +
 * batch toolbar, swaps `#ticket-list` for `#dashboard-container`
 * (matching the analytics-dashboard convention from
 * `dashboardMode.tsx::enterDashboardMode` so the existing
 * `restoreTicketList()` callback wired into `bindSidebar` handles
 * the reverse path cleanly), then fetches + renders the dashboard.
 */
export function showTelemetryDashboard(): void {
  hideToolbar();
  const ticketList = byId('ticket-list');
  ticketList.replaceChildren();
  ticketList.id = 'dashboard-container';
  ticketList.classList.remove('ticket-list-columns');
  void fetchAndRender(ticketList);
}
