# 74. Clear Telemetry Data

Manual, per-project deletion of all recorded Claude Code telemetry (HS-8606). Complements the automatic age-based retention sweep (§67.6 / HS-8154) with an explicit "wipe it now" action — useful for clearing inflated pre-HS-8599 cumulative rows (see §67.3), reclaiming space, or removing data before sharing a machine.

## 74.1 Surface

Settings → **Telemetry** tab → **Retention** section, directly below the "Keep raw rows for (days)" field:

- A **"Clear telemetry data…"** button (`#settings-telemetry-clear-btn`, danger-styled).
- An inline **status line** beside it (`#settings-telemetry-clear-status`) showing the result.
- A hint clarifying the action is permanent and **scoped to this project only** — other projects are unaffected.

The button is always present regardless of the `telemetry_enabled` master toggle — a user who has turned telemetry off may still want to clear data recorded earlier.

## 74.2 Confirmation

Clicking the button opens the standard in-app `confirmDialog` (§ Tauri-safe overlay, never `window.confirm`) with `danger: true`:

> Permanently delete all telemetry (metrics, events, and traces) recorded for this project? Other projects are unaffected. This cannot be undone.

Confirm label "Clear data", cancel label "Cancel". Cancelling is a no-op (no request, no status change).

## 74.3 Behavior

On confirm:

1. The button disables and the status reads "Clearing…".
2. Client issues `DELETE /api/telemetry/project-data`. The active project's secret rides in the `X-Hotsheet-Secret` header, so the server resolves the project the same way every other telemetry route does (`c.get('projectSecret')`).
3. Server calls `clearProjectTelemetry(projectSecret)` (`src/db/otelQueries.ts`), which deletes every row whose `project_secret` matches across `otel_metrics`, `otel_events`, and `otel_spans` — **no time filter** (unlike the §67.6 retention sweep). It targets the shared telemetry DB via `getTelemetryDb()` (§67.6 — the otel tables are a single shared store in the primary project's DB keyed by `project_secret`; see also §67's "Single shared store" note and HS-8581).
4. Response `{ deleted: <count> }` drives the status line: "Cleared N telemetry rows." (singular / plural / "No telemetry data to clear." when N = 0). On failure the status shows the error.
5. The sidebar cost widget is refreshed (`refreshSidebarWidgetCost`) so a just-cleared project drops to $0 immediately instead of showing the sticky cached value (HS-8527). The analytics-dashboard telemetry section (§71) and cross-project stats page (§70) pick up the change on their next 30 s poll tick.

## 74.4 Scope + safety

- **Per-project only.** The delete is always `WHERE project_secret = ?`. The server route returns `400` (and `clearProjectTelemetry` is never reached) when no project secret resolves, so a misconfigured request can never run an unscoped delete that would wipe every project's data from the shared store.
- **Permanent.** No undo, no soft-delete — telemetry is disposable diagnostic data. The confirmation is the only guard.
- **Telemetry only.** Clears the three `otel_*` tables. Does NOT touch ticket data, `daily_stats` snapshots, the command log, or any non-telemetry table.

## 74.5 Implementation

- Server query: `clearProjectTelemetry(projectSecret)` in `src/db/otelQueries.ts`.
- Server route: `DELETE /api/telemetry/project-data` in `src/routes/telemetry.ts`.
- Client: `src/client/telemetryClearUI.tsx` (`bindClearTelemetryButton` + the pure `formatClearResult` helper), wired from `bindTelemetryTab` in `src/client/settingsDialog.tsx`. Markup in `src/routes/pages.tsx`; styles `.settings-inline-row` / `.settings-status` in `src/client/styles.scss`.
- Tests: `src/db/otelQueries.test.ts` (per-secret scoped delete + no-op), `src/routes/telemetry.test.ts` (route returns count, scopes by active secret, 400 on empty secret), `src/client/telemetryClearUI.test.tsx` (formatter + confirm/success/error flow). E2E: `e2e/clear-telemetry.spec.ts` (HS-8608) — seeds otel rows via the OTLP receiver, clicks the button + the real in-app confirm overlay (not `page.on('dialog')`), asserts the "Cleared N…" status + that the project's telemetry is zero server-side, plus the cancel-leaves-data-intact path.
