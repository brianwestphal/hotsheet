# 67. Claude Code Telemetry

## 67.1 Goal

Capture Claude Code's [OpenTelemetry signals](https://code.claude.com/docs/en/monitoring-usage.md) and surface them inside Hot Sheet so the user can answer questions like *"how much did I spend on Claude today,"* *"which prompt blew my budget,"* *"which tool is the slowest,"* and *"how much did this ticket cost me."* This integration replaces a hypothetical external dashboard with a first-class Hot Sheet surface — no external observability backend required.

Claude Code ships an OTLP/HTTP exporter behind a small set of env vars. When those are set, the running `claude` process emits metrics every 60 s, log events every 5 s, and (under a beta opt-in) traces every 5 s. Hot Sheet's terminals know which project they belong to (per the existing `secret` plumbing), so we inject those env vars at spawn time, host an OTLP receiver on the existing Hono server, persist the payloads to PGLite tables, and render them in per-project + cross-project UI surfaces.

This is a single-machine, single-user feature. Cross-machine aggregation, cloud export, and non-Claude-Code OTLP sources are explicitly out of scope.

## 67.2 Scope

### What we collect

**Metrics** (counters + gauges + histograms, default cadence 60 s):

- `claude_code.token.usage` — token counts split by type (input / output / cache_read / cache_creation).
- `claude_code.cost.usage` — dollar cost per turn/request, the primary signal for cost rollups.
- `claude_code.lines_of_code.count` — lines added / removed by Edit/Write tools.
- `claude_code.commit.count` / `claude_code.pull_request.count` — git activity attributed to Claude.
- `claude_code.code_edit_tool.decision` — accepted / rejected / deferred counts on edit-tool decisions.
- `claude_code.active_time.total` — seconds of session activity.
- `claude_code.session.count` — sessions started.

**Log events** (cadence 5 s):

- `claude_code.user_prompt` — every user-typed prompt, with `prompt.id` + length + truncated body.
- `claude_code.api_request` — every LLM call (model, tokens, latency, prompt-id correlation).
- `claude_code.api_error` — failed LLM calls (status, retry count, error message).
- `claude_code.tool_decision` — permission-prompt allow/deny.
- `claude_code.tool_result` — tool invocation outcomes (tool name, duration, success/failure, result-size).

**Traces** (cadence 5 s, **beta** — gated on `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`):

- Turn-level root spans + child spans for LLM request / tool / hook execution. Parent-child relationships render as a waterfall in the per-prompt drilldown (§67.10.4).

### Correlation keys

Every payload carries the resource attributes Hot Sheet injects (§67.3) plus signal-specific identifiers:

- `hotsheet_project` (resource attr) → routes the payload to a project.
- `session.id` → groups all signals from a single Claude Code session.
- `prompt.id` (events + spans, NOT metrics) → groups all signals from a single user prompt within a session. This is the join key the per-prompt drilldown uses.

### What we do NOT collect

- Prompt content beyond what `claude_code.user_prompt` already includes (which is Claude Code's choice — usually a truncated preview or hash).
- LLM responses beyond what `claude_code.api_request` already includes.
- Non-Claude-Code OTLP traffic — the receiver filters on `telemetry.sdk.name` / `service.name` (Claude Code stamps these) and drops other payloads (§67.5.3).

## 67.3 Configuration: spawn-env injection

When Hot Sheet spawns a terminal (`src/terminals/registry/lifecycle.ts::buildEnv` or its equivalent — see §67.4 for the extraction), it injects the following env vars when the per-project `telemetry_enabled` setting is `true`:

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>
OTEL_RESOURCE_ATTRIBUTES=hotsheet_project=<secret>,working_dir=<dataDir>
OTEL_LOG_USER_PROMPTS=1
```

`OTEL_LOG_USER_PROMPTS=1` (HS-8537) is required so Claude Code emits the prompt body inside the `claude_code.user_prompt` event. Without it, the body is omitted (only `prompt_length` and other metadata are emitted) and the `<!-- hotsheet:ticket=HS-NNNN -->` marker that the per-ticket cost rollup depends on (§67.10.7 / HS-8152) has nowhere to land. The data stays local in PGLite, so logging the prompt content carries the same privacy posture as everything else the receiver persists — the user already opted in by enabling telemetry.

When the per-project `telemetry_traces_enabled` setting is `true` AND `telemetry_enabled` is also `true`:

```
OTEL_TRACES_EXPORTER=otlp
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
```

The `<port>` value matches the main server's port (decision: same-port topology — see §67.4). The `<secret>` value is the project's secret from `<dataDir>/.hotsheet/settings.json` — this is the same value the channel + permission flow already use to identify the project, so it doubles as the OTLP routing key.

### Why the secret as the routing key

A user might run Claude Code in multiple Hot Sheet projects simultaneously, each in its own terminal. The receiver needs to know which project a given OTLP payload belongs to. The project's `secret` is already unique, already known to both the spawning code and the receiving code, and already treated as not-quite-secret-but-not-public, so it's the natural fit. The receiver looks up the project by matching the `hotsheet_project` resource attribute against the per-project secret registry; payloads with an unknown secret are dropped.

### Why opt-in (default off)

Telemetry adds disk writes, includes prompt text in the receiver path, and inflates the local DB. Users should consent before any of that happens. The setting lives per-project (see §67.6) so a user can enable it in their primary project and leave it off in a quick scratchpad project.

## 67.4 Configuration: receiver topology

**Decision: same Hono server as the main app.** The OTLP routes (`/v1/metrics`, `/v1/logs`, `/v1/traces`) live alongside the existing API routes in `src/routes/otel.ts`. The spawn-env's `OTEL_EXPORTER_OTLP_ENDPOINT` points at `http://localhost:<mainPort>`.

Rationale:

- Single socket / single process / single auth surface — reuse the existing localhost-only bind, the existing `secretCheck` middleware shape, the existing graceful-shutdown plumbing (per §45 / HS-7902).
- The receiver's load is modest at single-user scale (one Claude Code session emits ~10 KB/min of metrics + a few KB/min of events) — no isolation needed.
- A sibling-port topology adds a second socket, a second config setting, and a second shutdown handler. Net cost is real and net benefit is "you could restart the receiver without disturbing the app," which doesn't matter at single-user scale.

If volume ever becomes a problem (multiple parallel projects each running heavy Claude Code sessions), the sibling-port topology is a clean migration — point `OTEL_EXPORTER_OTLP_ENDPOINT` at a different port and spawn a second Hono. Treat the same-port choice as the default-now, not a permanent one.

The per-app `<~/.hotsheet/settings.json>` setting `telemetry_receiver_port_override` is reserved for the future sibling-port migration but **unused in the same-port implementation** — it stays in the Settings UI ticket (HS-8146) as a documentation-only setting for now.

## 67.5 Ingestion: the OTLP/HTTP receiver

### 67.5.1 Routes

Three routes in `src/routes/otel.ts`, wired into the main Hono app:

- `POST /v1/metrics` — accepts metric payloads.
- `POST /v1/logs` — accepts log-event payloads.
- `POST /v1/traces` — accepts trace span payloads (beta).

Each route:

1. Enforces localhost-only origin (mirror the existing same-origin pattern — reject non-`127.0.0.1` / `::1` sources with `403`).
2. Accepts both `Content-Type: application/x-protobuf` (the Claude Code exporter default) and `Content-Type: application/json` (humans + curl).
3. Decodes via `@opentelemetry/otlp-transformer` (the canonical decoder; small dep, stable schema). If that pulls in too much, hand-roll the protobuf-to-JSON conversion — the schemas are stable and small.
4. Extracts the `hotsheet_project` resource attribute. If missing or doesn't match a known project secret, drops the payload (logs at debug level for diagnostics).
5. **Phase 1 (HS-8143):** Logs a one-line summary to stdout (signal type, batch size, first resource attribute) — NO storage. This validates the end-to-end path before the schema lands.
6. **Phase 2 (when storage lands per HS-8144):** Persists rows to the corresponding table (§67.6).
7. Returns `200 OK` with empty body — OTLP convention.

### 67.5.2 Performance

The receiver is hot-path code (called every 5 s per active Claude Code session). Notes:

- Parse + persist on the request thread is fine at single-user scale. If a future stress test shows pause-on-write, queue payloads to a background worker.
- Use prepared INSERT statements (existing PGLite convention).
- No deduplication — Claude Code's exporter guarantees at-most-once delivery within a session; a re-delivery from a restarted exporter just produces duplicate rows, which the rollup queries deduplicate at read time via `(session_id, ts, metric_name)` uniqueness if needed.

### 67.5.3 Filtering non-Claude-Code OTLP traffic

Hot Sheet's receiver is conceptually public on `localhost:<port>` — any process that knows the port could POST to it. Defense:

- The localhost-bind already prevents external traffic.
- The `hotsheet_project` resource attribute check (drop on missing/unknown secret) prevents foreign OTLP processes (e.g. a user running an unrelated `kubectl` instrumented with their own OTel collector pointed at the same port by accident) from polluting Hot Sheet's tables.
- A future hardening could also check `telemetry.sdk.name` or `service.name` for the Claude Code value, but that's belt-and-suspenders — the secret check is the actual gate.

## 67.6 Storage: PGLite schema

Three tables in `src/db/connection.ts::initSchema`, plus an indexed `(project_secret, ts)` lookup for the per-project rollups. Tables (HS-8144):

```sql
CREATE TABLE IF NOT EXISTS otel_metrics (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  project_secret TEXT NOT NULL,
  session_id TEXT,
  metric_name TEXT NOT NULL,
  attributes_json JSONB,
  value_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_project_ts ON otel_metrics (project_secret, ts DESC);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_session_ts ON otel_metrics (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_otel_metrics_name ON otel_metrics (metric_name);

CREATE TABLE IF NOT EXISTS otel_events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  project_secret TEXT NOT NULL,
  session_id TEXT,
  prompt_id TEXT,
  event_name TEXT NOT NULL,
  attributes_json JSONB,
  body_json JSONB
);
CREATE INDEX IF NOT EXISTS idx_otel_events_project_ts ON otel_events (project_secret, ts DESC);
CREATE INDEX IF NOT EXISTS idx_otel_events_session_ts ON otel_events (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_otel_events_prompt ON otel_events (prompt_id);

CREATE TABLE IF NOT EXISTS otel_spans (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL,
  parent_span_id TEXT,
  project_secret TEXT NOT NULL,
  session_id TEXT,
  prompt_id TEXT,
  span_name TEXT NOT NULL,
  start_ts TIMESTAMPTZ NOT NULL,
  end_ts TIMESTAMPTZ NOT NULL,
  attributes_json JSONB,
  status_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_otel_spans_project_ts ON otel_spans (project_secret, start_ts DESC);
CREATE INDEX IF NOT EXISTS idx_otel_spans_session_ts ON otel_spans (session_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_otel_spans_prompt ON otel_spans (prompt_id);
CREATE INDEX IF NOT EXISTS idx_otel_spans_trace ON otel_spans (trace_id);
```

Bump `SCHEMA_VERSION` in `src/db/connection.ts` (2 → 3) per the §41 / §45 convention so the JSON co-save format is invalidated correctly across the upgrade.

### Why JSONB columns for `attributes_json` / `value_json` / `body_json`

OTel attributes are arbitrary key-value bags whose shape varies per metric / event / span. Pinning them into rigid columns would force a hand-maintained mapping that drifts every time Claude Code adds a new metric. JSONB keeps the receiver flexible (write any payload as-is) and lets rollup queries use PG's JSON operators when they need a specific value (`(value_json->>'count')::bigint`).

### Why no rollup tables

The volume is small enough that live `SUM`/`COUNT`/`AVG` queries against the raw tables answer every rollup question in milliseconds. Precomputed rollup tables would add write-amplification (rebuild on every insert) for no gain at single-user scale. Re-evaluate if a future user reports slow telemetry-tab loads.

### Retention + GC

Per-project `telemetry_retention_days` setting (default 30, `0` = keep forever). HS-8154 wires a periodic sweep into `src/cleanup.ts`:

```sql
DELETE FROM otel_metrics WHERE project_secret = ? AND ts < now() - INTERVAL '<n> days';
-- same for otel_events + otel_spans
```

The existing cleanup timer (which already handles trash + completed tickets per §2 of the data-storage doc) gets one more body. No new timer.

## 67.7 Cadence

Default cadences from Claude Code (configurable via the OTLP-standard env vars — Hot Sheet does NOT override them):

- Metrics: every 60 s.
- Logs/events: every 5 s.
- Traces: every 5 s.

If the user wants faster metrics (e.g. live cost chip update), they can set `OTEL_METRIC_EXPORT_INTERVAL=10000` in their shell rc — Hot Sheet does NOT inject this because faster export means more receiver load for marginal UX benefit.

## 67.8 Security

- **Localhost-only bind.** The receiver routes inherit the main Hono app's bind (`127.0.0.1` only — covered by the existing same-origin enforcement). External traffic can't reach the receiver even if it tries.
- **Project-secret routing.** Payloads with an unknown `hotsheet_project` secret are dropped — a foreign OTLP source can't pollute a real project's tables.
- **No prompt-text exposure beyond Claude Code's own choice.** Hot Sheet's receiver persists what Claude Code emits; it does not add additional prompt content from elsewhere. The user's prompt body lives in `claude_code.user_prompt`'s `body_json` exactly as Claude Code chose to format it (usually a truncated preview).
- **Backup containment.** OTel tables get backed up by the existing PGLite tarball flow (§7). If a user's backups are sensitive, telemetry rows are part of that — the `telemetry_enabled` opt-in covers the consent surface.

## 67.9 Configuration: Settings UI

(HS-8146 — the Settings UI ticket; this section captures the per-project + per-app surface that ticket has to render.)

**Per-project (file-settings under `<dataDir>/.hotsheet/settings.json`):**

- `telemetry_enabled: boolean` — master toggle. Default `false`. When `false`, no spawn-env injection AND incoming OTLP payloads for this project's secret are dropped (defensive defense-in-depth — the receiver should never see them since no Claude Code in this project is exporting).
- `telemetry_metrics_enabled: boolean` — sub-toggle. Default `true` when master is on. Controls `OTEL_METRICS_EXPORTER`.
- `telemetry_logs_enabled: boolean` — sub-toggle. Default `true`. Controls `OTEL_LOGS_EXPORTER`.
- `telemetry_traces_enabled: boolean` — sub-toggle. Default `false` (beta). Controls `OTEL_TRACES_EXPORTER` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`.
- `telemetry_retention_days: number` — retention window for raw rows. Default `30`. `0` = keep forever.

**Per-app (under `~/.hotsheet/settings.json`):**

- `telemetry_receiver_port_override: number | null` — reserved for the future sibling-port topology (§67.4). Default `null`. **Unused in the current same-port implementation** — documented for forward compatibility.

The Settings UI panel mirrors the §52 terminal-prompts settings shell — subscribe-to-store pattern, lazy-imported by `settingsDialog.tsx`.

## 67.10 UI surfaces

Five separate user-facing surfaces, each its own ticket:

### 67.10.1 Sidebar dashboard widget cost (HS-8147 — relocated by HS-8527)

> **HS-8527 (2026-05-22) — relocation.** Pre-HS-8527 this surface was a small monospace dollar-amount pill (`.project-tab-cost`) inside every project tab header. That chip is gone. The same dollar-amount value now lives in the **sidebar dashboard widget** (the one that opens the analytics dashboard on click), right-aligned on the same line as "N in progress." The widget itself was also moved up the sidebar — it now sits directly under the git-status chip (`#sidebar-git-chip`) rather than at the bottom (after `#stats-bar`), so the cost stays visible without scrolling on short viewports. Tab headers themselves now carry only the project name + status dot + bell glyph.

Today's-cost element in the sidebar dashboard widget (`.sidebar-widget-cost`). Populated only when `telemetry_enabled === true` AND today's cumulative cost > $0 for the active project AND the user's billing model is `'api'` (subscription mode hides the value because the metric is an API-equivalent estimate, not what the user pays — see HS-8497 / §67.13). Refreshes on the same poll cadence as the existing tab-bell-state poll. The widget itself remains the analytics-dashboard launcher on click. Tooltip: "Claude usage today (resets at local midnight)."

Source query: `SUM((value_json->>'value')::numeric) FROM otel_metrics WHERE project_secret = ? AND metric_name = 'claude_code.cost.usage' AND ts >= midnight_local`. Single sum, indexed scan, ~1 ms. The bulk `/api/telemetry/today-cost-by-project` endpoint stays in use — it returns the full map and the client filters down to the active secret. Keeping the bulk shape (instead of switching to the single-project `/api/telemetry/today-cost`) means re-introducing a multi-secret cost surface later (e.g. a project-picker list) doesn't need any route plumbing.

### 67.10.2 Footer drawer "Telemetry" tab (HS-8148 — REMOVED in HS-8503)

> **HS-8503 (2026-05-21) — supersession.** The drawer Telemetry tab is removed. Per-project rollups move to the **analytics dashboard** (see §69.10.5 in [69-telemetry-dashboard.md](69-telemetry-dashboard.md)); cross-project rollups move to the new **Cross-project stats page** (header icon, see §69.10.1). The per-project tab cost chip (§67.10.1) opens the analytics dashboard instead. (HS-8527 follow-up: the chip itself was retired in favor of an inline cost element in the sidebar dashboard widget; the widget remains the analytics-dashboard launcher.)

Original pre-reshape spec (preserved for historical context):

New tab in the footer drawer alongside Commands Log + Terminal. Default scope: active project. Toolbar toggle for "all projects."

Sections:

1. **Today / This week / All time** chips — total cost, total tokens, count of prompts.
2. **By model** — sonnet vs opus vs haiku rows (cost + tokens + prompts).
3. **By tool** — top tools by invocation count, avg duration, total cost contribution.
4. **By query source** — main agent vs subagent vs auxiliary breakdown.
5. **Recent prompts** — last 50 prompts, click-through to per-prompt drilldown (§67.10.3).

All rollups live against raw tables — no precomputed views (§67.6).

### 67.10.3 Per-prompt timeline drilldown modal (HS-8149)

Click a prompt row in the telemetry drawer (or the cost chip → drawer → row) → modal showing the full timeline for that `prompt_id`:

- **Header:** prompt id, ts, total cost, total duration, model, query source.
- **Body:** vertical timeline of every event + span for the prompt, in start-ts order:
  - `claude_code.user_prompt` (the trigger).
  - `claude_code.api_request` rows with token counts + latency.
  - `claude_code.tool_decision` permission gates with allow/deny.
  - `claude_code.tool_result` with tool name + duration + payload size.
  - `claude_code.api_error` (if any).
- Each row clickable → expands to show full `attributes_json` for debugging.

Mirrors the §49 reader-mode overlay shell (90vw / 90vh, X / Escape / backdrop dismiss). Single query per modal open, keyed by `prompt_id` (indexed).

### 67.10.4 Trace waterfall view (HS-8155, beta)

When traces are enabled, the per-prompt drilldown gains a "Trace" button → opens a Chrome-style waterfall: each span as a horizontal bar positioned by `start_ts` + `duration`, vertically stacked by depth (parent-child relationships from `parent_span_id`). Flagged BETA in the UI — the upstream surface is explicitly marked beta and may shift without notice.

### 67.10.5 Per-tool latency histograms (HS-8150)

Histogram-per-tool widget. **Post-HS-8503: lives on the analytics dashboard's per-project telemetry section** (see §69.10.5 in [69-telemetry-dashboard.md](69-telemetry-dashboard.md)) — pre-reshape it lived on the drawer Telemetry tab. Per-project only; no cross-project variant. For each tool the user has invoked in the selected time window:

- Bucketed latency distribution (p50 / p90 / p99 markers).
- Total invocation count + total time spent.
- Comparison badge when p90 > 2× a baseline.

Source: `otel_spans` (preferred) with `otel_events.attributes_json.duration_ms` as a fallback when traces aren't enabled. Lightweight inline `<svg>` histogram, no chart library dep.

### 67.10.6 Cross-project global dashboard (HS-8153, reshaped by HS-8503)

**Post-HS-8503:** Full-width **Cross-project stats page** launched from a header-bar icon (line-chart Lucide glyph) placed next to `#terminal-dashboard-toggle`. Sidebar entry removed. Page scope is cross-project only; no per-project filter (clicking a project row jumps to that project's analytics dashboard).

Sections:

- **Today / Week / Month / All-time** total cost chips.
- **Cost over time** — stacked-area chart with a Stacked / Overlay toggle (one (project, model) band per series; see §69.10.4 for mode details).
- **Cost by project** — table, sortable.
- **Cost by model** — donut + legend (small SVG, no library dep).
- **Hourly activity heatmap** — 7×24 day-of-week × hour grid.

**Removed in HS-8503:** the original "Top 10 most expensive prompts" list (per-project recent-prompts drilldown lives on the analytics dashboard instead — see §69.10.5).

Same source as the (now-removed) per-project drawer tab with the project filter dropped. See [69-telemetry-dashboard.md](69-telemetry-dashboard.md) §69.10 for the full reshape spec.

### 67.10.7 Per-ticket cost rollup (HS-8152)

Once the prompt ↔ ticket correlation investigation (HS-8151) lands, attach a "Claude usage" stats block to each ticket showing aggregate cost / tokens / prompt count / total duration spent on that ticket.

Locations:

- **Detail panel** — read-only stats block under Notes.
- **Ticket row** — optional dollar-amount chip when usage > $0.50 (configurable threshold).
- **Reader mode** — included in the §49 read-only overlay.

Source: JOIN `otel_events` (or wherever the correlation tag lives — TBD by HS-8151) on the active ticket id, GROUP BY ticket_id.

## 67.11 Open question: prompt → ticket correlation

Captured separately as HS-8151 (investigation ticket). Five options the investigation evaluates:

1. **`HOTSHEET_ACTIVE_TICKET` env at spawn.** Works only when the active ticket is known at spawn time; doesn't follow within-session ticket switches.
2. **Live-update via `OTEL_RESOURCE_ATTRIBUTES`.** Env vars can't update for a running shell — collapses to option 1's limitation.
3. **Tag prompts via the `/hotsheet` skill / channel-trigger flow.** When Hot Sheet triggers Claude with an active ticket, prepend a magic header in the prompt text that we parse out of `claude_code.user_prompt`'s body. Survives within-session ticket switches. The cleanest fit with existing flows.
4. **Time-window heuristic.** Any prompt fired within N seconds of the user clicking a ticket is attributed to that ticket. Lossy + zero-coupling — fine for a v1.
5. **Inject via Claude SDK MCP server context.** If Hot Sheet is the MCP channel server, it sees every prompt and can stamp the active-ticket id there. Highest coupling, highest accuracy.

HS-8151 recommends a strategy + files the implementation ticket. Per-ticket rollup (§67.10.7) blocks on that.

## 67.12 Out of scope

- Non-Claude-Code OTLP sources (Hot Sheet's receiver filters by `hotsheet_project` resource attribute).
- Cross-machine aggregation (the receiver is localhost-only; no distributed mode).
- Export to external observability backends (Grafana, Honeycomb, etc.) — possible follow-up if a user wants it, not in this design.
- Custom metric / log / span types beyond what Claude Code emits.
- Cost-budget alerts (could be a follow-up; not in the current ticket list).

## 67.13 References

- [Claude Code monitoring & usage](https://code.claude.com/docs/en/monitoring-usage.md) — the canonical doc for what's emitted + cadence + env vars.
- [Claude Code agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability.md) — beta tracing detail.
- OTLP/HTTP spec (https://opentelemetry.io/docs/specs/otlp/#otlphttp) — payload format the receiver decodes.
- §41 / §45 — schema versioning + graceful-shutdown patterns the new tables + receiver follow.
- §7 — backup flow the new tables get included in automatically.

## 67.14 Ticket map

The full feature decomposed into 14 tickets:

| Ticket | Phase | Surface |
|---|---|---|
| HS-8142 | Foundation | This requirements doc |
| HS-8144 | Foundation | PGLite schema |
| HS-8143 | Foundation | OTLP receiver routes |
| HS-8145 | Foundation | Spawn-env injection |
| HS-8146 | Foundation | Settings → Telemetry UI |
| HS-8147 | UI | Per-project today-cost surface (HS-8527: relocated from tab chip → sidebar widget) |
| HS-8148 | UI | Footer drawer Telemetry tab |
| HS-8149 | UI | Per-prompt drilldown modal |
| HS-8150 | UI | Per-tool latency histograms |
| HS-8153 | UI | Cross-project dashboard view |
| HS-8155 | UI (beta) | Trace waterfall + span-tree |
| HS-8151 | Investigation | Prompt ↔ ticket correlation |
| HS-8152 | UI (blocked) | Per-ticket cost rollup |
| HS-8154 | Maintenance | Retention + auto-GC |

Foundations are the unblockers for everything else. Within Foundation, the order is: HS-8144 (schema) → HS-8143 (receiver) → HS-8145 (spawn-env) → HS-8146 (Settings UI). HS-8142 + HS-8144 + HS-8143 are shipping together as the first wave; the rest follow incrementally.
