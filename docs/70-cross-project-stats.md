# 70. Cross-project stats page

> **Status (shipped 2026-05-21):** Phase 3 of the HS-8503 telemetry-surface reshape; the full reshape (Phases 3 / 4 / 5) is now landed. Replaces the (renamed) telemetry dashboard surface from §69.

The Cross-project stats page is a full-window surface that renders cross-project rollups of every signal Hot Sheet's OTLP receiver has captured. It answers questions like *"how much did I spend on Claude this month across every project"*, *"which project gets the bulk of my budget"*, *"how has cost trended over the last 90 days"*, *"what time of day do I actually use Claude"*, and *"how does cost split across models over the last 30 days."*

It uses the same data source as the §67 telemetry stack (`otel_metrics` + `otel_events`), no precomputed rollup tables.

This doc supersedes §69 for everything except the historical pre-reshape context. §69 is preserved verbatim for that history; new development reads here.

## 70.1 Goal

Provide a single entry point for every cross-project telemetry view in Hot Sheet. The page is conditional — it appears only when at least one registered project has `telemetry_enabled === true` — so users who haven't opted into telemetry don't see chrome they don't need.

## 70.2 Entry points

### Header-bar button (primary, NEW in HS-8507)

A new icon button `#cross-project-stats-toggle` sits in the app header immediately to the right of `#terminal-dashboard-toggle`. Lucide `line-chart` glyph (`<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>`), tooltip "Cross-project stats". Hidden via `style="display:none"` at server-render time; the client reveals it whenever the visibility gate (§70.3) returns `true`.

Clicking the button invokes `showCrossProjectStatsPage()` from `src/client/crossProjectStatsPage.tsx`, which takes over the main view region using the same swap pattern as the analytics dashboard (`#ticket-list` → `#dashboard-container`, toolbar / detail panel / batch toolbar hidden). Clicking any project tab, any sidebar entry, or the terminal-dashboard toggle returns to the previous view via the existing `restoreTicketList()` callback path wired into `bindSidebar`.

### Legacy sidebar entry (removed)

The pre-reshape sidebar entry `#sidebar-section-telemetry` (HS-8479) was kept alive during the Phase 3 / 4 migration so users always had access to the surface while the analytics-dashboard per-project section landed. HS-8509 (Phase 5) removed it in full; the header button is now the only entry point.

## 70.3 Visibility gate

The header button is gated by the same `anyProjectHasTelemetryEnabled(): Promise<boolean>` helper that gated the (now-removed) legacy sidebar entry — implemented server-side and surfaced via `GET /api/telemetry/enabled-anywhere` (`{ enabled: boolean }`). Client polling is event-driven: the visibility is refreshed once at boot and again on every Settings → Telemetry master-toggle PATCH (the dialog calls `refreshTelemetrySidebarVisibility()` after the PATCH — the function name is preserved for the duration of one more session for diff hygiene; a follow-up sweep renames it).

## 70.4 Page layout

Top-to-bottom inside the page body:

1. **Header row.** Page title "Cross-project stats" + window selector `<select>` with five options: `today` / `week` / `month` (default) / `90d` / `all`. The window selector narrows every section below it; window selector changes trigger a fresh `GET /api/telemetry/dashboard` round-trip (not live — per the §67.6 "look at the numbers, not a live monitor" policy).
2. **Window-total chips.** Four monospace dollar-amount tiles: Today / This week / This month / All time. Always rendered (regardless of the window selector); the selector only narrows the sections below.
3. **Cost over time.** Stacked-area chart rendered by `renderCostOverTimeChart` from §70.5 (shared with the per-project analytics-dashboard section in HS-8508). Stacked / By project mode toggle visible only when 2+ projects are present in the data — both modes render identically for a single-project slice.
4. **Cost by project.** Sortable table — Project / Cost / Tokens / Prompts / Last activity columns. Sort ascending or descending per column with a `▲` / `▼` indicator on the active sort header. Row click switches to that project and opens the analytics dashboard (which carries the per-project "Claude usage" sub-region from §71).
5. **Cost by model.** SVG donut + legend. Per-slice color from `MODEL_DONUT_COLORS` (cycled), one row per model with percent + absolute cost. Single-slice case shows a "100% — only one model used this window." caption.
6. **Hourly activity heatmap.** 7×24 grid, Monday-first rows (PostgreSQL `EXTRACT(DOW)` returns Sunday=0; the renderer rotates by `(dow + 6) % 7`). Five-step logarithmic opacity scale on `currentColor` so SCSS theme drives the accent.

**NOT rendered:** the top-10-most-expensive-prompts list. Removed per HS-8503 user feedback — cross-project prompt drilldown isn't useful at this surface. The legacy `topExpensivePrompts` field was dropped from both the wire response and the `getTopExpensivePrompts` server query under HS-8509.

## 70.5 Cost-over-time chart

Shared component (§70.4 #3 here, also consumed by HS-8508 per-project section). Lives in `src/client/telemetryCostOverTimeChart.tsx` (HS-8506). Pure render — no fetching; the caller hands over the densified `CostOverTimePoint[]` from HS-8505.

Two render modes:

- **Stacked.** All (project, model) bands stacked on the same y-axis. Total column height on day D = total cross-project cost on D. Bands sorted by project alpha → model alpha for visual stability across re-renders.
- **By project.** Per-project sub-stacks overlaid on the same axes, each starting at y = 0. The project group carries `fill-opacity: 0.6` so overlaps stay readable. Models stay stacked within each project.

The mode toggle (`<button>` pair above the chart) is hidden when only one project is present in the data — both modes render identically and the chrome would be noise.

**Tooltips.** Each band carries an SVG-native `<title>` element: `{date} — {projectLabel} / {model}: {cost}`. No JS event handlers needed; works in every browser.

**Color resolution.** Per-project base from `MODEL_DONUT_COLORS` cycled by index. Models within a project differentiated by an opacity step (`1 - 0.18 * modelIdx`, clamped at `0.46` minimum) so the same project family stays visually coherent.

**Axes.** Y-axis has 5 gridline ticks at evenly-spaced fractions of a `niceMax`-rounded bound (next 1 / 2 / 5 × 10^N step). X-axis renders date tick labels formatted `MMM D`, spaced ⌈dateCount / 8⌉ days apart so labels never overlap.

## 70.6 Data flow

Single bundled round-trip per refresh: `GET /api/telemetry/dashboard?window=<window>&tz=<IANA timezone>` returns a `DashboardPayload` shape with the following fields (post-HS-8505):

```ts
interface DashboardPayload {
  window: 'today' | 'week' | 'month' | '90d' | 'all';
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals; allTime: WindowTotals };
  costByProject: ProjectCostRow[];
  costByModel: ModelRollup[];
  hourlyActivity: HourlyActivityCell[];
  costOverTime: CostOverTimePoint[];
}
```

Re-fetch triggers: page mount + every window-selector change. NOT live — no polling, no subscription. The user reloads or reopens the page to refresh.

## 70.7 Return path

The page is a "takeover" view sharing the analytics-dashboard's `#dashboard-container` slot. The existing `restoreTicketList()` callback wired into `bindSidebar` handles the reverse path: clicking any sidebar entry, project tab, or the terminal-dashboard toggle restores `#ticket-list` and tears down the page chrome.

## 70.8 Implementation map

- **`src/client/crossProjectStatsPage.tsx`** — page render + entry point. Renamed from `telemetryDashboard.tsx` under HS-8507.
- **`src/client/telemetryCostOverTimeChart.tsx`** — shared chart component (HS-8506).
- **`src/client/telemetryColors.ts`** — `MODEL_DONUT_COLORS` palette, shared by the page + the chart.
- **`src/client/telemetrySidebar.tsx`** — visibility gate + click routing for the header button (legacy sidebar listener removed under HS-8509).
- **`src/routes/pages.tsx`** — server-rendered HTML carries the `#cross-project-stats-toggle` button immediately after `#terminal-dashboard-toggle`.
- **`src/routes/telemetry.ts`** — `GET /api/telemetry/dashboard` + `GET /api/telemetry/enabled-anywhere` routes.
- **`src/db/otelQueries.ts`** — `getDashboardPayload` returns the post-HS-8509 shape (cost-over-time densified series, no `topExpensivePrompts`).

## 70.9 Status

**Shipped (full reshape complete 2026-05-21):**
- HS-8505 (Phase 1) — `getCostOverTime` backend query + per-project payload.
- HS-8506 (Phase 2) — shared cost-over-time chart component.
- HS-8507 (Phase 3) — header button, page rename, top-10 removal, cost-over-time chart integration, this doc.
- HS-8508 (Phase 4) — per-project analytics-dashboard telemetry sub-region (§71). Reuses §70.5's shared chart with a single-project slice.
- HS-8509 (Phase 5) — drop the legacy sidebar entry, drop the drawer Telemetry tab, rewire the per-tab cost chip to the analytics dashboard, drop the `showTelemetryDashboard` alias + the `topExpensivePrompts` wire field + its server query.
