/**
 * HS-8508 (HS-8503 Phase 4) — Per-project telemetry sections appended
 * below the analytics-dashboard's existing ticket-charts grid.
 *
 * Layout (top-to-bottom, per §71.4):
 *   - Section header: title "Claude usage" + window selector
 *     (today / week / month / 90d / all). The selector is
 *     INDEPENDENT of the analytics-dashboard's existing 7d / 30d / 90d
 *     ticket-range buttons — ticket data and telemetry data answer
 *     different questions and the user picks each window separately.
 *   - Three chips: Today / This week / All time. Identical shape to
 *     the (Phase 5 / HS-8509-removed) drawer Telemetry tab's chips.
 *     Always rendered regardless of the window selector — the
 *     selector only narrows the sections below.
 *   - Cost over time (per-project) via the shared chart component
 *     from HS-8506. Stacked / By project mode toggle is hidden
 *     automatically when only one project's data is present (the
 *     active project — which is always exactly one project for this
 *     surface).
 *   - Cost by model donut + legend via the shared module from
 *     HS-8508 (extracted from `crossProjectStatsPage.tsx`).
 *   - Per-tool latency histograms (count + p50 / p90 / p99 + bucket
 *     bars) via the shared module from HS-8508 (extracted from
 *     `telemetryDrawer.tsx`).
 *   - 10 most recent prompts via the shared module from HS-8508
 *     (extracted from `telemetryDrawer.tsx`). Each row click opens
 *     the existing `openPromptDrilldown` modal (HS-8149).
 *
 * Empty-state behavior: when the active project has telemetry off OR
 * no telemetry rows in the all-time slice, the section renders a
 * small inline placeholder explaining the state. The analytics
 * dashboard's ticket charts above keep rendering normally — this is
 * NOT a blocking modal, just an inline note.
 *
 * Data source: `GET /api/telemetry/project-rollup?window=<window>&tz=<tz>`
 * (HS-8505 Phase 1 backend). Single bundled round-trip per refresh.
 * NOT live — re-fetch fires only on window-selector change.
 *
 * Wire-up: `dashboard.tsx::buildDashboard` calls
 * `renderAnalyticsTelemetrySection()` and appends the returned root
 * element after the chart grid. The element is self-managing: it
 * kicks off its own fetch + re-renders on window-selector change.
 */

import { api } from './api.js';
import { toElement } from './dom.js';
import { getActiveProject } from './state.js';
import { type CostOverTimePoint, renderCostOverTimeChart } from './telemetryCostOverTimeChart.js';
import { renderCostByModelDonut } from './telemetryModelDonut.js';
import { type RecentPromptRow, renderRecentPromptsList } from './telemetryRecentPromptsList.js';
import { renderToolHistogramRow,type ToolLatencyHistogramRow } from './telemetryToolHistogram.js';

type TelemetryWindow = 'today' | 'week' | 'month' | '90d' | 'all';

interface WindowTotals {
  cost: number;
  tokens: number;
  promptCount: number;
}

interface ModelRollupRow {
  model: string;
  cost: number;
  tokens: number;
  promptCount: number;
}

interface ProjectRollupPayload {
  window: TelemetryWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByModel: ModelRollupRow[];
  toolLatencyHistogram: ToolLatencyHistogramRow[];
  recentPrompts: RecentPromptRow[];
  costOverTime: CostOverTimePoint[];
}

let currentWindow: TelemetryWindow = 'month';

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function renderWindowChip(label: string, totals: WindowTotals): HTMLElement {
  return toElement(
    <div className="telemetry-chip">
      <div className="telemetry-chip-label">{label}</div>
      <div className="telemetry-chip-cost">{formatCost(totals.cost)}</div>
      <div className="telemetry-chip-meta">
        {formatTokens(totals.tokens)} tokens · {String(totals.promptCount)} prompts
      </div>
    </div>
  );
}

function renderEmptyPlaceholder(): HTMLElement {
  return toElement(
    <div className="analytics-telemetry-empty">
      <p>
        <strong>No telemetry recorded for this project yet.</strong>
      </p>
      <p className="analytics-telemetry-empty-hint">
        Enable telemetry in Settings → Telemetry, then run <code>claude</code> in a Hot Sheet terminal.
        Data lands within ~60 seconds of the first export tick.
      </p>
    </div>
  );
}

function renderLoadingPlaceholder(): HTMLElement {
  return toElement(<div className="analytics-telemetry-loading">Loading Claude usage…</div>);
}

function renderErrorBlock(message: string): HTMLElement {
  return toElement(
    <div className="analytics-telemetry-error">
      <p><strong>Failed to load Claude usage.</strong></p>
      <p className="analytics-telemetry-error-detail">{message}</p>
    </div>
  );
}

/**
 * Render the populated section body from a fetched payload. The
 * caller swaps this into `#analytics-telemetry-body`. Pure: no
 * fetching, no module-state mutation beyond the rendered tree.
 */
function renderBody(payload: ProjectRollupPayload, activeSecret: string | null): HTMLElement {
  const hasData = payload.windowTotals.allTime.promptCount > 0 || payload.windowTotals.allTime.cost > 0;
  if (!hasData) {
    return renderEmptyPlaceholder();
  }

  const body = toElement(<div className="analytics-telemetry-body"></div>);

  // Window chips (always today / week / all time regardless of selector).
  const chips = toElement(<div className="telemetry-window-chips analytics-telemetry-chips"></div>);
  chips.appendChild(renderWindowChip('Today', payload.windowTotals.today));
  chips.appendChild(renderWindowChip('This week', payload.windowTotals.week));
  chips.appendChild(renderWindowChip('All time', payload.windowTotals.allTime));
  body.appendChild(chips);

  // Cost over time (per-project — the chart's mode toggle is hidden
  // automatically because the slice carries only one project).
  if (payload.costOverTime.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="cost-over-time">
        <h3>Cost over time</h3>
      </section>
    );
    section.appendChild(renderCostOverTimeChart(payload.costOverTime, {
      formatCost,
      resolveProjectLabel: (secret) => secret === activeSecret ? 'This project' : secret.slice(0, 8),
    }));
    body.appendChild(section);
  }

  // Cost by model (per-project variant of the donut from the cross-
  // project page).
  if (payload.costByModel.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="cost-by-model">
        <h3>Cost by model</h3>
      </section>
    );
    section.appendChild(renderCostByModelDonut(payload.costByModel, { formatCost }));
    body.appendChild(section);
  }

  // Per-tool latency histograms.
  if (payload.toolLatencyHistogram.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="tool-latency">
        <h3>Tool latency distribution</h3>
        <div className="telemetry-histograms" id="analytics-telemetry-histograms"></div>
      </section>
    );
    const container = section.querySelector<HTMLElement>('#analytics-telemetry-histograms');
    if (container !== null) {
      for (const row of payload.toolLatencyHistogram) container.appendChild(renderToolHistogramRow(row));
    }
    body.appendChild(section);
  }

  // 10 most recent prompts (ts DESC, NOT by cost). Helper's
  // delegated click handler opens `openPromptDrilldown`.
  if (payload.recentPrompts.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="recent-prompts">
        <h3>Recent prompts</h3>
      </section>
    );
    section.appendChild(renderRecentPromptsList(payload.recentPrompts));
    body.appendChild(section);
  }

  return body;
}

async function fetchAndPopulate(bodySlot: HTMLElement, w: TelemetryWindow): Promise<void> {
  bodySlot.replaceChildren(renderLoadingPlaceholder());
  const active = getActiveProject();
  if (active === null) {
    bodySlot.replaceChildren(renderEmptyPlaceholder());
    return;
  }
  try {
    const tz = resolveTimezone();
    const payload = await api<ProjectRollupPayload>(
      `/telemetry/project-rollup?window=${encodeURIComponent(w)}&tz=${encodeURIComponent(tz)}`,
    );
    bodySlot.replaceChildren(renderBody(payload, active.secret));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    bodySlot.replaceChildren(renderErrorBlock(message));
  }
}

/**
 * Build + return the analytics-dashboard telemetry section root
 * element. Self-managing: kicks off its own fetch immediately and
 * re-fetches on window-selector change.
 *
 * Caller (the analytics dashboard's `buildDashboard`) appends the
 * returned element below the existing chart grid.
 */
export function renderAnalyticsTelemetrySection(): HTMLElement {
  const root = toElement(
    <div className="analytics-telemetry-section">
      <div className="analytics-telemetry-header">
        <h2 className="analytics-telemetry-title">Claude usage</h2>
        <div className="analytics-telemetry-window-selector">
          <label htmlFor="analytics-telemetry-window-select">Window:&nbsp;</label>
          <select className="analytics-telemetry-window-select" id="analytics-telemetry-window-select">
            <option value="today" selected={currentWindow === 'today'}>Today</option>
            <option value="week" selected={currentWindow === 'week'}>This week</option>
            <option value="month" selected={currentWindow === 'month'}>This month</option>
            <option value="90d" selected={currentWindow === '90d'}>90 days</option>
            <option value="all" selected={currentWindow === 'all'}>All time</option>
          </select>
        </div>
      </div>
      <div className="analytics-telemetry-body-slot" id="analytics-telemetry-body"></div>
    </div>
  );

  const bodySlot = root.querySelector<HTMLElement>('#analytics-telemetry-body');
  const select = root.querySelector<HTMLSelectElement>('#analytics-telemetry-window-select');
  if (bodySlot === null || select === null) return root;

  select.addEventListener('change', () => {
    const next = select.value;
    if (next === 'today' || next === 'week' || next === 'month' || next === '90d' || next === 'all') {
      currentWindow = next;
      void fetchAndPopulate(bodySlot, currentWindow);
    }
  });

  void fetchAndPopulate(bodySlot, currentWindow);

  return root;
}

/** Test-only escape hatch. */
export const _testing = {
  renderBody,
  renderEmptyPlaceholder,
  setWindow(w: TelemetryWindow): void { currentWindow = w; },
  getWindow(): TelemetryWindow { return currentWindow; },
};
