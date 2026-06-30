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

When Hot Sheet spawns a terminal (`src/terminals/registry/lifecycle.ts::buildEnv` or its equivalent — see §67.4 for the extraction), it injects the following env vars when the per-project `telemetry_enabled` setting is **not explicitly `false`** (HS-8684 default-on — see §67.3.3):

```
CLAUDE_CODE_ENABLE_TELEMETRY=1
OTEL_METRICS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta
OTEL_LOGS_EXPORTER=otlp
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:<port>
OTEL_RESOURCE_ATTRIBUTES=hotsheet_project=<secret>,working_dir=<dataDir>
OTEL_LOG_USER_PROMPTS=1
```

`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` (HS-8599) is set alongside `OTEL_METRICS_EXPORTER` and is **required for correct cost/token totals**. Claude Code's `claude_code.cost.usage` / `claude_code.token.usage` are OTel **Counters**; the OTLP default temporality is **cumulative**, so each ~60 s export re-reports the running *session total*, not the increment. The receiver (`otelWriters.ts`) persists one row per exported data point and the dashboard queries `SUM()` over those rows — which is correct only for **delta** temporality. Left on the cumulative default, summing the per-interval snapshots multiplied cost and tokens by roughly the number of export intervals in a session (observed **18–60× inflation** on a live instance — e.g. ~62M tokens/prompt, which is physically impossible against the 1M-token context ceiling). `delta` makes each export carry only the change since the last one, so the existing SUM aggregation is exact. **Rows written before this fix are cumulative and remain inflated** until they age out via the §67.6 retention sweep (or are cleared) — a mixed cumulative/delta history is not retroactively correctable, so a one-time wipe of `otel_metrics` is the clean way to get accurate totals immediately.

`OTEL_LOG_USER_PROMPTS=1` (HS-8537) is required so Claude Code emits the prompt body inside the `claude_code.user_prompt` event. Without it, the body is omitted (only `prompt_length` and other metadata are emitted) and the `<!-- hotsheet:ticket=HS-NNNN -->` marker that the per-ticket cost rollup depends on (§67.10.7 / HS-8152) has nowhere to land. The data stays local in PGLite, so logging the prompt content carries the same privacy posture as everything else the receiver persists — the user already opted in by enabling telemetry.

When the per-project `telemetry_traces_enabled` setting is `true` AND `telemetry_enabled` is also `true`:

```
OTEL_TRACES_EXPORTER=otlp
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
```

The `<port>` value matches the main server's port (decision: same-port topology — see §67.4). The `<secret>` value is the project's secret from `<dataDir>/.hotsheet/settings.json` — this is the same value the channel + permission flow already use to identify the project, so it doubles as the OTLP routing key.

### Why the secret as the routing key

A user might run Claude Code in multiple Hot Sheet projects simultaneously, each in its own terminal. The receiver needs to know which project a given OTLP payload belongs to. The project's `secret` is already unique, already known to both the spawning code and the receiving code, and already treated as not-quite-secret-but-not-public, so it's the natural fit. The receiver looks up the project by matching the `hotsheet_project` resource attribute against the per-project secret registry; payloads with an unknown secret are dropped.

### Default-on (HS-8684) — opt out per project

**HS-8684 reversed the original opt-in default** to default-on. The per-project `telemetry_enabled` setting now treats `undefined` (no explicit choice made) as enabled; only `false` opts out. Rationale: the telemetry data never leaves the machine — the OTLP receiver is localhost-bound + the `hotsheet_project` resource-attribute gate (§67.5.3) drops foreign payloads — so the "user should consent" framing was protecting against a leak that the architecture already prevents. Defaulting on lets users see their Claude cost rollups, per-ticket attribution, and the cross-project stats page out-of-the-box without having to discover the setting first.

Users can still opt out per project via Settings → Telemetry; flipping the master toggle off writes `telemetry_enabled: false` (explicit), which the gates in `src/terminals/registry/otelEnv.ts` and `src/routes/telemetry.ts::anyProjectHasTelemetryEnabled` respect.

The setting still lives per-project (see §67.6) so a user can opt a quick scratchpad project out while leaving telemetry on for their primary project.

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
- No deduplication — the receiver INSERTs one row per exported data point; the rollup queries `SUM()` over rows with no read-time de-dup. This is only correct when each exported value is an **increment**, which is why §67.3 forces `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` (HS-8599). With the cumulative OTLP default, every export re-sends the running session total and summing them overcounts by ~the number of export intervals (the 18–60× cost/token inflation that fix addressed). The metric-level `aggregationTemporality` / `isMonotonic` fields are now **persisted** at ingest (HS-8600) AND the SUM queries **exclude** cumulative monotonic rows (HS-8708 — `EXCLUDE_CUMULATIVE_MONOTONIC_SQL` in `otelRollups.ts`), so a foreign cumulative source can no longer silently re-introduce the overcount on the dashboards. (Caveat: this only filters rows STAMPED cumulative — pre-HS-8599 rows have `NULL` temporality, are indistinguishable from correct post-HS-8599 delta rows, and so are still summed; those legacy rows remain a one-time-wipe fix per §67.3.)

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
  value_json JSONB NOT NULL,
  aggregation_temporality TEXT,  -- HS-8600: 'delta' | 'cumulative' | NULL
  is_monotonic BOOLEAN           -- HS-8600: monotonic-counter flag (sums only)
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

Bump `SCHEMA_VERSION` in `src/db/connection.ts` per the §41 / §45 convention so the JSON co-save format is invalidated correctly across the upgrade (HS-8587 took it 2 → 3; HS-8600 took it 3 → 4 for the `aggregation_temporality` / `is_monotonic` columns).

**HS-8874 — `project_secret` is now nullable.** The four telemetry tables (`otel_metrics` / `otel_events` / `otel_spans` / `announcer_usage`) had `project_secret TEXT NOT NULL` under the single-shared-store design. Per-project storage adds a centralized store for rows with no `hotsheet_project` attr, whose rows carry a **NULL** `project_secret`, so `initSchema` drops the `NOT NULL` constraint additively (`ALTER TABLE … ALTER COLUMN project_secret DROP NOT NULL`). See "Per-project storage + a central store (HS-8874)" below.

### Aggregation temporality + cumulative-counter guard (HS-8600)

Defense-in-depth follow-up to §67.3 / HS-8599. HS-8599 forces `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta` in the spawn env so Claude Code's cost/token Counters export per-interval **increments** (the SUM-based dashboards are then exact). But the ingest path didn't *record* temporality, so a future telemetry source emitting **cumulative** counters (a different Claude Code version, a non-default config, another tool) would silently re-inflate totals 18–60× with no trace.

`src/db/otelWriters.ts::extractMetricAggregation(metric)` now reads the OTLP metric-level `aggregationTemporality` (numeric `1`=delta / `2`=cumulative, or the protobuf-JSON `AGGREGATION_TEMPORALITY_*` string form) + `isMonotonic` off whichever wrapper carries them (`sum` / `histogram` / `exponentialHistogram`; gauges → `null`), and `persistMetricsPayload` stores them on every row (`aggregation_temporality` / `is_monotonic`). `warnIfCumulativeCounter` emits a one-time stderr WARNING the first time a **cumulative monotonic** `claude_code.cost.usage` / `claude_code.token.usage` row is ingested, so the silent-overcount class becomes visible and the rows are filterable/repairable.

**HS-8708 — the SUM queries are now temporality-aware.** Every cost/token SUM in `otelRollups.ts` appends the shared `EXCLUDE_CUMULATIVE_MONOTONIC_SQL` predicate — `(aggregation_temporality IS DISTINCT FROM 'cumulative' OR is_monotonic IS NOT TRUE)` — so a stamped cumulative monotonic row is dropped from the totals automatically; the dashboards self-heal and the §67.6 warning becomes purely informational instead of requiring a manual `DELETE`. The predicate is null-safe so every row that must still count passes: delta counters, non-monotonic points (gauges), and **legacy pre-HS-8600 NULL-temporality rows** (already correct under the delta-forcing spawn env). This is the simpler exclude-the-bad-rows approach, not the per-`(session, metric)`-MAX cumulative *reconstruction* — reconstruction stays unbuilt because a stamped-cumulative source is the thing we want to ignore, not salvage. The `_debug` token-type query (§67.6) deliberately stays unfiltered so it shows the raw table contents (including any cumulative rows) for diagnosis. Pre-HS-8599 rows (NULL temporality, genuinely cumulative) are NOT caught by this — they're indistinguishable from correct delta rows, so they remain the one-time-wipe case from §67.3.

**Per-ticket cost source reconciliation:** `getPerTicketRollup` (`otelQueries.ts`) sums per-call `cost`/`tokens` off `claude_code.api_request` **events** — deliberately a different source than the `claude_code.cost.usage` **metric** the dashboards sum. This is safe on both axes: `api_request` events are per-LLM-call values (inherently deltas; log events aren't counters, so the temporality concern doesn't apply), and the two sources feed different surfaces (per-ticket detail figure vs. dashboards) that are never added together — so no double-count. Documented inline at the query.

### Headline token totals = input + output only (HS-8627)

`claude_code.token.usage` is tagged with a token `type` dimension — `input` / `output` / `cacheRead` / `cacheCreation`. The dashboards' token SUMs originally summed **all** types, so the headline "tokens" number was inflated far beyond the actual work: **`cacheRead` re-counts the ENTIRE cached prompt on every turn**, so over a session its count dwarfs input + output (the user reported the totals "still over counting" even after the HS-8599 delta fix — which only addressed the orthogonal cumulative-counter axis). The fix scopes the four token SUMs (`getWindowTotals`, `getCostByModel`, `getQuerySourceRollup`, `getCostByProject`) to input + output via a shared `REAL_WORK_TOKEN_TYPE_SQL` predicate (`otelQueries.ts`) that **excludes** the cache types. It's an *exclusion* (`type NOT IN (cacheRead, cacheCreation, cache_read, cache_creation)` + `type IS NULL`), not an `IN ('input','output')` inclusion, so an absent or unknown `type` still counts — fails OPEN to the old behavior rather than silently zeroing if the attribute shape ever differs; both Claude Code's camelCase values and the snake_case spelling above are covered. 5 unit tests in `otelQueries.test.ts` (`token totals exclude cache types (HS-8627)`) lock it, including the untyped-fails-open case.

**Cost is NOT filtered (and is not over-counted).** `claude_code.cost.usage` is already-priced USD that bakes in Anthropic's cache-read discount, so cache does not inflate cost the way it inflates the token *count* — the full cost IS correct. Cost over-count was checked on every axis: the cumulative-counter axis is handled by HS-8599 (delta) + HS-8600 (warn); cost is summed once per data point (`getCostByModel` groups by `model`, no total+breakdown double-emit); and the token-type filter is deliberately applied only to the token SUMs, leaving cost whole (a `getCostByProject` test asserts cost stays full with cacheRead token rows present).

**HS-8639 — cost reconciliation (cache pieces surfaced).** Because the headline token total excludes cache (HS-8627) AND the `[1m]` 1M-context models bill at ~2× once a turn's context (inflated by re-sent cache) exceeds 200K, the authoritative `cost.usage` can be ~2× a naive `input×rate + output×rate` estimate from the displayed tokens — reported as "cost too high" but correct. `WindowTotals` now also carries `cacheReadTokens` + `cacheCreationTokens` (cache write ≈ 1.25× input, cache read ≈ 0.1×), rendered as a "{read} cache read · {write} cache write" line under the in/out split on the per-project (§71) + cross-project (§70) chips, with a cost-cell tooltip noting the figure is Claude-Code-reported and includes cache + any 1M-context premium. The cost SUM itself is unchanged.

**HS-8639 — prompt-count robustness + ingest diagnostic.** `getWindowTotals` counts `DISTINCT prompt_id` across ALL `otel_events` (any `event_name`), not only `claude_code.user_prompt`, so a real count survives the HS-8514 case where the `user_prompt` log event specifically doesn't flush but api_request / tool_result events still carry the `prompt.id`; the distinct-`session.id` fallback remains for when no event carries a prompt_id at all. New read-only `GET /api/telemetry/_debug` (`getTelemetryDebugInfo`) returns the per-project `event_name` + `token.usage` `type` distributions — the diagnostic for the "prompt count = 1 + empty recent-prompts + empty tool histogram" pattern (metric-derived surfaces healthy, all LOG-event-derived surfaces empty), distinguishing "logs never sent" vs "dropped" vs "ingested-but-miscounted".

**HS-8793 — "missing data for day X" diagnostic.** When the §70/§71 cost-over-time chart shows empty days the user knows they worked, `_debug` now also returns `dailyMetricCounts` — a **GLOBAL** (cross-project, unfiltered), per-local-day raw `otel_metrics` row count grouped by `(date, metricName, projectSecret)` over the last `DEBUG_DAILY_WINDOW_DAYS` (14) days — plus `loadedProjects` (`{secret, name}[]`) to label those secrets. It buckets by `ts AT TIME ZONE ?tz`, the same local day the chart uses. Reading it tells three causes apart: (a) a day with **no rows at all** → a genuine ingestion gap (server down / telemetry off / Claude run outside a Hot Sheet terminal so the OTLP env wasn't injected); (b) rows present under a `projectSecret` **not in `loadedProjects`** → data orphaned by a re-registered/closed project; (c) only `claude_code.token.usage` and no `claude_code.cost.usage` → cost wasn't emitted. (The empty-day tooltip itself was also fixed in HS-8793 — it had rendered a truncated "N." because the "No cost" line reused the 3-column swatch-grid row, crushing the label into the 10px swatch track.)

**HS-8639 — event-name prefix tolerance (the actual root cause of the empty surfaces).** The `_debug` paste proved current Claude Code stores log event names *bare* — `user_prompt` / `tool_result` / `api_request` via the native OTLP `eventName` field — NOT the dotted `claude_code.user_prompt` form older builds emitted in the `event.name` attribute (which the writer still reads as a fallback). So a live `otel_events` table can hold a MIX of both spellings, and every query that filtered the dotted form (`getRecentPrompts`, `getToolRollup`, `getToolLatencyHistogram`, the `getPromptTimeline` model pull, `getPerTicketRollup`, and the `getCostByProject` / heatmap prompt counts) silently matched zero rows — empty recent-prompts list + empty tool histogram while cost/tokens (metric-derived, never keyed on `event_name`) stayed healthy. Fixed by a prefix-tolerant matcher (`eventNameMatchSql` / `eventNameVariants` / `isClaudeCodeEvent` in `otelQueries.ts`) that matches BOTH spellings everywhere. Regression tests seed events with the BARE name on purpose — the prior tests only ever used the dotted form, which is why the bug shipped. Separately, the events + spans writers now fall back to the log RECORD's own `session.id` attribute when the resource omits it (mirrors the metrics writer), fixing the `distinctSessions: 0` the same paste surfaced.

**HS-8537 — per-ticket-rollup diagnosis + the prefix-fix dependency.** The per-ticket "Claude usage on this ticket" block (§67.10.7, rendered by `ticketTelemetryStats.tsx` into `#detail-telemetry-stats`) was empty for the same `claude_code.` prefix reason: `getPerTicketRollup` filtered the dotted `claude_code.user_prompt` / `claude_code.api_request` form, so it matched zero rows regardless of whether the `<!-- hotsheet:ticket=HS-NNNN -->` marker landed — the HS-8639 prefix fix is therefore a prerequisite for the earlier HS-8537 marker-delivery fix (`OTEL_LOG_USER_PROMPTS=1` + `tagMessageWithActiveTicket`) to ever surface. The `_debug` endpoint gained three fields to pin any remaining emptiness: `markerEventsByName` (which event_names carry a `hotsheet:ticket=` marker — confirms the marker lands in `user_prompt` bodies), `distinctTicketMarkers` (the `HS-NNNN`s found), and `apiRequestAttrKeys` (whether `api_request` events carry `cost` / `cost_usd` / `tokens` — the rollup's cost/token source; an empty set means per-ticket cost can only ever be `$0`).

### Input vs output token split + derived $/Mtok estimate (HS-8628)

Input and output tokens are priced very differently, so `getWindowTotals` and `getCostByModel` break the real-work total down by `type`: alongside the combined `tokens` they now return `inputTokens` (`type='input'`) and `outputTokens` (`type='output'`). `getWindowTotals` computes all three in one pass via `FILTER (WHERE …)` aggregates; `getCostByModel` adds two `SUM(CASE …)` columns. The split predicates (`INPUT_TOKEN_TYPE_SQL` / `OUTPUT_TOKEN_TYPE_SQL`) are exact `type = 'input'` / `'output'` matches, so a NULL/unknown type still counts toward the real-work `tokens` total (HS-8627 fail-open) but toward neither input nor output — i.e. `inputTokens + outputTokens <= tokens`.

The UI surfaces the split as a second meta line on the window chips (cross-project §70 + analytics §71) — `"{in} in / {out} out"`, rendered only when token data is present — and per-model in the cost-by-model donut legend.

**Price-per-token estimate is *derived*, not a hardcoded price table.** Per the HS-8628 decision, the per-model "$/Mtok" shown in the donut legend is computed as `cost / tokens × 1e6` (`formatRatePerMtok` in `telemetryFormat.ts`). This is self-updating (no Anthropic price map to maintain, and it stays correct for Pro/Max subscription users whose cost is already an estimate) but it's a single blended rate per model, not separate input/output rates — decomposing the one already-priced `cost` number into per-type rates would require a hardcoded price table, which was explicitly declined. `formatRatePerMtok` returns `—` when there are no tokens to divide by.

### Per-project storage + a central store (HS-8874)

**HS-8874 superseded the single-shared-store model (HS-8581).** Telemetry is owned **per project**, and as of **HS-9230 (epic HS-9226 Phase 1)** each project's `otel_metrics` / `otel_events` / `otel_spans` / `announcer_usage` / `ticket_work_intervals` rows live in a **SEPARATE `<dataDir>/telemetry/db` PGLite cluster** — NOT the project's main snapshotted `<dataDir>/db`. Rows that carry **no** `hotsheet_project` resource attr go to a **centralized** store at `~/.hotsheet/telemetry` (its own cluster). The pre-HS-8874 design dumped every project's rows into whatever project the server happened to launch with (`getTelemetryDb()` → `defaultDbPath`), so telemetry scattered / "disappeared" whenever the launch project changed; HS-8874 fixed that (per-project ownership), and HS-9230 then moved per-project telemetry OUT of the snapshotted `db/` so the §73 snapshot / §7 backup stop serializing the high-volume telemetry (the dumpDataDir freeze — see §85 / the relocation note below). `telemetryClusterDataDir(dataDir)` (`connection.ts`) is the single chokepoint that maps a project dataDir → `<dataDir>/telemetry` (the central store maps to itself); both the routing (`getTelemetryDb`, the `otelWriters` direct opens) and the vacuum (`telemetryVacuum.telemetryDbDir`) go through it.

- **Writes** route **per OTLP resource** (`src/db/otelWriters.ts`): `resolveResource` returns the resource's `hotsheet_project` secret (→ that project's DB), `null` (no attr → central), or the `'drop'` sentinel (an *unknown*, un-registered project → dropped, preserving the §67.5.3 anti-pollution gate). The writer resolves the target DB via `telemetryDataDirForSecret` + `getDbForDir` and inserts that resource's rows there. Each row still carries `project_secret` (now **nullable** — NULL for central rows; the four tables' `project_secret NOT NULL` constraint was dropped additively in `initSchema`).
- **Reads** resolve the DB via `getTelemetryDb()` (`src/db/connection.ts`), whose order is: an explicit `runWithTelemetryDb(dir)` context → the per-request `requestDataDir` context (per-project analytics reads the project you're viewing) → the legacy `defaultDbPath` (single-project / tests) → the central store. **HS-9230** — each resolved dataDir is mapped through `telemetryClusterDataDir` before opening, so a project resolves to its `<dataDir>/telemetry/db` cluster (the central store maps to itself).
  - **Per-project rollups** (§71): read the active project's own DB via the request context (the `/api/telemetry/project-rollup` route also binds it explicitly with `runWithTelemetryDb`).
  - **Cross-project dashboard** (§70): `getDashboardPayload` takes the loaded `projects` (`{secret, dataDir}[]`) and **fans out** — for each project P it runs every rollup under `runWithTelemetryDb(P.dataDir, …)` filtered by **P's own secret**, plus a read of the central store, then **merges in JS** (sums window totals, groups cost-by-model by model, concats cost-by-project / cost-over-time, unions ingested dates, merges the 168-cell heatmap). Reading P's DB filtered by P's secret is what keeps the non-destructive migration (below) from double-counting: an un-deleted foreign row sitting in P's old launch-default DB is excluded by the secret filter.
  - **`getPromptTimeline`** fans out across all project DBs + central and returns the first DB with matching events.

**One-time migration (`src/db/telemetryMigration.ts`).** On startup (after projects register, guarded by the `telemetryMigratedV1` flag in `~/.hotsheet/config.json`), `migratePerProjectTelemetry` reads `~/.hotsheet/projects.json` + each project's `settings.json` secret, then for every project DB copies rows whose `project_secret` isn't that DB's own project into the DB matching their secret (NULL → central). It is **idempotent** (each destination insert is gated by a natural-key `NOT EXISTS`: `(trace_id, span_id)` for spans; `(ts, project_secret, metric_name, attributes_json, value_json)` for metrics; `(ts, project_secret, event_name, body_json)` for events; `(ts, project_secret, model, input_tokens, output_tokens)` for announcer_usage; `(project_secret, ticket_number, started_at)` for ticket_work_intervals). **HS-8875** — `ticket_work_intervals` is migrated by this same pass; it was the one remaining table still on the old launch-default storage model.

**Move, not copy (HS-8885).** The migration was originally non-destructive (source rows never deleted; the fan-out's per-secret filter kept the leftovers from double-counting). That left the legacy launch-default DB holding a *full duplicate* of everything migrated elsewhere forever — the §67.6 retention sweep only reaps rows matching the DB's own secret, never the foreign copies — a standing contributor to the multi-hundred-MB telemetry bloat HS-8882 found. HS-8885 makes it a **move**: once a batch is durably inserted into its destination, those exact source rows are `DELETE`d from the source (by their source SERIAL `id`, captured pre-delete, so intra-page duplicates collapsed to one destination row are all cleared). Crash-safety is preserved: the delete runs strictly AFTER the destination insert resolves, and the `NOT EXISTS` insert guarantees every value row is present downstream before its source copy is removed — a crash between the two leaves the row in both places, and the next (idempotent) run re-inserts it as a no-op and re-deletes the source copy. So re-running still never double-counts and never loses data. The freed pages are reclaimed by the VACUUM pass (§67.6, HS-8884). The per-secret fan-out filter (§70) stays as defense-in-depth.

**Efficiency / load resilience (HS-8874 follow-up).** The original implementation read every foreign row with an unbounded `SELECT *` and re-inserted them one at a time, each gated by a `NOT EXISTS` whose JSONB `::text` comparison couldn't use an index → a full table scan per insert (O(n²)) on the main event loop. On a large telemetry DB (hundreds of MB of OTLP rows) this pegged a core and never finished, so the listening server couldn't respond and startup hung — and because `telemetryMigratedV1` is only set after the whole pass, every kill restarted it from zero (a boot loop). The rewrite: (1) keyset-paginated reads (`id > $last ORDER BY id LIMIT 300`) so memory is bounded; (2) one batched `INSERT … SELECT FROM (VALUES …) WHERE NOT EXISTS` per (destination, page) instead of per row; (3) the dedupe is index-backed by `idx_*_dedupe` (in `connection.ts`) — the NOT-NULL scalar key columns compare with `=` so the existence probe is an index seek, `project_secret` stays null-safe (`IS NOT DISTINCT FROM`), and JSONB key columns are `::text` residuals on the tiny candidate set the index narrows to; (4) intra-page duplicate rows are removed in JS first (the batched `NOT EXISTS` only guards against rows already in the target); (5) the loop `setImmediate`-yields between pages so the server keeps breathing; (6) per-source-DB progress is recorded in `telemetryMigrationV1DoneDirs` (`~/.hotsheet/config.json`) so an interrupted run resumes at the first incomplete DB instead of restarting, and the list is cleared when the pass completes.

**HS-9230 / HS-9231 — telemetry relocated out of the snapshot (epic HS-9226 Phase 1).** Per-project telemetry now lives in `<dataDir>/telemetry/db`, a sibling cluster the §73 snapshot + §7 backup do NOT touch — both serialize only the single `<dataDir>/db` cluster via `dumpDataDir('gzip')`, so a sibling cluster is excluded for free. This is the structural fix for the §85 dumpDataDir freeze: the 833 MB project DB (766 MB telemetry) made `db.dumpDataDir` block the event loop ~6.7 s; with telemetry out of `db/`, the project snapshot/backup drop to a few MB. A one-shot startup migration (`relocateTelemetryToSeparateCluster`, `cli.ts` post-startup, gated by `telemetryRelocatedV1`) copies each project's existing telemetry rows from `db/` → `telemetry/db` (idempotent `NOT EXISTS` insert) and then **DROPs** the telemetry tables from `db/` — DROP frees the relation files immediately (so `db/` shrinks without a VACUUM FULL) and removes them from the dump; `initSchema` recreates the now-empty tables on the next open. Crash-safe: rows are copied before the source DROP, and the flag is set only after. The central store already had its own cluster, so it isn't relocated.

The deep telemetry **inspectors** (§68 span tree/timeline, event list) + every dashboard read continue to work unchanged — they go through `getTelemetryDb()`, which now resolves to the relocated cluster.

**HS-9232 — compact rollup schema (epic HS-9226 Phase 2 — schema only).** The dashboards (§70/§71) read only AGGREGATES, never raw rows, so Phase 2 keeps compact ROLLUPS in the **main snapshotted `<dataDir>/db`** (small + valuable → backed up; per-ticket cost is kept indefinitely) and leaves the raw rows in the un-snapshotted telemetry cluster (→ JSONL in Phase 3). Two tables added to `initSchema` (`src/db/connection.ts`; `SCHEMA_VERSION` 6→7; both registered in the §41 JSON co-save `dbJsonExport.ts`). Empty until the HS-9233 ingest + HS-9234 backfill populate them and HS-9235 repoints the reads. Central (no-project) rows use `project_secret = ''` here (raw uses NULL) so the key columns form a plain NOT-NULL PK for upserts.

- **`otel_rollup_daily`** — PK `(project_secret, day, model, query_source)`, **daily grain** (the maintainer's choice; `day` = server-local day at ingest — a known approximation if the machine tz changes). Measures: `cost_usd` + split token sums (`input/output/cache_read/cache_creation`) + `prompt_count` / `session_count` (per-day **approximate** distinct counts — distinct ids don't roll up exactly across buckets, matching the approximation the existing cross-DB JS merges already make) + `datapoint_count`. Covers **getCostOverTime** (day×project×model), **getCostByModel**, **getQuerySourceRollup**, **getCostByProject**, **getWindowTotals** (today/week/month/all = sum of day buckets), **getTodayCost**.
- **`otel_rollup_ticket`** — PK `(project_secret, ticket_number)`, kept **indefinitely**. Measures: `cost_usd`, `total_tokens`, `prompt_count`, `duration_seconds`, `model_breakdown` (a `{model:{cost,tokens}}` JSON map). Maintained at ingest by attributing each `api_request` to the OPEN `ticket_work_intervals` row at that instant (HS-9233). Covers **getPerTicketRollup**.
- **NOT covered by rollups (stay on raw → Phase 3 / JSONL):** the hour-of-week **heatmap** (`getHourlyActivityHeatmap` needs hour-of-day resolution the daily grain doesn't keep), the **tool-latency histogram** (`percentile_cont` p50/p90/p99 don't roll up additively), the **recent-prompts** list (a raw per-prompt list, not an aggregate), and the §68 **inspectors** (`getPromptTimeline` / `getTelemetryDebugInfo`). These keep reading the raw telemetry cluster until Phase 3 moves raw to JSONL and points them there. Schema tests: `src/db/telemetryRollupSchema.test.ts`.

Regression coverage: `src/db/otelQueries.test.ts` ("cross-project fan-out (HS-8874)" + "per-project rollups read the project's own telemetry DB"), `src/db/otelWriters.test.ts` ("per-project write routing" — asserts against the relocated cluster), and `src/db/telemetryMigration.test.ts` (the HS-8874 move + the HS-9231 relocation: move → DROP from `db/` → idempotent re-run → flag-gate skip).

### Why JSONB columns for `attributes_json` / `value_json` / `body_json`

OTel attributes are arbitrary key-value bags whose shape varies per metric / event / span. Pinning them into rigid columns would force a hand-maintained mapping that drifts every time Claude Code adds a new metric. JSONB keeps the receiver flexible (write any payload as-is) and lets rollup queries use PG's JSON operators when they need a specific value (`(value_json->>'count')::bigint`).

### Why no rollup tables

The volume is small enough that live `SUM`/`COUNT`/`AVG` queries against the raw tables answer every rollup question in milliseconds. Precomputed rollup tables would add write-amplification (rebuild on every insert) for no gain at single-user scale. Re-evaluate if a future user reports slow telemetry-tab loads.

### Retention + GC

Per-project `telemetry_retention_days` setting (default 30, `0` = keep forever). HS-8154 wires a startup sweep into `src/cleanup.ts`:

```sql
DELETE FROM otel_metrics WHERE project_secret = ? AND ts < now() - INTERVAL '<n> days';
-- same for otel_events + otel_spans
```

The existing cleanup call point (which already handles trash + completed tickets per §2 of the data-storage doc) gets one more body. No new timer.

**HS-8607 / HS-8874 — per-project sweep.** `cleanupAllProjectsTelemetry` (`src/cleanup.ts`, called from `cli.ts::initProject`) iterates the persisted project list (`~/.hotsheet/projects.json`) plus the launched dataDir (deduped) and runs `cleanupTelemetryRows` for each. Under HS-8874 each project's telemetry lives in its **own** DB, so `cleanupTelemetryRows` runs the DELETE in that project's telemetry context (`runWithTelemetryDb(dataDir)`) and scopes it to that project's `project_secret` (defense-in-depth, since a non-destructively-migrated DB may still hold un-deleted foreign rows) by its own `telemetry_retention_days`. The driver also sweeps the **central** store (`~/.hotsheet/telemetry`, NULL-secret rows). HS-8877 — central isn't a project, so its window comes from the global config key `centralTelemetryRetentionDays` (`~/.hotsheet/config.json`), defaulting to 30 days; `0` keeps central forever (the sweep is skipped), matching the per-project `0`-means-forever semantics. Central is also **snapshot-protected** (HS-8877): a no-`hotsheet_project` write marks the central store dirty via `scheduleSnapshot`, so it gets the same debounced + shutdown `<dataDir>/snapshot.tar.gz` writes and `restore.ts` auto-restore as a project DB (lazily — only once central actually holds rows, since Hot-Sheet-spawned Claude always stamps the project, leaving central empty in practice). (Pre-HS-8607 the DELETE had no secret filter and ran under the launched project's DB context — when telemetry was a single shared store — so one project's sweep pruned *every* project's rows using only that project's window.)

**HS-8888/8889/8890 (§85) — retention bounding.** Beyond the time-window sweep above, three additions bound *row growth within a long-lived session* (full design: [85-telemetry-retention-bounding.md](85-telemetry-retention-bounding.md)). **Periodic sweep (HS-8889):** the sweep no longer runs only at startup — `src/telemetryRetentionTimer.ts` arms an `unref`'d 24 h timer that submits one coalesced `telemetry-retention-sweep` job to the §75 scheduler (GC, `deferUnderLag`) running `cleanupAllProjectsTelemetry` + nudging the VACUUM pass; stopped in `gracefulShutdown`. **Per-table windows (HS-8890):** `cleanupTelemetryRows` / `cleanupCentralTelemetry` now split `otel_spans` (§68 high-volume tracing) onto a shorter window — `telemetry_span_retention_days` / `centralSpanRetentionDays`, default **7 days** — from metrics/events (`telemetry_retention_days` / `centralTelemetryRetentionDays`, default 30), each `0` = forever. **Span row cap (HS-8890):** `capSpanRows(db, secret, cap=SPAN_ROW_CAP)` trims `otel_spans` to its newest **500k** rows after the time-based delete — a burst backstop applied even when the span window is "forever" (it's a safety limit). **Diagnostic (HS-8888):** `src/db/telemetryDiagnostics.ts::telemetryTableBreakdown` reports per-table row counts + on-disk size (which table dominates) — on `GET /api/telemetry/_debug` (`tableBreakdown`) + an off-loop per-DB startup log (`scheduleTelemetryBreakdownLog`).

**HS-8884 — disk reclaim (VACUUM).** A `DELETE` (retention sweep above, or the HS-8885 migration source-delete, or the §74 "Clear telemetry data" button) does NOT return disk to the OS in PGLite — dead tuples sit in the relation files, so a DB that grew to hundreds of MB stays that big after its rows age out (the HS-8882 bloat). `src/db/telemetryVacuum.ts` adds a VACUUM pass: `decideVacuumMode(sizeBytes, lastFullAt, now)` picks **none** (< 64 MB — above the ~38 MB empty-cluster baseline), **plain `VACUUM`** (reuses space, no exclusive lock — the routine path), or **`VACUUM FULL`** (rewrites + shrinks files back to the OS — recovers existing bloat, ≥ 150 MB, throttled to once per 7 days per DB via `telemetryVacuumFullAt` in `~/.hotsheet/config.json`). `scheduleTelemetryMaintenance(launchedDataDir)` runs from `cli.ts` post-startup (after the migration) and submits one job per telemetry DB (every project + central) to the **§75 background scheduler** at GC priority, `deferUnderLag`, in a single `telemetry-vacuum` exclusive group — VACUUM FULL takes a multi-second exclusive lock on a big DB, so it must NEVER run synchronously on the main loop (the HS-8874 startup-wedge class `diagnostics/watchdog.ts` SIGKILLs). The §74 clear path additionally calls `scheduleTelemetryReclaim(dataDir)` (a single forced VACUUM FULL, off-loop, not lag-deferred) so the just-cleared DB's files actually shrink. **HS-9228 — one-shot throttle-bypass after a big retention delete.** When the startup retention sweep deletes a large batch (≥ `ONE_SHOT_RECLAIM_MIN_DELETED` = 5,000 rows — e.g. the first launch after the HS-9229 verbose-event window + row caps prune a long backlog), `cli.ts` passes `{ throttleMs: 0 }` to `scheduleTelemetryMaintenance` for that launch, so the routine pass picks **`VACUUM FULL`** even if one was attempted within the 7-day throttle. The SIZE gate is kept (a small DB still doesn't FULL), and it stays off-loop + `deferUnderLag` via the scheduler — so the disk a big delete just freed is reclaimed on next launch without wedging startup or a mid-session interaction. This is why a one-time bloat needs no manual VACUUM: the retention bound frees the rows, and the next launch's one-shot reclaims them. Regression coverage: `src/db/telemetryVacuum.test.ts`.

**Known-benign VACUUM limitations (soft skip, never an error).** PGLite's WASM Postgres can't always complete a VACUUM on a given cluster; two such failures are expected and must NOT surface as alarming startup errors. (1) **HS-8897 — `pg_class` catalog rewrite** (`23505` on `pg_class_relname_nsp_index` during `VACUUM FULL`): `isVacuumFullCatalogError` → degrade to a plain `VACUUM` + back off future FULL retries. (2) **HS-8915 — `heap_pre_freeze_checks` freeze failure** (`XX001` "uncommitted xmin … needs to be frozen" while scanning a system catalog like `pg_catalog.pg_attribute`; can hit even a plain `VACUUM`): `isVacuumFreezeError` → `performVacuum` returns `ranMode: 'skipped'` with a single calm `console.warn`, so `maintainTelemetryDb` logs no reclaim and the outer `console.error` (reserved for genuinely unexpected failures) never fires. Disk reclaim is a maintenance nicety — a cluster that can't be vacuumed just keeps its current size and is retried on a future pass.

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

- `telemetry_enabled: boolean` — master toggle. **HS-8684 — default-on**: `undefined` (no choice yet) treated as enabled. Only an explicit `false` opts out. When `false`, no spawn-env injection AND incoming OTLP payloads for this project's secret are dropped (defensive defense-in-depth — the receiver should never see them since no Claude Code in this project is exporting).
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

Today's-cost element in the sidebar dashboard widget (`.sidebar-widget-cost`). Populated when `telemetry_enabled !== false` (HS-8684 default-on) AND today's cumulative cost > $0 for the active project AND the user's billing model is `'api'` (subscription mode hides the value because the metric is an API-equivalent estimate, not what the user pays — see HS-8497 / §67.13). Refreshes on the same poll cadence as the existing tab-bell-state poll. The widget itself remains the analytics-dashboard launcher on click. Tooltip: "Claude usage today (resets at local midnight)."

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

**HS-8780 — contextualization.** A user reported the modal's raw event stream was opaque ("are these sub-prompts? messages? when would I use this?"). The body now leads with a plain-English summary line (`summarizeTimeline` in `src/client/promptDrilldown.tsx` — "Claude emitted N telemetry events over D handling this prompt — X model requests, Y tool calls"; pure + unit-tested) and a collapsible **"What is this?"** `<details>` explainer that defines a prompt timeline, names the common event types (`api_request` / `tool_decision` / `tool_result` / hooks / MCP / skills), and frames it as a debugging/curiosity trace (pointing at the dashboard cards for at-a-glance cost/token totals). The raw attribute/body expansion stays for power users.

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

A "Claude usage" stats block on each ticket showing aggregate cost / tokens / prompt count / total duration spent on it. Correlation shipped via the marker (HS-8152) + time-window union (HS-8730) — see §67.11.

Locations:

- **Detail panel** — read-only stats block rendered by `ticketTelemetryStats.tsx` into `#detail-telemetry-stats`, positioned directly **above** the Notes section (HS-8648 moved it there from the panel bottom). The stat grid is container-query driven: 2 columns when the panel is narrow, 4 across when it's wide enough. `:empty` collapses the block when the ticket has no attributed prompts.
- **Ticket row** — optional dollar-amount chip when usage > $0.50 (configurable threshold).
- **Reader mode** — included in the §49 read-only overlay.

Source: `getPerTicketRollup(ticketNumber, secret)` in `otelDashboard.ts` — the UNION of the marker path and the time-window path (see §67.11), deduped per `otel_events` row, GROUP BY prompt for duration.

## 67.11 Prompt → ticket correlation (HS-8151 investigation → HS-8730 implementation)

Captured separately as HS-8151 (investigation). Five options were evaluated:

1. **`HOTSHEET_ACTIVE_TICKET` env at spawn.** Works only when the active ticket is known at spawn time; doesn't follow within-session ticket switches.
2. **Live-update via `OTEL_RESOURCE_ATTRIBUTES`.** Env vars can't update for a running shell — collapses to option 1's limitation.
3. **Tag prompts via the `/hotsheet` skill / channel-trigger flow.** When Hot Sheet triggers Claude with an active ticket, prepend a `<!-- hotsheet:ticket=HS-NNNN -->` marker in the prompt text that we parse out of `claude_code.user_prompt`'s body (`tagMessageWithActiveTicket`). Survives within-session ticket switches.
4. **Time-window heuristic.** Attribute api_request cost to whichever ticket was being worked at the event's timestamp.
5. **Inject via Claude SDK MCP server context.** Highest coupling, highest accuracy.

**Shipped: options 3 + a precise variant of 4, unioned (HS-8730).** Option 3 alone (the original HS-8152 implementation) only ever tagged the ONE ticket open in the detail panel at channel-trigger time, so the agentic worklist flow — where Claude pulls tickets off Up Next and marks each `started`→`completed` itself — left most tickets with no cost (HS-8729). HS-8730 adds the time-window source done *precisely*, not heuristically: the `updateTicket` status-transition hook records real `[started, ended]` work intervals into `ticket_work_intervals` (HS-8875 — the owning project's own DB, keyed by `project_secret`; writers resolve the DB from the secret so storage doesn't depend on the ambient async context), and `getPerTicketRollup` attributes any `api_request` whose `ts` falls inside an interval for that (project, ticket). The two sources are unioned and deduped at the event level. `POST /channel/done` closes any still-open interval so a `started` ticket left hanging (e.g. a FEEDBACK NEEDED hand-off) can't accrue unrelated future cost.

Honest limits: work done while **no** ticket is `started` stays project-level only (nothing to attribute it to); two Claude sessions in the **same project** working different tickets at the same time can cross-attribute by time (we don't get Claude's OTEL session-id on the ticket-update side) — rare, scoped by `project_secret`. The full-precision per-session correlation is not pursued unless this proves insufficient.

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
| HS-8151 | Investigation | Prompt ↔ ticket correlation (→ HS-8730) |
| HS-8152 | UI | Per-ticket cost rollup (marker correlation) |
| HS-8730 | Backend | Per-ticket cost time-window correlation (started→completed intervals); §67.11 |
| HS-8154 | Maintenance | Retention + auto-GC |

Foundations are the unblockers for everything else. Within Foundation, the order is: HS-8144 (schema) → HS-8143 (receiver) → HS-8145 (spawn-env) → HS-8146 (Settings UI). HS-8142 + HS-8144 + HS-8143 are shipping together as the first wave; the rest follow incrementally.
