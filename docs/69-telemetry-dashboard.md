# 69. Cross-project telemetry dashboard

## 69.1 Goal

Add a new full-window view — accessible from the left sidebar as a sibling to the existing project list / search — that renders **cross-project** rollups of every signal Hot Sheet's OTLP receiver has captured. The per-project drawer Telemetry tab ([67-telemetry.md](67-telemetry.md) §67.10.2) shows one project at a time; this view drops the project filter and answers questions like *"how much did I spend on Claude this month across every project"*, *"which project gets the bulk of my budget"*, *"what time of day do I actually use Claude"*, and *"what were my ten most expensive prompts ever."*

It uses the same data source as the drawer tab: live queries against `otel_metrics` + `otel_events`, no precomputed rollup tables (per §67.6).

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
