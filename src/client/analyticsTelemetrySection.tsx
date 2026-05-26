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

import { getProjectRollup } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';
import { getActiveProject } from './state.js';
import { type CostOverTimePoint, renderCostOverTimeChart } from './telemetryCostOverTimeChart.js';
import { formatCost } from './telemetryFormat.js';
import { renderCostByModelDonut } from './telemetryModelDonut.js';
import { type RecentPromptRow, renderRecentPromptsList } from './telemetryRecentPromptsList.js';
import { renderSubscriptionDisclaimer } from './telemetrySubscriptionDisclaimer.js';
import { renderToolHistogramRow,type ToolLatencyHistogramRow } from './telemetryToolHistogram.js';

type TelemetryWindow = 'today' | 'week' | 'month' | '90d' | 'all';

interface WindowTotals {
  cost: number;
  tokens: number;
  // HS-8628 — input / output split (input + output ≈ tokens; cache excluded).
  inputTokens: number;
  outputTokens: number;
  // HS-8639 — cache tokens, excluded from `tokens` but shown so the cost
  // reconciles (cache write ≈ 1.25× input; large cache also triggers the
  // 1M-context rate premium). Optional for back-compat with cached responses.
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  promptCount: number;
}

interface ModelRollupRow {
  model: string;
  cost: number;
  tokens: number;
  // HS-8628 — per-model input / output split feeds the donut legend meta line.
  inputTokens: number;
  outputTokens: number;
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

// HS-8572 — per-(projectSecret, window) payload cache. Re-entering
// the analytics dashboard (closing + re-opening the project's
// analytics widget) paints the cached payload immediately instead of
// the "Loading Claude usage…" placeholder. Background fetch refreshes
// in place. Keyed by `<secret>|<window>` so switching projects or
// windows picks the right slice.
const cachedAnalyticsPayloads = new Map<string, ProjectRollupPayload>();

// HS-8572 — track which payload (serialized) is currently painted
// into each bodySlot so a poll tick on unchanged data does NOT wipe
// interactive state (recent-prompts drilldown hover, histogram
// scroll, etc.).
const lastPaintedAnalyticsFor = new WeakMap<HTMLElement, string>();

// HS-8572 — live-refresh interval id while the section is mounted.
// Tied to the bodySlot's presence in the document (no explicit hide
// hook to wire — the analytics dashboard tears down by removing the
// surrounding DOM). 30 s cadence matches the cross-project page.
let analyticsPollIntervalId: ReturnType<typeof setInterval> | null = null;
const ANALYTICS_POLL_INTERVAL_MS = 30_000;

function cacheKey(projectSecret: string, w: TelemetryWindow): string {
  return `${projectSecret}|${w}`;
}

// HS-8566 — see `telemetryFormat.ts`. `formatCost` now hides cents for
// values >= $1000 with half-up rounding + thousands separators.

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
  // HS-8628 — show the input / output split on a second meta line when token
  // data is present (input + output are priced very differently). The headline
  // line keeps the combined real-work total + prompt count.
  const hasSplit = totals.inputTokens > 0 || totals.outputTokens > 0;
  // HS-8639 — surface the cache pieces too. They're excluded from the headline
  // token total (HS-8627) but DO drive the authoritative cost: cache write is
  // ~1.25× input and a large cached context triggers the 1M-context (`[1m]`)
  // rate premium — which is why `cost` can dwarf a naive input+output estimate.
  const cacheRead = totals.cacheReadTokens ?? 0;
  const cacheCreation = totals.cacheCreationTokens ?? 0;
  const hasCache = cacheRead > 0 || cacheCreation > 0;
  return toElement(
    <div className="telemetry-chip">
      <div className="telemetry-chip-label">{label}</div>
      <div className="telemetry-chip-cost" title="Cost is the amount Claude Code reports for this work. It includes cache tokens and any 1M-context rate premium, so it can exceed a naive estimate from the input/output tokens above.">{formatCost(totals.cost)}</div>
      <div className="telemetry-chip-meta">
        {formatTokens(totals.tokens)} tokens · {String(totals.promptCount)} prompts
      </div>
      {hasSplit
        ? <div className="telemetry-chip-submeta">{`${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out`}</div>
        : null}
      {hasCache
        ? <div className="telemetry-chip-submeta telemetry-chip-submeta-cache">{`${formatTokens(cacheRead)} cache read · ${formatTokens(cacheCreation)} cache write`}</div>
        : null}
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

  // HS-8565 — the always-visible subscription-cost disclaimer + the
  // 4-chip "Claude usage overview" boxes used to live inline at the
  // top of this body. The user reshape moves them out of the section:
  // the disclaimer renders above BOTH the ticket-stats KPI row and
  // the Claude-usage chips (so it covers every cost on the page),
  // and the chips render directly below the KPI row so the two
  // overview rows read as a single block. Both are populated into
  // dashboard-owned slots (`#dashboard-claude-disclaimer-slot` +
  // `#dashboard-claude-chips-slot`) by `populateDashboardSlots`
  // below — see also `src/client/dashboard.tsx::buildDashboard`. The
  // slot fallback (insert into `body` when the slot is missing) keeps
  // standalone callers + unit tests rendering an end-to-end body.
  populateDashboardSlots(payload, body);

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

/**
 * HS-8565 — write the disclaimer + Claude usage chips into the dashboard-
 * owned slots (`#dashboard-claude-disclaimer-slot` +
 * `#dashboard-claude-chips-slot` from `dashboard.tsx::buildDashboard`).
 * Falls back to appending into the supplied `bodyFallback` element when
 * either slot is missing (standalone callers, unit tests).
 */
function populateDashboardSlots(payload: ProjectRollupPayload, bodyFallback: HTMLElement): void {
  const disclaimerSlot = byIdOrNull('dashboard-claude-disclaimer-slot');
  const chipsSlot = byIdOrNull('dashboard-claude-chips-slot');

  const disclaimerEl = renderSubscriptionDisclaimer();
  const chipsEl = toElement(<div className="telemetry-window-chips analytics-telemetry-chips"></div>);
  chipsEl.appendChild(renderWindowChip('Today', payload.windowTotals.today));
  chipsEl.appendChild(renderWindowChip('This week', payload.windowTotals.week));
  chipsEl.appendChild(renderWindowChip('This month', payload.windowTotals.month));
  chipsEl.appendChild(renderWindowChip('All time', payload.windowTotals.allTime));

  if (disclaimerSlot !== null) {
    disclaimerSlot.replaceChildren(disclaimerEl);
  } else {
    bodyFallback.appendChild(disclaimerEl);
  }
  if (chipsSlot !== null) {
    chipsSlot.replaceChildren(chipsEl);
  } else {
    bodyFallback.appendChild(chipsEl);
  }
}

/**
 * HS-8565 — clear the dashboard-owned slots so they don't keep showing
 * stale chips / a stale disclaimer when the section enters its empty
 * placeholder or error states. Idempotent — does nothing if the slots
 * aren't present (standalone callers, unit tests).
 */
function clearDashboardSlots(): void {
  byIdOrNull('dashboard-claude-disclaimer-slot')?.replaceChildren();
  byIdOrNull('dashboard-claude-chips-slot')?.replaceChildren();
}

async function fetchAndPopulate(bodySlot: HTMLElement, w: TelemetryWindow): Promise<void> {
  const active = getActiveProject();
  if (active === null) {
    clearDashboardSlots();
    bodySlot.replaceChildren(renderEmptyPlaceholder());
    return;
  }

  // HS-8572 — cache hit: paint the cached payload immediately so the
  // user doesn't see the "Loading Claude usage…" placeholder on every
  // re-entry. Skip the paint when the cached payload is already on
  // screen (poll tick on unchanged data) — see `lastPaintedAnalyticsFor`.
  const key = cacheKey(active.secret, w);
  const cached = cachedAnalyticsPayloads.get(key);
  if (cached !== undefined) {
    const cachedSerialized = JSON.stringify(cached);
    if (lastPaintedAnalyticsFor.get(bodySlot) !== cachedSerialized) {
      const cachedHasData = cached.windowTotals.allTime.promptCount > 0 || cached.windowTotals.allTime.cost > 0;
      if (!cachedHasData) clearDashboardSlots();
      bodySlot.replaceChildren(renderBody(cached, active.secret));
      lastPaintedAnalyticsFor.set(bodySlot, cachedSerialized);
    }
  } else {
    bodySlot.replaceChildren(renderLoadingPlaceholder());
    lastPaintedAnalyticsFor.delete(bodySlot);
  }

  try {
    const tz = resolveTimezone();
    const payload: ProjectRollupPayload = await getProjectRollup(w, tz);

    // HS-8572 — skip the re-render when the fresh payload matches what
    // is currently painted into the slot. Avoids 30 s tick re-builds
    // wiping scroll / hover / drilldown state when nothing's changed.
    const fresh = JSON.stringify(payload);
    cachedAnalyticsPayloads.set(key, payload);
    if (lastPaintedAnalyticsFor.get(bodySlot) === fresh) return;

    const hasData = payload.windowTotals.allTime.promptCount > 0 || payload.windowTotals.allTime.cost > 0;
    if (!hasData) clearDashboardSlots();
    bodySlot.replaceChildren(renderBody(payload, active.secret));
    lastPaintedAnalyticsFor.set(bodySlot, fresh);
  } catch (err) {
    // HS-8572 — keep showing cached data when a poll-tick fetch fails
    // (server restart, transient blip). Only paint the error state
    // when we have nothing to fall back on.
    if (cached !== undefined) return;
    clearDashboardSlots();
    const message = err instanceof Error ? err.message : String(err);
    bodySlot.replaceChildren(renderErrorBlock(message));
  }
}

/** HS-8572 — start the live-refresh poll. Each tick re-fetches the
 *  currently-active project + window silently. Stops itself when the
 *  bodySlot is no longer in the document (the analytics dashboard's
 *  teardown removes the surrounding subtree) or when the active
 *  project has changed (different surface now). */
function startAnalyticsPolling(bodySlot: HTMLElement, getWindow: () => TelemetryWindow, projectSecret: string): void {
  stopAnalyticsPolling();
  analyticsPollIntervalId = setInterval(() => {
    if (!document.body.contains(bodySlot)) { stopAnalyticsPolling(); return; }
    const active = getActiveProject();
    if (active === null || active.secret !== projectSecret) { stopAnalyticsPolling(); return; }
    void fetchAndPopulate(bodySlot, getWindow());
  }, ANALYTICS_POLL_INTERVAL_MS);
}

function stopAnalyticsPolling(): void {
  if (analyticsPollIntervalId !== null) {
    clearInterval(analyticsPollIntervalId);
    analyticsPollIntervalId = null;
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
export function renderAnalyticsTelemetrySection(days?: number): HTMLElement {
  // HS-8512 — telemetry window is now driven by the analytics
  // dashboard's top-level 7/30/90 day range bar, removing the
  // redundant per-section selector. `days` is the caller-supplied
  // active value from `dashboard.tsx::currentDays`; we map it to
  // the matching `TelemetryWindow` so the underlying fetch shape
  // stays unchanged. Falls back to the module-state default if no
  // value is passed (test / standalone callers).
  if (days !== undefined) {
    const mapped = mapDaysToWindow(days);
    if (mapped !== null) currentWindow = mapped;
  }

  const root = toElement(
    <div className="analytics-telemetry-section">
      <div className="analytics-telemetry-header">
        <h2 className="analytics-telemetry-title">Claude usage</h2>
      </div>
      <div className="analytics-telemetry-body-slot" id="analytics-telemetry-body"></div>
    </div>
  );

  const bodySlot = root.querySelector<HTMLElement>('#analytics-telemetry-body');
  if (bodySlot === null) return root;

  void fetchAndPopulate(bodySlot, currentWindow);

  // HS-8572 — start the live-refresh poll so a `claude` run in the
  // currently-active project shows up on the analytics section without
  // the user closing + re-opening the dashboard. Poll tied to bodySlot
  // presence + active project secret so it self-stops on teardown /
  // project switch.
  const active = getActiveProject();
  if (active !== null) {
    startAnalyticsPolling(bodySlot, () => currentWindow, active.secret);
  }

  return root;
}

/** HS-8512 — map the analytics-dashboard's `currentDays` (7 / 30 / 90)
 *  to the matching telemetry `TelemetryWindow` value. Returns null for
 *  unknown / unsupported values so callers can decide their own
 *  fallback. */
function mapDaysToWindow(days: number): TelemetryWindow | null {
  if (days === 7) return 'week';
  if (days === 30) return 'month';
  if (days === 90) return '90d';
  return null;
}

/** Test-only escape hatch. */
export const _testing = {
  renderBody,
  renderEmptyPlaceholder,
  setWindow(w: TelemetryWindow): void { currentWindow = w; },
  getWindow(): TelemetryWindow { return currentWindow; },
  // HS-8572 — cache + poll lifecycle accessors. Tests should call
  // `resetHS8572()` in `beforeEach`/`afterEach` so a stale cache or a
  // still-running interval from one test can't leak into the next.
  resetHS8572(): void {
    cachedAnalyticsPayloads.clear();
    stopAnalyticsPolling();
  },
  fetchAndPopulate,
  startAnalyticsPolling,
  stopAnalyticsPolling,
  getCacheSizeHS8572(): number { return cachedAnalyticsPayloads.size; },
  hasCachedHS8572(projectSecret: string, w: TelemetryWindow): boolean {
    return cachedAnalyticsPayloads.has(cacheKey(projectSecret, w));
  },
  isPollingHS8572(): boolean { return analyticsPollIntervalId !== null; },
};
