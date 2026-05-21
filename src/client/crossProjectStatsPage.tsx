/**
 * HS-8507 / §70 — Cross-project stats page. Renamed from
 * `telemetryDashboard.tsx` under the HS-8503 telemetry-surface reshape
 * (Phase 3). Full-window surface activated either from the new
 * `#cross-project-stats-toggle` header button (HS-8507) OR — for the
 * duration of the migration — from the legacy sidebar entry
 * `#sidebar-section-telemetry` (HS-8479, removed by Phase 5 /
 * HS-8509). `showCrossProjectStatsPage` takes over the main view
 * region (mirroring the analytics-dashboard pattern in
 * `src/client/dashboardMode.tsx`): hides the toolbar + detail panel
 * + batch toolbar, swaps `#ticket-list` for `#dashboard-container`,
 * and renders the page chrome.
 *
 * Sections rendered here, top-to-bottom (per §70.4):
 *   - Header row: title "Cross-project stats" + window selector.
 *   - Window-total chips: Today / This week / This month / All time.
 *   - **Cost over time** (Stacked / By project toggle visible when
 *     2+ projects, hidden for 1) — shared chart from HS-8506.
 *   - Cost by project sortable table. Row-click switches to that
 *     project + opens the drawer Telemetry tab (mid-migration
 *     fallback; Phase 5 / HS-8509 will rewire this to the per-
 *     project analytics-dashboard section from HS-8508).
 *   - Cost by model donut + legend.
 *   - Hourly activity heatmap (7×24, Monday-first rows).
 *   - **NO top-10 most-expensive-prompts list** — removed per
 *     HS-8503 feedback. The server's `topExpensivePrompts` payload
 *     field is ignored on the client until HS-8509 drops it from
 *     the response shape.
 *
 * Re-fetch on mount + on every window-selector change. NOT live —
 * this is a "look at the numbers" surface, not a live monitor.
 *
 * Sourced from `GET /api/telemetry/dashboard?window=…&tz=…`
 * (HS-8480 / HS-8505 extended with `costOverTime`). Single bundled
 * round-trip per refresh.
 *
 * Re-export shim: `showTelemetryDashboard` is preserved as an alias
 * for `showCrossProjectStatsPage` so the legacy sidebar entry in
 * `telemetrySidebar.tsx` still works during the Phase 3 / 4 / 5
 * migration without a coordinated rename. HS-8509 deletes the
 * alias along with the sidebar entry.
 */

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { unmountColumnView } from './columnView.js';
import { byId, byIdOrNull, toElement } from './dom.js';
import { projectsByIdSignal } from './projectsStore.js';
import { getTelemetryCostMode } from './telemetryCostMode.js';
import { type CostOverTimePoint, renderCostOverTimeChart } from './telemetryCostOverTimeChart.js';
import { renderCostByModelDonut } from './telemetryModelDonut.js';
import { unmountBindList } from './ticketList.js';

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

type DashboardWindow = 'today' | 'week' | 'month' | '90d' | 'all';

/**
 * Cross-project stats page payload. Mirrors the server-side
 * `DashboardPayload` shape returned by
 * `GET /api/telemetry/dashboard` (HS-8480 extended by HS-8505
 * with `costOverTime`). The legacy `topExpensivePrompts` field is
 * still on the wire response but no longer surfaced — HS-8509
 * (Phase 5 cleanup) drops it from both the query side and the
 * payload type. Exported so unit tests can construct fixtures
 * without re-declaring the shape.
 */
export interface DashboardPayload {
  window: DashboardWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByProject: ProjectCostRow[];
  costByModel: ModelRollup[];
  hourlyActivity: HourlyActivityCell[];
  costOverTime: CostOverTimePoint[];
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
      <h3>Cross-project stats</h3>
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

function formatRelativeTs(ts: string | null, now: Date = new Date()): string {
  if (ts === null) return '—';
  try {
    const t = new Date(ts).getTime();
    const ms = now.getTime() - t;
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
    if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)} d ago`;
    return new Date(ts).toLocaleDateString();
  } catch {
    return '—';
  }
}

function resolveProjectName(secret: string): string {
  // Lookup is typed as `Record<string, ProjectInfo>` so TS infers a
  // never-undefined return; in practice a deleted project's data can
  // still appear in otel_metrics, so coerce + guard defensively.
  const project = projectsByIdSignal.value[secret] as ProjectInfo | undefined;
  if (project === undefined) return secret.slice(0, 8); // unknown — short-prefix fallback
  if (project.name !== '') return project.name;
  const basename = project.dataDir.split('/').pop();
  return basename !== undefined && basename !== '' ? basename : project.dataDir;
}

interface ProjectInfo {
  name: string;
  dataDir: string;
  secret: string;
}

type ProjectSortKey = 'project' | 'cost' | 'tokens' | 'promptCount' | 'lastActivityTs';
type SortDir = 'asc' | 'desc';

function sortProjectRows(rows: ProjectCostRow[], key: ProjectSortKey, dir: SortDir): ProjectCostRow[] {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let cmp = 0;
    if (key === 'project') {
      cmp = resolveProjectName(a.projectSecret).localeCompare(resolveProjectName(b.projectSecret));
    } else if (key === 'cost') {
      cmp = a.cost - b.cost;
    } else if (key === 'tokens') {
      cmp = a.tokens - b.tokens;
    } else if (key === 'promptCount') {
      cmp = a.promptCount - b.promptCount;
    } else {
      const aT = a.lastActivityTs === null ? 0 : new Date(a.lastActivityTs).getTime();
      const bT = b.lastActivityTs === null ? 0 : new Date(b.lastActivityTs).getTime();
      cmp = aT - bT;
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

function renderCostByProjectTable(rows: ProjectCostRow[]): HTMLElement {
  let sortKey: ProjectSortKey = 'cost';
  let sortDir: SortDir = 'desc';

  function renderTbody(tbody: HTMLElement): void {
    const sorted = sortProjectRows(rows, sortKey, sortDir);
    tbody.replaceChildren();
    for (const row of sorted) {
      const tr = toElement(
        <tr className="telemetry-dashboard-project-row" data-secret={row.projectSecret}>
          <td className="telemetry-dashboard-project-name">{resolveProjectName(row.projectSecret)}</td>
          <td className="telemetry-dashboard-project-cost">{formatCost(row.cost)}</td>
          <td className="telemetry-dashboard-project-tokens">{formatTokens(row.tokens)}</td>
          <td className="telemetry-dashboard-project-prompts">{String(row.promptCount)}</td>
          <td className="telemetry-dashboard-project-last">{formatRelativeTs(row.lastActivityTs)}</td>
        </tr>
      );
      tbody.appendChild(tr);
    }
  }

  function indicator(key: ProjectSortKey): string {
    if (key !== sortKey) return '';
    return sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  function rebuildHeaders(thead: HTMLElement): void {
    const ths = thead.querySelectorAll<HTMLElement>('th[data-sort-key]');
    ths.forEach(th => {
      const k = th.dataset['sortKey'] as ProjectSortKey;
      // Re-render the label portion only to keep listener intact.
      const labelRaw = th.dataset['label'] ?? '';
      const label = labelRaw.replace(/\s*[▲▼]$/, '');
      th.dataset['label'] = label;
      th.textContent = label + indicator(k);
    });
  }

  const table = toElement(
    <table className="telemetry-dashboard-project-table">
      <thead>
        <tr>
          <th data-sort-key="project" data-label="Project">Project</th>
          <th data-sort-key="cost" data-label="Cost">Cost ▼</th>
          <th data-sort-key="tokens" data-label="Tokens">Tokens</th>
          <th data-sort-key="promptCount" data-label="Prompts">Prompts</th>
          <th data-sort-key="lastActivityTs" data-label="Last activity">Last activity</th>
        </tr>
      </thead>
      <tbody className="telemetry-dashboard-project-tbody"></tbody>
    </table>
  );

  const tbody = table.querySelector<HTMLElement>('.telemetry-dashboard-project-tbody');
  const thead = table.querySelector<HTMLElement>('thead');
  if (tbody !== null) renderTbody(tbody);
  if (thead !== null) {
    thead.querySelectorAll<HTMLElement>('th[data-sort-key]').forEach(th => {
      th.addEventListener('click', () => {
        const k = th.dataset['sortKey'] as ProjectSortKey;
        if (k === sortKey) {
          sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          sortKey = k;
          sortDir = k === 'project' ? 'asc' : 'desc';
        }
        rebuildHeaders(thead);
        if (tbody !== null) renderTbody(tbody);
      });
    });
  }

  // Click a row → switch to that project + open the analytics
  // dashboard (which now carries the per-project "Claude usage"
  // sub-region from HS-8508). Pre-HS-8509 this opened the drawer
  // Telemetry tab; that tab was removed in Phase 5. Delegated on
  // the table so re-renders don't drop the listener.
  table.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target === null) return;
    if (target.closest('th') !== null) return; // header clicks handled above
    const tr = target.closest<HTMLElement>('tr.telemetry-dashboard-project-row');
    if (tr === null) return;
    const secret = tr.dataset['secret'];
    if (secret === undefined) return;
    const project = projectsByIdSignal.value[secret] as ProjectInfo | undefined;
    if (project === undefined) return;
    void (async () => {
      const { switchProject } = await import('./projectTabs.js');
      const { enterDashboardMode } = await import('./dashboardMode.js');
      await switchProject(project);
      enterDashboardMode();
    })();
  });

  return table;
}

/**
 * HS-8483 / §69.3.4 — 7×24 hourly activity heatmap. PostgreSQL
 * `EXTRACT(DOW)` returns 0=Sunday … 6=Saturday; the spec wants
 * Monday → Sunday top-to-bottom (most weekly-planning UI starts
 * the week on Monday), so the row mapping reorders cells by
 * `(dowFromSunday + 6) % 7` to put Monday at row 0.
 *
 * 5-step intensity scale uses `currentColor` + opacity stops so
 * the eventual SCSS theme drives the accent color (matches §67.10.5
 * histogram precedent). Empty cells render at opacity 0 so the
 * background shows through cleanly.
 */
const HEATMAP_OPACITY_STOPS = [0.0, 0.15, 0.35, 0.6, 0.85, 1.0];

function heatmapIntensity(cellCost: number, maxCost: number): number {
  if (maxCost === 0 || cellCost === 0) return HEATMAP_OPACITY_STOPS[0];
  const fraction = cellCost / maxCost;
  // Logarithmic bucket so a single hot cell doesn't crush every
  // other into the lowest step.
  if (fraction >= 0.6) return HEATMAP_OPACITY_STOPS[5];
  if (fraction >= 0.3) return HEATMAP_OPACITY_STOPS[4];
  if (fraction >= 0.1) return HEATMAP_OPACITY_STOPS[3];
  if (fraction >= 0.03) return HEATMAP_OPACITY_STOPS[2];
  return HEATMAP_OPACITY_STOPS[1];
}

const DAY_LABELS_MON_FIRST = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function renderHourlyHeatmap(cells: HourlyActivityCell[]): HTMLElement {
  const cellSize = 18;
  const cellGap = 2;
  const leftAxisWidth = 36;
  const topAxisHeight = 18;
  const width = leftAxisWidth + 24 * (cellSize + cellGap);
  const height = topAxisHeight + 7 * (cellSize + cellGap);

  // Find the max cell cost so intensity is normalized.
  let maxCost = 0;
  for (const c of cells) if (c.cost > maxCost) maxCost = c.cost;

  // Build cell rects.
  const rectsHtml = cells.map(cell => {
    // Sunday=0 in PG; we want Monday=row0.
    const row = (cell.dow + 6) % 7;
    const x = leftAxisWidth + cell.hour * (cellSize + cellGap);
    const y = topAxisHeight + row * (cellSize + cellGap);
    const opacity = heatmapIntensity(cell.cost, maxCost).toFixed(2);
    const tooltip = `${DAY_LABELS_MON_FIRST[row]} ${String(cell.hour).padStart(2, '0')}:00 — ${formatCost(cell.cost)}, ${String(cell.promptCount)} prompts`;
    return `<rect x="${String(x)}" y="${String(y)}" width="${String(cellSize)}" height="${String(cellSize)}" rx="2" ry="2" fill="currentColor" opacity="${opacity}"><title>${tooltip.replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch] ?? ch))}</title></rect>`;
  }).join('');

  // Top hour labels every 3 hours.
  const hourLabels: string[] = [];
  for (let h = 0; h < 24; h += 3) {
    const x = leftAxisWidth + h * (cellSize + cellGap);
    hourLabels.push(`<text x="${String(x)}" y="${String(topAxisHeight - 4)}" font-size="10" fill="currentColor" opacity="0.7">${String(h).padStart(2, '0')}</text>`);
  }

  // Left day labels.
  const dayLabels = DAY_LABELS_MON_FIRST.map((label, row) => {
    const y = topAxisHeight + row * (cellSize + cellGap) + cellSize - 4;
    return `<text x="0" y="${String(y)}" font-size="10" fill="currentColor" opacity="0.7">${label}</text>`;
  }).join('');

  return toElement(
    <div className="telemetry-dashboard-heatmap-wrap">
      <svg className="telemetry-dashboard-heatmap-svg" width={String(width)} height={String(height)} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label="Hourly activity heatmap">
        {raw(dayLabels)}
        {raw(hourLabels.join(''))}
        {raw(rectsHtml)}
      </svg>
    </div>
  );
}

/**
 * Render the page chrome + every section. Exported for direct
 * unit-testing of the section layout — the fetch path
 * (`fetchAndRender`) calls into it after the wire round-trip
 * resolves. Pure render: no fetching, no global state mutation.
 */
export function renderShell(payload: DashboardPayload, container: HTMLElement): void {
  container.replaceChildren();
  const isEmpty = payload.windowTotals.allTime.promptCount === 0 && payload.windowTotals.allTime.cost === 0;
  if (isEmpty) {
    container.appendChild(renderEmptyState());
    return;
  }

  // HS-8497 — when the user is on a Claude Pro/Max subscription, the
  // dollar amounts shown across the dashboard are API-equivalent
  // estimates rather than what they actually pay. Surface a notice
  // banner above the dashboard chrome so the numbers are interpreted
  // correctly.
  if (getTelemetryCostMode() === 'subscription') {
    const notice = toElement(
      <div className="telemetry-subscription-notice" role="note">
        <strong>Subscription mode:</strong> The dollar amounts below are the API-equivalent cost of your Claude Code usage. Your actual bill is your Claude Pro / Max subscription fee. Switch to <em>Pay-per-token</em> in <button type="button" className="telemetry-subscription-notice-link" data-action="open-telemetry-settings">Settings → Telemetry → Billing</button> if you're on an API key.
      </div>
    );
    container.appendChild(notice);
    notice.querySelector('.telemetry-subscription-notice-link')?.addEventListener('click', () => {
      const settingsBtn = byIdOrNull('settings-btn');
      if (settingsBtn !== null) (settingsBtn).click();
    });
  }

  const root = toElement(
    <div className="telemetry-dashboard cross-project-stats-page">
      <div className="telemetry-dashboard-header">
        <h2 className="telemetry-dashboard-title">Cross-project stats</h2>
        {/* HS-8515 — same 7d/30d/90d button group the analytics
            dashboard uses (`.dashboard-range-bar`). Dropped the
            today / all-time options the dropdown had; the
            window-totals chips already cover the "today" /
            "all-time" rollups regardless of the selected window. */}
        <div className="dashboard-range-bar" id="telemetry-dashboard-window-buttons">
          <button type="button" className={`btn btn-sm${payload.window === 'week' ? ' active' : ''}`} data-window="week">7 days</button>
          <button type="button" className={`btn btn-sm${payload.window === 'month' || payload.window === 'today' || payload.window === 'all' ? ' active' : ''}`} data-window="month">30 days</button>
          <button type="button" className={`btn btn-sm${payload.window === '90d' ? ' active' : ''}`} data-window="90d">90 days</button>
        </div>
      </div>
      <div className="telemetry-dashboard-chips" id="telemetry-dashboard-chips"></div>
      <div className="telemetry-dashboard-sections">
        <section className="telemetry-dashboard-section" data-section="cost-over-time">
          <h3>Cost over time</h3>
          <div className="telemetry-dashboard-section-body" id="telemetry-dashboard-cost-over-time">
            <p className="telemetry-dashboard-section-placeholder">No data for this window.</p>
          </div>
        </section>
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

  // HS-8506 / §70.4 — cost-over-time chart, slotted in immediately
  // below the chips row and above cost-by-project. Server is
  // backwards-compatible: the field exists since HS-8505 (Phase 1
  // backend), so any reach of this code path will have it. The
  // `?? []` guards a stale browser cache or a downgraded server.
  const costOverTimePoints = payload.costOverTime as readonly CostOverTimePoint[] | undefined ?? [];
  if (costOverTimePoints.length > 0) {
    const target = root.querySelector<HTMLElement>('#telemetry-dashboard-cost-over-time');
    if (target !== null) {
      target.replaceChildren(renderCostOverTimeChart(costOverTimePoints, {
        resolveProjectLabel: resolveProjectName,
        formatCost,
      }));
    }
  }

  // HS-8482 — cost-by-project + cost-by-model sections.
  if (payload.costByProject.length > 0) {
    const target = root.querySelector<HTMLElement>('#telemetry-dashboard-cost-by-project');
    if (target !== null) {
      target.replaceChildren(renderCostByProjectTable(payload.costByProject));
    }
  }
  if (payload.costByModel.length > 0) {
    const target = root.querySelector<HTMLElement>('#telemetry-dashboard-cost-by-model');
    if (target !== null) {
      target.replaceChildren(renderCostByModelDonut(payload.costByModel, { formatCost }));
    }
  }

  // HS-8483 — heatmap section. Top-10 most-expensive-prompts list
  // was removed per HS-8503 feedback (HS-8507 / §70.4). The wire
  // payload still carries it; we ignore it here until Phase 5
  // cleanup (HS-8509) drops it from the response shape.
  const heatmapHasData = payload.hourlyActivity.some(c => c.cost > 0 || c.promptCount > 0);
  if (heatmapHasData) {
    const target = root.querySelector<HTMLElement>('#telemetry-dashboard-heatmap');
    if (target !== null) {
      target.replaceChildren(renderHourlyHeatmap(payload.hourlyActivity));
    }
  }

  // HS-8515 — Window-selector re-fetch via the button group (was a
  // `<select>` pre-HS-8515; replaced with the `.dashboard-range-bar`
  // button group the analytics dashboard uses for visual consistency).
  // No live polling — per §69.6.
  const buttons = root.querySelector<HTMLElement>('#telemetry-dashboard-window-buttons');
  if (buttons !== null) {
    buttons.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>('button[data-window]');
      if (btn === null || btn === undefined) return;
      const window = btn.dataset.window as DashboardWindow | undefined;
      if (window === undefined) return;
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
 * HS-8507 entry-point — replaces the legacy `showTelemetryDashboard`
 * under the HS-8503 reshape. Hides the standard toolbar + detail
 * panel + batch toolbar, swaps `#ticket-list` for
 * `#dashboard-container` (matching the analytics-dashboard
 * convention from `dashboardMode.tsx::enterDashboardMode` so the
 * existing `restoreTicketList()` callback wired into `bindSidebar`
 * handles the reverse path cleanly), then fetches + renders the
 * page.
 */
export function showCrossProjectStatsPage(): void {
  // HS-8516 — if we're already on the analytics dashboard (which
  // renamed `#ticket-list` to `#dashboard-container`), normalize the
  // id back so `byId('ticket-list')` below doesn't throw. Without
  // this the call threw silently inside a document-level click
  // listener and the user saw "nothing happens" on the header-button
  // click. Symmetric with the parallel fix in `enterDashboardMode`.
  const existingDashContainer = byIdOrNull('dashboard-container');
  if (existingDashContainer !== null) {
    existingDashContainer.id = 'ticket-list';
    existingDashContainer.replaceChildren();
    existingDashContainer.classList.remove('ticket-list-columns');
  }
  hideToolbar();
  const ticketList = byId('ticket-list');
  // HS-8504 (follow-up) — dispose any live list-view bindList /
  // column-view disposers before the container wipe, mirroring
  // `enterDashboardMode`. Without this, exiting back to a list view
  // hit a stale-mount-key early-return and left the page empty until
  // the user toggled views.
  unmountBindList();
  unmountColumnView();
  ticketList.replaceChildren();
  ticketList.id = 'dashboard-container';
  ticketList.classList.remove('ticket-list-columns');
  void fetchAndRender(ticketList);
}
