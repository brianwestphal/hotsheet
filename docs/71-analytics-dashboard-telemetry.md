# 71. Analytics-dashboard telemetry sections

> **Status (shipped 2026-05-21):** Phase 4 of the HS-8503 telemetry-surface reshape; the full reshape (Phases 3 / 4 / 5) is now landed.

The analytics dashboard (`src/client/dashboard.tsx` — opened by the sidebar widget at the top of the sidebar) now carries a "Claude usage" sub-region beneath the existing ticket charts. All sections are scoped to the **active project** — matching the analytics dashboard's existing per-project orientation.

## 71.1 Goal

Give the user a single per-project surface where they can see both ticket-flow metrics (throughput, cycle time, cumulative flow) AND Claude-usage metrics (cost, model breakdown, tool latency, recent prompts) side by side. The cross-project view stays in §70 for "how do the projects compare" questions; this surface answers "how am I using Claude on THIS project."

## 71.2 Entry point

No new entry point. The analytics dashboard's existing sidebar-widget click handler (`src/client/dashboardMode.tsx::enterDashboardMode`) already mounts the dashboard. The new telemetry sub-region is appended to `buildDashboard`'s output, so opening the analytics dashboard is the only step required to see it.

**HS-8542 (2026-05-22) — tab-click dismiss-to-tickets.** Clicking the active project's own tab while the analytics dashboard is the visible surface calls `toggleDashboardMode()` (instead of `switchProject`, which is a no-op for the already-active project) so the dashboard tears down and the regular ticket view returns at the previously-active `state.view`. Clicking a *different* project's tab continues to switch projects normally; the dashboard re-renders with the new project's data. Wired in `src/client/projectTabs.tsx`'s row-click handler with a lazy `await import('./dashboardMode.js')` to keep the dashboard-mode module out of the project-tabs initial bundle.

## 71.3 Section layout

Top-to-bottom inside `.analytics-telemetry-section` (appended below the existing chart grid):

1. **Section header.** Title "Claude usage" + window selector (today / week / month / 90d / all). The selector is **independent** of the analytics dashboard's existing 7d / 30d / 90d ticket-range buttons — ticket data and telemetry data answer different questions and the user picks each window separately.
2. **Subscription-cost disclaimer (HS-8543).** Always-visible gray rounded notice with a lucide asterisk icon, single sentence reading "For users with Claude Pro / Max / other subscriptions, the costs shown are estimates only, based on API-equivalent usage." Sits above the chips and is rendered via the shared `renderSubscriptionDisclaimer` helper in `src/client/telemetrySubscriptionDisclaimer.tsx`. The same helper is reused on the cross-project page §70. Distinct from the HS-8497 `.telemetry-subscription-notice` accent banner (which only fires when `cost_mode === 'subscription'`).
3. **Window-total chips.** Four monospace dollar-amount tiles: Today / This week / This month / All time, laid out as a 4-column CSS grid that fills the dashboard width (mirrors §70's cross-project page layout — HS-8536). Always rendered regardless of the window selector — the selector only narrows the sections below.
4. **Cost over time.** Per-project variant of the shared chart from §70.5 / HS-8506. The chart's **Stacked / By project** mode toggle is hidden automatically because the slice carries only one project (the active one). The chart accepts a `resolveProjectLabel` opt; this surface passes a label resolver that returns `"This project"` for the active project's secret so the tooltip reads naturally.
5. **Cost by model.** Donut + legend via the shared `renderCostByModelDonut` from `src/client/telemetryModelDonut.tsx` (extracted from `crossProjectStatsPage.tsx` under HS-8508 — both surfaces share the same render).
6. **Per-tool latency histograms.** Per-tool count + p50 / p90 / p99 + bucketed `<svg>` bars via the shared `renderToolHistogramRow` from `src/client/telemetryToolHistogram.tsx` (extracted from `telemetryDrawer.tsx` under HS-8508).
7. **10 most recent prompts.** Sorted by `ts DESC` (NOT by cost — that's the cross-project surface's behavior, removed). Each row click opens the existing `openPromptDrilldown(promptId)` modal from HS-8149. Rendered via the shared `renderRecentPromptsList` from `src/client/telemetryRecentPromptsList.tsx` (also extracted from `telemetryDrawer.tsx`).

## 71.4 Empty state

When the active project has telemetry off OR no telemetry rows in the all-time slice, the section renders a small inline placeholder (`.analytics-telemetry-empty`) with copy explaining how to enable telemetry. The analytics dashboard's ticket charts above keep rendering normally — this is **NOT a blocking modal**, just an inline note beneath the chart grid.

Detection is purely data-driven: `payload.windowTotals.allTime.promptCount === 0 && payload.windowTotals.allTime.cost === 0` ⇒ empty placeholder. The page does not distinguish between "telemetry off" and "telemetry on but no exports yet" — both states show the same placeholder, and the copy tells the user how to enable in either case.

## 71.5 Data source

Single bundled round-trip per render: `GET /api/telemetry/project-rollup?window=<window>&tz=<IANA timezone>` from HS-8505. The route reads the active project's secret from the `X-Hotsheet-Secret` middleware (no `?project=` query parameter) and returns a `ProjectRollupPayload`:

```ts
interface ProjectRollupPayload {
  window: 'today' | 'week' | 'month' | '90d' | 'all';
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByModel: ModelRollupRow[];
  toolLatencyHistogram: ToolLatencyHistogramRow[];
  recentPrompts: RecentPromptRow[];
  costOverTime: CostOverTimePoint[];
}
```

Re-fetch triggers: section mount + every window-selector change. NOT live — no polling, no subscription. The user reloads or reopens the analytics dashboard to refresh.

## 71.6 Shared helpers extracted under HS-8508

To avoid copy-pasting renderers from `crossProjectStatsPage.tsx` and `telemetryDrawer.tsx`, three small modules were extracted to share between the cross-project page, the drawer (until HS-8509 retires it), and this analytics section:

- **`src/client/telemetryModelDonut.tsx`** — `renderCostByModelDonut(rows, opts)`. Extracted from `crossProjectStatsPage.tsx`. Both the cross-project page AND this section consume it.
- **`src/client/telemetryToolHistogram.tsx`** — `renderToolHistogramRow(row, opts)`. Extracted from `telemetryDrawer.tsx`. The drawer + this section consume it; HS-8509 retires the drawer but this section keeps it.
- **`src/client/telemetryRecentPromptsList.tsx`** — `renderRecentPromptsList(rows, opts)`. Extracted from `telemetryDrawer.tsx`. The helper's own delegated click handler opens the drilldown modal — consumers don't need to wire their own listener.

All three are pure render helpers; their opts accept callable formatters (`formatCost`, `formatDuration`, `formatTimestamp`) so each surface can pass its own conventions without forcing a single global format.

## 71.7 Implementation map

- **`src/client/analyticsTelemetrySection.tsx`** — section module. Exports `renderAnalyticsTelemetrySection()` (the entry point called by the analytics dashboard) and `_testing` (escape hatch for unit tests).
- **`src/client/dashboard.tsx`** — `buildDashboard` now appends `renderAnalyticsTelemetrySection()` below the chart grid.
- **`src/client/telemetryModelDonut.tsx`** / **`telemetryToolHistogram.tsx`** / **`telemetryRecentPromptsList.tsx`** — the three extracted shared modules.
- **`src/routes/telemetry.ts`** — `GET /api/telemetry/project-rollup` (unchanged from HS-8505 Phase 1).
- **`src/db/otelQueries.ts::getProjectRollupPayload`** — bundles the per-project payload (unchanged from HS-8505).
- **`src/client/styles.scss`** — `.analytics-telemetry-*` rules under the "HS-8508 / §71" section header.

## 71.8 Status

**Shipped (full reshape complete 2026-05-21):**
- HS-8505 (Phase 1) — `getCostOverTime` + per-project payload backend.
- HS-8506 (Phase 2) — shared cost-over-time chart.
- HS-8507 (Phase 3) — cross-project stats page (§70).
- HS-8508 (Phase 4) — analytics-dashboard telemetry section + the three extracted shared helpers + this doc.
- HS-8509 (Phase 5) — drop the legacy sidebar entry, drop the drawer Telemetry tab, rewire the per-tab cost chip (HS-8147) from drawer-preview to the analytics dashboard, drop the `showTelemetryDashboard` alias + the `topExpensivePrompts` wire response field + its server query.
