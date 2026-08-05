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

import type { SafeHtml } from 'kerfjs';

import { type CostAvailability, costAvailabilityFor, costAvailabilityNote } from '../aiTools/costAvailability.js';
import { getPlugin } from '../aiTools/registry.js';
import { getProjectRollup } from '../api/index.js';
import { byIdOrNull, toElement } from './dom.js';
import { projectScoped } from './projectScoped.js';
import { getActiveProject } from './state.js';
import { type CostOverTimePoint, renderCostOverTimeChart } from './telemetryCostOverTimeChart.js';
import { formatCost, formatTokens } from './telemetryFormat.js';
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
  /** HS-9607 — reasoning tokens, a BREAKDOWN of `outputTokens` (never an
   *  addend). Optional so an older server's payload still renders. */
  reasoningOutputTokens?: number;
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

// HS-8766 — Announcer usage view-model (always real $$; the user's own key).
interface AnnouncerUsageTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
  generations: number;
}

interface ProjectRollupPayload {
  window: TelemetryWindow;
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByModel: ModelRollupRow[];
  toolLatencyHistogram: ToolLatencyHistogramRow[];
  recentPrompts: RecentPromptRow[];
  costOverTime: CostOverTimePoint[];
  /** HS-8810 — days with ≥1 ingested metric point (shade no-telemetry days). */
  ingestedDates?: string[];
  announcer?: AnnouncerUsageTotals;
  /** HS-9602 — the AI tool(s) whose telemetry this payload holds. Optional so an
   *  older server's payload still renders (the title stays generic). */
  emitters?: string[];
}

let currentWindow: TelemetryWindow = 'month';

// HS-8572 — per-(projectSecret, window) payload cache. Re-entering
// the analytics dashboard (closing + re-opening the project's
// analytics widget) paints the cached payload immediately instead of
// the "Loading Claude usage…" placeholder. Background fetch refreshes
// in place.
//
// HS-9418 (docs/126) — was a hand-rolled `Map<"<secret>|<window>", …>`. The
// project dimension moved into the primitive, leaving a plain per-window Map
// inside each project's cell: one convention, automatic eviction when a project
// is unregistered (it grew unboundedly before), and coverage by the generic
// A→B→A isolation harness.
const cachedAnalyticsPayloads = projectScoped(
  () => new Map<TelemetryWindow, ProjectRollupPayload>(),
  'analytics.cachedPayloads',
);

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

// HS-8566 — see `telemetryFormat.ts`. `formatCost` now hides cents for
// values >= $1000 with half-up rounding + thousands separators.
// HS-8670 — `formatTokens` likewise moved to `telemetryFormat.ts`.

function resolveTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/**
 * HS-9605 — the cost line of a chip.
 *
 * `unavailable` shows an em dash, never `$0.00`: a zero reads as "this work was
 * free", which is a stronger and more wrong claim than "we don't know". Codex
 * reports no cost at all, so this is the codex case.
 *
 * `partial` still shows the figure — it is real — but marks it as an UNDER-count
 * and says which tool is missing. That is the sharper case: an unqualified total
 * over a mixed Claude+codex window looks perfectly normal while silently
 * omitting every codex turn.
 */
function renderChipCost(totals: WindowTotals, cost: CostAvailability): SafeHtml {
  const note = costAvailabilityNote(cost);
  if (cost.status === 'unavailable') {
    return <div className="telemetry-chip-cost telemetry-chip-cost-unavailable" title={note ?? ''}>—</div>;
  }
  const baseTitle = 'Cost is the amount the AI tool reports for this work. It includes cache tokens and any 1M-context rate premium, so it can exceed a naive estimate from the input/output tokens above.';
  if (cost.status === 'partial') {
    return (
      <div className="telemetry-chip-cost telemetry-chip-cost-partial" title={`${note ?? ''} ${baseTitle}`}>
        {formatCost(totals.cost)}<span className="telemetry-chip-cost-flag" aria-hidden="true">*</span>
      </div>
    );
  }
  return <div className="telemetry-chip-cost" title={baseTitle}>{formatCost(totals.cost)}</div>;
}

function renderWindowChip(label: string, totals: WindowTotals, cost: CostAvailability): HTMLElement {
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
  const reasoning = totals.reasoningOutputTokens ?? 0;
  return toElement(
    <div className="telemetry-chip">
      <div className="telemetry-chip-label">{label}</div>
      {renderChipCost(totals, cost)}
      <div className="telemetry-chip-meta">
        {formatTokens(totals.tokens)} tokens · {String(totals.promptCount)} prompts
      </div>
      {hasSplit
        ? <div className="telemetry-chip-submeta">{`${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out`}</div>
        : null}
      {hasCache
        ? <div className="telemetry-chip-submeta telemetry-chip-submeta-cache">{`${formatTokens(cacheRead)} cache read · ${formatTokens(cacheCreation)} cache write`}</div>
        : null}
      {/* HS-9607 — reasoning is INSIDE the output figure above, so it is
          phrased as "of which" rather than listed as another addend. Only
          rendered when non-zero: no tool but codex reports it, and a
          permanent "0 reasoning" would be noise on every Claude dashboard. */}
      {reasoning > 0
        ? <div className="telemetry-chip-submeta" title="Reasoning tokens are part of the output total above, not additional to it.">{`${formatTokens(reasoning)} of that reasoning`}</div>
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
  return toElement(<div className="analytics-telemetry-loading">Loading Claude Usage…</div>);
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
  // HS-8766 — announcer usage counts as data too, so a project that only uses
  // the Announcer (no Claude Code telemetry) still renders its spend.
  const hasData = payload.windowTotals.allTime.promptCount > 0
    || payload.windowTotals.allTime.cost > 0
    || (payload.announcer?.generations ?? 0) > 0;
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
  const cost = costAvailabilityFor(payload.emitters ?? []);
  populateDashboardSlots(payload, body);

  // Cost over time (per-project — the chart's mode toggle is hidden
  // automatically because the slice carries only one project).
  if (payload.costOverTime.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="cost-over-time">
        <h3>Cost Over Time</h3>
      </section>
    );
    appendCostCaveat(section, cost);
    section.appendChild(renderCostOverTimeChart(payload.costOverTime, {
      formatCost,
      resolveProjectLabel: (secret) => secret === activeSecret ? 'This project' : secret.slice(0, 8),
      ingestedDates: payload.ingestedDates, // HS-8810 — shade no-telemetry days
    }));
    body.appendChild(section);
  }

  // Cost by model (per-project variant of the donut from the cross-
  // project page).
  if (payload.costByModel.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="cost-by-model">
        <h3>Cost by Model</h3>
      </section>
    );
    appendCostCaveat(section, cost);
    section.appendChild(renderCostByModelDonut(payload.costByModel, { formatCost }));
    body.appendChild(section);
  }

  // Per-tool latency histograms.
  if (payload.toolLatencyHistogram.length > 0) {
    const section = toElement(
      <section className="telemetry-section analytics-telemetry-section-block" data-section="tool-latency">
        <h3>Tool Latency Distribution</h3>
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
        <h3>Recent Prompts</h3>
      </section>
    );
    section.appendChild(renderRecentPromptsList(payload.recentPrompts));
    body.appendChild(section);
  }

  // HS-8766 — Announcer token + cost for this project (the user's own
  // Anthropic API spend; always real $$, independent of the subscription-mode
  // toggle). Only shown when there's been at least one generation in the window.
  if (payload.announcer !== undefined && payload.announcer.generations > 0) {
    body.appendChild(renderAnnouncerSection(payload.announcer));
  }

  return body;
}

/** HS-8766 — the per-project "Announcer" usage card. */
function renderAnnouncerSection(a: AnnouncerUsageTotals): HTMLElement {
  return toElement(
    <section className="telemetry-section analytics-telemetry-section-block" data-section="announcer">
      <h3>Announcer <span className="announcer-usage-sub">narration spend (your API key)</span></h3>
      <div className="announcer-usage-stats">
        <div className="announcer-usage-stat">
          <div className="announcer-usage-value">{formatCost(a.cost)}</div>
          <div className="announcer-usage-label">cost</div>
        </div>
        <div className="announcer-usage-stat">
          <div className="announcer-usage-value">{formatTokens(a.inputTokens + a.outputTokens)}</div>
          <div className="announcer-usage-label">{`tokens · ${formatTokens(a.inputTokens)} in / ${formatTokens(a.outputTokens)} out`}</div>
        </div>
        <div className="announcer-usage-stat">
          <div className="announcer-usage-value">{String(a.generations)}</div>
          <div className="announcer-usage-label">{a.generations === 1 ? 'generation' : 'generations'}</div>
        </div>
      </div>
    </section>
  );
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
  // HS-9605 — judged from WHO produced the window's telemetry (HS-9602), so a
  // tool that reports no cost (codex) shows a dash rather than `$0.00`.
  const cost = costAvailabilityFor(payload.emitters ?? []);
  const chipsEl = toElement(<div className="telemetry-window-chips analytics-telemetry-chips"></div>);
  chipsEl.appendChild(renderWindowChip('Today', payload.windowTotals.today, cost));
  chipsEl.appendChild(renderWindowChip('This week', payload.windowTotals.week, cost));
  chipsEl.appendChild(renderWindowChip('This month', payload.windowTotals.month, cost));
  chipsEl.appendChild(renderWindowChip('All time', payload.windowTotals.allTime, cost));

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

/**
 * HS-9602 — the section's heading, derived from WHOSE telemetry the window
 * actually holds.
 *
 * It used to be the literal string "Claude Usage". Renaming it to the project's
 * `ai_tool` would have been worse than leaving it: a codex project would claim
 * "Codex Usage" over Claude's data, or over an empty chart. So the label follows
 * the payload — one tool names it, several stay neutral, none keeps the generic
 * heading rather than asserting a vendor over a blank panel.
 *
 * `productName` comes from the `AiToolPlugin` registry (docs/132), so adding a
 * tool does not touch this file.
 */
export function telemetrySectionTitle(emitters: readonly string[]): string {
  const named = emitters
    .map(id => getPlugin(id)?.productName)
    .filter((n): n is string => typeof n === 'string' && n !== '');
  // One recognized tool and nothing unrecognized alongside it — name it.
  if (named.length === 1 && emitters.length === 1) return `${named[0]} Usage`;
  return 'AI Usage';
}

/** Repaint the heading for a payload. Separate from `renderBody` because the
 *  heading lives OUTSIDE the body slot the body replaces wholesale. */
function applySectionTitle(emitters: readonly string[]): void {
  const el = document.getElementById('analytics-telemetry-title');
  if (el !== null) el.textContent = telemetrySectionTitle(emitters);
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
  const cached = cachedAnalyticsPayloads.get().get(w);
  if (cached !== undefined) {
    const cachedSerialized = JSON.stringify(cached);
    if (lastPaintedAnalyticsFor.get(bodySlot) !== cachedSerialized) {
      const cachedHasData = cached.windowTotals.allTime.promptCount > 0 || cached.windowTotals.allTime.cost > 0;
      if (!cachedHasData) clearDashboardSlots();
      bodySlot.replaceChildren(renderBody(cached, active.secret));
      applySectionTitle(cached.emitters ?? []);
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
    cachedAnalyticsPayloads.get().set(w, payload);
    if (lastPaintedAnalyticsFor.get(bodySlot) === fresh) return;

    const hasData = payload.windowTotals.allTime.promptCount > 0 || payload.windowTotals.allTime.cost > 0;
    if (!hasData) clearDashboardSlots();
    bodySlot.replaceChildren(renderBody(payload, active.secret));
    applySectionTitle(payload.emitters ?? []);
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
/**
 * The caveat line under a cost heading, when the window's cost cannot be shown
 * in full (HS-9605).
 *
 * The chart and donut are already data-gated, so a codex-only window renders
 * neither and needs nothing. The case this exists for is `partial`: real Claude
 * cost plotted over a window that ALSO contains codex turns, where the shape
 * looks complete and is quietly an under-count. A dash cannot express that — a
 * sentence can.
 */
function appendCostCaveat(section: HTMLElement, cost: CostAvailability): void {
  const note = costAvailabilityNote(cost);
  if (note === null) return;
  section.appendChild(toElement(<p className="telemetry-cost-caveat">{note}</p>));
}

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
        <h2 className="analytics-telemetry-title" id="analytics-telemetry-title">AI Usage</h2>
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
  // HS-9605 — the chips live in dashboard SLOTS outside `renderBody`, so the
  // cost-unavailable rendering needs its own handle to be testable.
  renderWindowChip,
  renderEmptyPlaceholder,
  setWindow(w: TelemetryWindow): void { currentWindow = w; },
  getWindow(): TelemetryWindow { return currentWindow; },
  // HS-8572 — cache + poll lifecycle accessors. Tests should call
  // `resetHS8572()` in `beforeEach`/`afterEach` so a stale cache or a
  // still-running interval from one test can't leak into the next.
  resetHS8572(): void {
    cachedAnalyticsPayloads.clearAllScopes();
    stopAnalyticsPolling();
  },
  fetchAndPopulate,
  startAnalyticsPolling,
  stopAnalyticsPolling,
  /** HS-9418 — now the ACTIVE project's cached-window count (the cache is
   *  per-project). Tests that previously asserted a cross-project total should
   *  activate each project and assert its own count. */
  getCacheSizeHS8572(): number { return cachedAnalyticsPayloads.get().size; },
  /** HS-9418 — answers for the ACTIVE project only; a cell can't be read from
   *  outside its scope. Activate the project first, then ask. */
  hasCachedHS8572(w: TelemetryWindow): boolean {
    return cachedAnalyticsPayloads.get().has(w);
  },
  isPollingHS8572(): boolean { return analyticsPollIntervalId !== null; },
};
