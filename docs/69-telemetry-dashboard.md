# 69. Cross-project telemetry dashboard — SUPERSEDED

> # ⚠️ SUPERSEDED — DO NOT USE AS A LIVE SPEC
>
> **This document describes the pre-HS-8503 cross-project telemetry shape and is preserved for historical context only.** The HS-8503 reshape (all 5 sub-phases shipped 2026-05-21 — HS-8505 / HS-8506 / HS-8507 / HS-8508 / HS-8509) replaced this surface in full.
>
> **For the current cross-project stats page** — header-bar icon next to `#terminal-dashboard-toggle`, full-window takeover, no top-10 expensive prompts list — see **[`70-cross-project-stats.md`](70-cross-project-stats.md)**.
>
> **For the per-project telemetry rollups** that used to live in the drawer Telemetry tab — now appearing as the analytics dashboard's "Claude usage" sub-region — see **[`71-analytics-dashboard-telemetry.md`](71-analytics-dashboard-telemetry.md)**.
>
> The legacy sidebar Telemetry entry, the drawer Telemetry tab, and the cross-project top-10-expensive-prompts list are all gone. §69.2 — §69.5 below describe the pre-HS-8503 design verbatim; §69.10 documents the reshape decisions and points at the new homes for each section in §70 / §71.

## 69.1 Goal

Add a new full-window view — accessible from a header-bar icon (HS-8503; was: left sidebar) — that renders **cross-project** rollups of every signal Hot Sheet's OTLP receiver has captured. The page answers questions like *"how much did I spend on Claude this month across every project"*, *"which project gets the bulk of my budget"*, *"what time of day do I actually use Claude"*, and *"how does cost split across models over the last 30 days."*

It uses the same data source as the (now-removed) drawer tab: live queries against `otel_metrics` + `otel_events`, no precomputed rollup tables (per §67.6).

## 69.2 Sidebar entry

### Visibility

The "Telemetry" sidebar entry is **conditional**: it appears only when **at least one project** has `telemetry_enabled === true` in its `<dataDir>/.hotsheet/settings.json`. When no project has telemetry on, the entry stays hidden — keeping the sidebar clean for users who haven't opted in.

Rationale per §69.1 clarifying-question answer: an always-visible entry adds chrome for every user; a data-presence-gated entry would flicker (telemetry on → no data yet → no entry → first row lands → entry appears). The project-settings gate is the right inflection — once the user opts in for any project, the surface is available.

Detection lives in a small server-side helper `anyProjectHasTelemetryEnabled(): Promise<boolean>` that iterates the registered projects (the existing `~/.hotsheet/projects.json` list per §2) + reads each `.hotsheet/settings.json::telemetry_enabled`. Hot path: this is queried once at sidebar render and again on every settings PATCH that touches `telemetry_enabled` (broadcast to the sidebar render via the existing `subscribeToBellState` cadence OR a more targeted refresh event — see §69.6).

### Placement

Sidebar order, top-to-bottom (preserving existing structure):

1. Project list (existing)
2. Search box (existing)
3. **Telemetry** (NEW — conditional)
4. Status views (existing — Open / Up Next / etc.)
5. Custom views (existing)

Visually styled like the existing top-level status entries — a `book-open` Lucide icon to the left of the label, hover background matches the existing `.sidebar-item`. Active state when the user is currently viewing the dashboard.

### Activation

Click switches the main view region from the ticket list / column view to a full-width dashboard. The active project context is suspended while the dashboard is up (no ticket actions, no detail panel). Clicking any project in the project list, or any other sidebar entry, returns to the normal project view.

## 69.3 Layout sections

Top-to-bottom inside the dashboard body:

### 69.3.1 Window-total chips (Today / Week / Month)

Three large monospace dollar-amount tiles laid out horizontally, each carrying its own window:

- **Today** — `ts >= midnight_local`
- **This week** — `ts >= start_of_week_local` (Monday — matching ISO week start for consistency)
- **This month** — `ts >= start_of_month_local`

Each tile shows: `$N.NN` cost, secondary line `N tokens · N prompts`. Click any tile → no-op for now (window-selector for the rest of the dashboard is a possible follow-up; see §69.5).

Reuses the existing `getWindowTotals(projectSecret: null, sinceTs)` query from `src/db/otelQueries.ts` — passing `null` for the project secret aggregates across every project, exactly as it does for the drawer's "all" scope.

### 69.3.2 Cost by project (sortable table)

One row per project that has at least one cost row in the selected window (default: this month). Columns:

- **Project** — display name (resolved from `~/.hotsheet/projects.json::name`, falling back to the data-dir basename when name is missing)
- **Cost** — total dollar cost
- **Tokens** — sum of input + output + cache tokens
- **Prompts** — count of distinct `prompt_id` values
- **Last activity** — most recent `ts` for this project (formatted as relative time: "12 min ago" / "yesterday" / "May 14")

Click a project row → switches the main view to that project's drawer Telemetry tab (HS-8148) — uses `switchProject(secret)` + `previewDrawerTab('telemetry')`, the same path the per-tab cost chip uses.

Sort: click a column header to sort ASC / DESC. Default sort: Cost DESC.

Backend: new query `getCostByProject(sinceTs)` in `src/db/otelQueries.ts` — `SELECT project_secret, SUM(cost), SUM(tokens), COUNT(DISTINCT prompt_id), MAX(ts) FROM otel_metrics m LEFT JOIN otel_events e USING (project_secret) WHERE ts >= $1 GROUP BY project_secret`. The client resolves project names from a lightweight `GET /api/projects/list` (existing — used by the project-tab strip).

### 69.3.3 Cost by model (SVG pie / stacked bar)

A small SVG donut chart (no chart library dep — matching the §67.10.5 inline-SVG precedent). Each slice = one model attribute value (`claude-sonnet-4-6`, `claude-opus-4-7`, etc.) sized by total cost in the selected window. Legend below the donut: model name + percentage + absolute dollar amount.

Reuses `getCostByModel(sinceTs, projectSecret: null)` from §67.10.2 with `projectSecret: null` for cross-project aggregation.

If only one model has activity, render a single-slice donut (still visually correct) plus a "100% — only one model used this window" caption.

### 69.3.4 7×24 hourly activity heatmap

A 7×24 grid of cells:

- **Rows:** days of the week (Mon → Sun, top-to-bottom)
- **Columns:** hours of the day (00 → 23, left-to-right)
- **Cell color:** intensity by cost contribution in that day-of-week × hour bucket (5-step scale: empty / low / medium / high / very-high)
- **Tooltip on hover:** "Wed 10:00 — $4.23 cost, 17 prompts"

The week is in the user's local timezone. The heatmap aggregates across the selected window (default: trailing 90 days, so weekly patterns have enough data to surface).

Why 7×24 (not a single 24-hour bar) per §69.1 clarifying-question answer: the 24-hour bar collapses the day-of-week axis, which is exactly where the interesting signal lives ("I only use Claude on weekdays" / "I cram weekend work into Sat morning"). The grid view exposes both axes for the same SVG cost (168 cells is well within an inline SVG's range).

Backend: new query `getHourlyActivityHeatmap(sinceTs)` — `SELECT EXTRACT(DOW FROM ts AT TIME ZONE 'local') AS dow, EXTRACT(HOUR FROM ts AT TIME ZONE 'local') AS hour, SUM(cost) AS total_cost, COUNT(DISTINCT prompt_id) AS prompt_count FROM otel_metrics WHERE metric_name = 'claude_code.cost.usage' AND ts >= $1 GROUP BY dow, hour`. Densified client-side so empty cells render as the empty-intensity color.

Color scale uses `currentColor` with opacity steps (`0.0 / 0.15 / 0.35 / 0.6 / 0.85 / 1.0`) so the eventual SCSS theme drives the accent color — matching the §67.10.5 histogram convention.

### 69.3.5 Top 10 most expensive prompts

Numbered list of the 10 prompts with the highest cost across every project in the selected window. Each row:

- Cost ($ — bolded)
- Project name (small chip on the right)
- Model
- First-line preview of the prompt body (truncated to ~80 chars from `claude_code.user_prompt.body_json.prompt_preview` if present, or `prompt_id` short hash as fallback)
- Relative timestamp

Click a row → opens the existing §67.10.3 per-prompt drilldown modal scoped to that `prompt_id`. The modal already exists; this surface just calls `openPromptDrilldown(promptId)`.

Backend: new query `getTopExpensivePrompts(sinceTs, limit = 10)` — joins per-prompt cost sums against the `user_prompt` event for preview text, returns the top N. The query already has the per-prompt cost shape from `getPerTicketRollup` (HS-8152); this is a non-ticket-correlated variant.

## 69.4 Data source

Every section above runs against the existing PGLite tables (`otel_metrics` + `otel_events`) via new + reused queries in `src/db/otelQueries.ts`. **No precomputed rollup tables** per §67.6 — at single-user scale even the most expensive query in this dashboard (the heatmap densification across 90 days) returns in <50 ms.

Bundled into a single new endpoint `GET /api/telemetry/dashboard?window=today|week|month|90d` that returns a `DashboardPayload`:

```ts
interface DashboardPayload {
  windowTotals: { today: WindowTotals; week: WindowTotals; month: WindowTotals };
  costByProject: ProjectCostRow[];
  costByModel: ModelCostRow[];
  hourlyActivity: HourlyActivityCell[]; // 168 entries densified
  topExpensivePrompts: TopPromptRow[];
}
```

One round-trip, one error point — matching the drawer-tab `getDrawerPayload` precedent. Re-fetched on dashboard mount + on window-selector change.

## 69.5 Empty state

When the user clicks the Telemetry sidebar entry but no cost rows exist for the selected window (or no rows exist at all), the dashboard renders an onboarding card:

> **Telemetry dashboard**
>
> No usage recorded yet. To start collecting, open Settings → Telemetry in any project, enable the master toggle, then run `claude` in a Hot Sheet terminal. Cost data appears here within a minute of the first prompt.
>
> [Open Settings] [Read docs/67-telemetry.md]

The "Open Settings" button calls into the existing `openSettings('telemetry')` path. The doc link opens externally via the Tauri-safe `openExternalUrl` route or `window.open` fallback.

When at least one project has telemetry enabled but the **selected window** is empty (e.g. user opens "Today" before any prompt has fired today), each empty section shows its own inline "No data for this window" placeholder; the broader onboarding card stays hidden because the user clearly knows about the feature.

## 69.6 Open questions

### Window selector for the whole dashboard

The current design hard-codes "Today / Week / Month" tiles at the top + uses "trailing 90 days" for the heatmap + "current month" for the cost-by-project table. A unified window selector ("show me everything for the last 7 days") is conceptually nice but adds UI complexity. Defer: ship with the per-section windows; if usage proves it's annoying, follow up with a single selector that overrides every section.

### Refresh cadence

The drawer Telemetry tab re-fetches on every tab activation (HS-8148). The dashboard could:

- Re-fetch on every dashboard mount + every visible tab focus (matches the drawer tab's cadence).
- Subscribe to `subscribeToBellState` for live refresh (the per-tab cost chip uses this).

Recommended: mount + focus, NOT live. The dashboard is a "look at the numbers" surface, not a live monitor; pulling on every bell-tick (5 s) is wasted bandwidth + would surprise the user with shifting bars. The per-tab cost chip can stay live because it's small + always visible.

### Per-project drill-in from the heatmap

Could a click on a `Wed 10:00` cell drill into "show me the prompts that ran during that bucket"? Probably yes, but defer until the heatmap proves useful enough that the drill-in would be the natural next step.

### Sidebar visibility refresh

When the user flips `telemetry_enabled` ON in Settings, the sidebar should pick up the new state and show the Telemetry entry. Two implementation options:

- Re-render the sidebar on every settings PATCH (existing `applyFileSettings` already broadcasts state changes — the sidebar can listen).
- Re-check on every bell-state tick (cheap, but laggy — the entry would appear up to 5 s after the toggle flips).

Recommended: settings PATCH broadcast — instant feedback when the user enables telemetry.

## 69.7 Out of scope (deferred)

- **Cost-budget alerts** ("you spent $50 this week, here's a notification"). Listed as a follow-up in §67.12. Stays out of scope here.
- **Per-tool cross-project breakdown** — the §67.10.5 per-tool latency histograms already exist per-project; a cross-project variant could land in the dashboard, but defer until the per-project view proves the need.
- **Per-ticket cross-project rollup** — HS-8152 shipped the per-ticket detail-panel block; surfacing top-cost tickets in this dashboard is a follow-up.
- **CSV / JSON export** of any section — defer.
- **Time-series chart** (cost-per-day stacked-area over the last 90 days) — defer; the heatmap + window-totals chips already answer the most common temporal questions.

## 69.8 Ticket map

| Ticket | Phase | Surface |
|---|---|---|
| HS-8153 | Foundation | This requirements doc |
| HS-8479 | Client + Backend | `anyProjectHasTelemetryEnabled()` helper + conditional Telemetry sidebar entry + activation routing |
| HS-8480 | Backend | New queries (`getCostByProject` + `getHourlyActivityHeatmap` + `getTopExpensivePrompts`) + bundled `GET /api/telemetry/dashboard?window=...` route + `DashboardPayload` |
| HS-8481 | Client | Dashboard view shell + window-totals chips + empty-state onboarding card |
| HS-8482 | Client | Cost-by-project sortable table + cost-by-model donut SVG + legend |
| HS-8483 | Client | 7×24 heatmap inline SVG + tooltip + top-10 expensive-prompts list with drilldown click-through |

## 69.9 References

- [67-telemetry.md](67-telemetry.md) §67.10.2 (per-project drawer tab, same data source), §67.10.6 (this surface, short-form), §67.6 (storage), §67.12 (alerts deferred).
- [68-telemetry-traces.md](68-telemetry-traces.md) — sibling beta-traces doc.
- `src/db/otelQueries.ts` — existing query module the new queries extend.
- `src/client/telemetryDrawer.tsx` — drawer-tab counterpart whose code patterns (scope toggle, bundled fetch, JSX render helpers) the dashboard reuses.

---

## 69.10 HS-8503 reshape — Cross-project stats page + analytics-dashboard integration

This section captures the **post-HS-8503 design** that supersedes the launch surface, the drawer tab, and several layout / drilldown decisions above. The data source + most of the existing queries from HS-8480 carry over.

### 69.10.1 Cross-project stats page (NEW, header-icon-launched)

**Entry point.** A new icon-only button in the app header, placed immediately after `#terminal-dashboard-toggle` (the leftmost button in the header chrome — see `src/routes/pages.tsx`). The icon is the Lucide line-chart glyph reused from the drawer Telemetry tab (`<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>`). Hover title: *"Cross-project stats."*

**Visibility gate.** Same as the pre-reshape sidebar entry: shown only when `anyProjectHasTelemetryEnabled()` returns `true` (at least one project has its `telemetry_enabled` setting on). The helper, the `GET /api/telemetry/enabled-anywhere` route, and the settings-PATCH-triggered refresh from HS-8479 all carry over unchanged — they just toggle a different DOM element.

**Activation.** Click swaps the main view region for the cross-project stats page (same swap pattern as `enterDashboardMode` / `showTelemetryDashboard`: hide toolbar + batch toolbar + detail panel, swap `#ticket-list` → `#dashboard-container`, render). Clicking any sidebar entry, project tab, or the terminal-dashboard toggle returns to the previous view via the existing `restoreTicketList()` callback path.

**Future scope (out of scope for HS-8503 but accommodated in the page name).** A follow-up ticket will extend this page with general cross-project metrics (ticket throughput across projects, cycle time across projects, etc.). The "Cross-project stats" naming is deliberate so the page name stays right when those non-telemetry sections land later. For HS-8503 the page contains telemetry sections only.

### 69.10.2 Cross-project stats page layout

Top-to-bottom inside the page body:

1. **Header row** — page title "Cross-project stats" + window selector dropdown (today / this week / this month / 90 days / all time).
2. **Window-total chips** — Today / This week / This month / All time tiles (per §69.3.1, unchanged).
3. **Cost over time (NEW — see §69.10.4)** — stacked-area / overlay chart driven by the window selector.
4. **Cost by project** — sortable table (per §69.3.2). Click a row → switches to that project and opens the **analytics dashboard** for that project (the new home of the per-project telemetry sections, see §69.10.5), NOT the drawer tab (which is removed).
5. **Cost by model** — donut + legend (per §69.3.3, unchanged).
6. **Hourly activity heatmap** — 7×24 day-of-week × hour grid (per §69.3.4, unchanged).

**REMOVED from the original §69 design:**

- **Sidebar entry** — replaced by the header icon.
- **Top-10 most expensive prompts list** — removed per HS-8503 feedback (cross-project prompt drilldown isn't useful at this surface; per-project drilldown lives on the analytics dashboard's recent-prompts list instead — see §69.10.5).

### 69.10.3 Pre-HS-8503 ticket-map status

The five pre-reshape implementation tickets and their post-reshape status:

| Pre-reshape ticket | Surface | HS-8503 status |
|---|---|---|
| HS-8479 | `anyProjectHasTelemetryEnabled()` + conditional sidebar entry + activation | Helper + endpoint carry over to gate the new header icon. The sidebar-entry render itself is removed by HS-8503's cleanup ticket. |
| HS-8480 | Backend queries + `GET /api/telemetry/dashboard?window=...` | Queries carry over. Endpoint gains a `costOverTime` field for §69.10.4. |
| HS-8481 | Dashboard view shell + chips + empty state | Replaced by the new header-icon-launched page; HS-8481 code in `src/client/telemetryDashboard.tsx` is the seed for the new page module. |
| HS-8482 | Cost-by-project table + cost-by-model donut | Carries over. |
| HS-8483 | Heatmap + top-10 prompts | Heatmap carries over. **Top-10 prompts list is removed.** |

### 69.10.4 Cost-over-time chart (NEW, shared with §69.10.5)

A new stacked-area chart that's reused on BOTH the cross-project stats page (cross-project variant) and the per-project analytics dashboard (per-project variant). One shared component, two render modes.

**Data shape.** Each data point is a `(date, projectSecret, model, costEstimateUsd)` tuple. The series cardinality is `D × P × M` where D = days in the window, P = project count, M = distinct-model count. At single-user scale this is well under 1000 points for a 90-day window across 10 projects and 4 models.

**Backend.** A new `getCostOverTime(window, sinceTs, projectSecret | null)` query in `src/db/otelQueries.ts`. Aggregates `claude_code.cost.usage` rows by `(DATE_TRUNC('day', ts AT TIME ZONE $tz), project_secret, attributes_json->>'model')`. Densifies missing days to zero client-side. Returns the tuple list above.

**View modes.**

- **Stacked.** Every (project, model) band stacked into a single area chart. Total height = total cross-project cost on that day. The legend groups bands by project, with model rows nested below each project group. *Best read of total spend over time.*
- **Overlay** (working name — the user asked for a "nicer name than overlay"). Per-project stacked-area sub-charts drawn on the same axes, all starting from y = 0, with translucent fill so overlaps are readable. Each project's bands are still stacked by model internally. *Best read of per-project shape comparison.* Working candidate names: **"Compare projects"**, **"By project"**, **"Layered"**, **"Side-by-side"**. **Decision deferred to the implementing ticket — pick the one that reads best in the UI.**

A toggle button-pair (matching the §35 theme selector's `<button>` chip pattern) above the chart switches between the two modes.

The per-project variant on the analytics dashboard renders the same component scoped to one project (passing `projectSecret` into the backend call), which makes the "Stacked" mode become a simple model-only stacked area and "Overlay" become a single-stack overlay (visually identical to "Stacked" — at the per-project surface the toggle is hidden because there's no second project to compare).

**Cost basis.** Estimated dollar cost (the same per-row cost the rest of the telemetry surfaces use). No separate per-token vs. per-cost view. *(Confirmed in HS-8503 feedback.)*

### 69.10.5 Per-project telemetry sections in the analytics dashboard

The existing analytics dashboard (`src/client/dashboard.tsx` + `dashboardMode.tsx` — opened via the sidebar widget at the top of the sidebar, see §47.X of the docs index) gains new telemetry sections appended below the existing throughput / cycle-time / category-breakdown charts. All sections are scoped to the **active project** (matching the analytics dashboard's existing per-project orientation).

Sections, top-to-bottom under the existing analytics content:

1. **Today / This week / All time chips** — total cost + tokens + prompts. Mirrors the pre-reshape drawer Telemetry tab's window chips.
2. **Cost over time (per-project)** — the same component as §69.10.4, scoped to the active project.
3. **Cost by model** — donut + legend (per-project variant, same component used cross-project).
4. **Per-tool latency histograms** — moved verbatim from the drawer Telemetry tab. Per-tool count + p50 / p90 / p99 + bucketed histogram. *(Cross-project variant explicitly skipped per HS-8503 feedback.)*
5. **10 most recent prompts** — the prompts list, **sorted by ts DESC** (not by cost). Click any row → opens the existing `openPromptDrilldown(promptId)` modal from HS-8149. *(Replaces the drawer tab's "recent prompts" list and the pre-reshape §69.3.5 "top 10 expensive prompts.")*

### 69.10.6 Per-tab cost-chip click target

The per-project tab-header cost chip (HS-8147) currently opens the drawer Telemetry tab scoped to the project. After HS-8503's drawer-tab removal, clicking the chip opens the **analytics dashboard** scoped to the project (i.e., calls `enterDashboardMode()` after a project switch if needed). Scrolling to the telemetry section is a polish that may or may not land in HS-8503's cleanup ticket — the default is "open the dashboard" without auto-scroll.

### 69.10.7 Implementation plan (HS-8503 sub-tickets)

The reshape decomposes into 5 follow-up tickets, filed under HS-8503:

1. **Backend / queries** — `getCostOverTime` query + dashboard payload extension + new per-project analytics-dashboard telemetry payload route. May rename `/api/telemetry/drawer` → `/api/telemetry/project-rollup` since the consumer changes.
2. **Shared cost-over-time chart component** — JSX module + stacked / overlay mode toggle + theming. Used by both surfaces.
3. **Cross-project stats page (NEW)** — header icon + visibility gate rewire + page shell + window selector + integration of existing cross-project section renderers (chips, table, donut, heatmap) + the new chart. Removal of the top-10-prompts list happens here.
4. **Analytics-dashboard telemetry integration** — new per-project telemetry sections below the existing charts: chips, chart, donut, per-tool histograms, recent-prompts list with drilldown.
5. **Cleanup** — remove drawer Telemetry tab (`drawer-tab-telemetry` + `drawer-panel-telemetry` in `pages.tsx` + `telemetryDrawer.tsx` module + the `/api/telemetry/drawer` endpoint OR its consumers, depending on Phase 1's rename decision) + remove sidebar Telemetry entry (`#sidebar-section-telemetry` + `telemetrySidebar.tsx` activation listener) + rewire the per-tab cost-chip click target.

Phases 3 and 4 each ship the new home for half the old content; Phase 5 removes the old homes once the new homes are live (so users don't briefly lose access).
