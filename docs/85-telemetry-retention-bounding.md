# 85. Telemetry Retention Bounding (periodic sweep + per-table windows + size cap)

**Status: SHIPPED** (HS-8888 diagnostic + HS-8889 periodic sweep + HS-8890
per-table windows & span cap, 2026-06-19; **HS-9229** closed the events/metrics
gap — row caps + a shorter verbose-event window, see §85.2.3). Filed as HS-8886
from the HS-8882 telemetry-bloat investigation. The two sibling *disk-reclaim* bugs are also
shipped and bound the on-disk footprint:

- **HS-8884** — `VACUUM` pass (`src/db/telemetryVacuum.ts`): PGLite doesn't return
  disk to the OS on `DELETE`, so a routine plain `VACUUM` + a size-gated/throttled
  `VACUUM FULL` (off-loop via the §75 scheduler) reclaim it. See [67-telemetry.md](67-telemetry.md) §67.6.
- **HS-8885** — the per-project migration is now a **move, not copy**: foreign rows
  are deleted from the legacy launch-default DB after their destination insert
  confirms, so it stops hoarding a duplicate of everything migrated elsewhere.

This document covers the remaining piece: **bounding row growth within a session**
(not just at boot) and giving the time-based retention window a couple of sharper
backstops, so the §67.6 store can't balloon between restarts on a heavy-usage day.

## 85.1 Problem

The §67.6 retention sweep (`cleanupAllProjectsTelemetry` → `cleanupTelemetryRows`
/ `cleanupCentralTelemetry`, `src/cleanup.ts`) runs **once at startup**
(`cli.ts::initializeProject`). The `cleanupTelemetryRows` doc comment explicitly
deferred a periodic timer: *"A future ticket can add a periodic timer if
long-running sessions show enough row growth between startups to matter."* The
desktop app can stay open for days, and §68 enhanced tracing emits high-volume
OTLP **spans** — so between restarts a single store can accumulate a lot of rows.

Two structural gaps in the current single-knob (`telemetry_retention_days`,
default 30) time window:

1. **It's only enforced at boot.** A days-long session never re-sweeps.
2. **A time window doesn't bound a burst.** One extremely heavy day can write far
   more than 30 days of normal usage; nothing caps the *count*.

## 85.2 Decided design (HS-8886 feedback, 2026-06-19)

### 85.2.1 Periodic in-session sweep — every 24 h
Add a periodic retention sweep, **cadence 24 h**, run **off the main loop via the
§75 background scheduler** (`getBackgroundScheduler().submit`) at `PRIORITY.GC`
with `deferUnderLag: true` and a coalescing key (`telemetry-retention-sweep`), so
it never competes with request handling and is deferred under event-loop lag. It
reuses the existing `cleanupAllProjectsTelemetry(dataDir)` driver — same per-
project secret scoping + central store handling as the startup sweep, just on a
timer in addition to boot. The timer is `unref()`'d so it never keeps the process
alive, and cleared on shutdown.

### 85.2.2 Per-table retention windows — spans get 7 days
`otel_spans` (§68 enhanced tracing, beta-only, high-volume) gets a **shorter
default window: 7 days**, while `otel_metrics` / `otel_events` keep the 30-day
default. Today `cleanupTelemetryRows` applies one `telemetry_retention_days` value
to all three tables; this splits the span window out.

- Default: spans 7 d, metrics/events 30 d.
- Configurability: a new optional per-project setting (e.g.
  `telemetry_span_retention_days`) + a central-store analogue in global config
  (`centralSpanRetentionDays`), each falling back to the 7-day default; `0` =
  keep forever, matching the existing `0`-means-forever semantics. The existing
  `telemetry_retention_days` continues to govern metrics + events.
- The §74 "Clear telemetry data" + the existing UI copy should mention spans age
  out faster (so the dashboards' trace history being shorter than cost history is
  expected, not a bug).

### 85.2.3 Hard size cap — per-table row cap on spans (~500k)
A **per-table row cap on `otel_spans`**, independent of the time window: keep the
**newest ~500,000 spans**, delete older rows beyond that. This is the least-
surprising backstop — it targets the confirmed high-volume table (see §85.2.4)
rather than silently trimming a whole-DB byte budget that could drop low-volume
metrics/events a user still wants. Implementation: after the time-based delete,
if `COUNT(*) FROM otel_spans` (scoped to the secret) exceeds the cap, delete the
oldest `count - cap` rows (`ORDER BY start_ts ASC LIMIT …`, or an `id <` cutoff
from the keyset). The cap is a constant with room to become a setting later.

**HS-9229 (epic HS-9226 Phase 0) — closed the events/metrics gap.** The
"metrics/events have no row cap initially" assumption above proved wrong in
practice: `otel_events` grew to 563 MB / 219k rows and `otel_metrics` to 203 MB /
100k rows — the dominant bloat behind the §73 snapshot freeze (epic HS-9226). Two
additions in `src/cleanup.ts`, applied on both the per-project and central sweep:

- **`EVENT_ROW_CAP` / `METRIC_ROW_CAP` (500k each)** — the same burst backstop
  spans have, via the generalized `capTableRows(db, table, tsColumn, secret, cap)`
  (`capSpanRows` is now a thin wrapper). Independent of the window, so it bounds
  even a "keep forever" (`0`) setting.
- **A shorter window for verbose, inspector-only events** —
  `hook_execution_start` / `hook_execution_complete` / `tool_result` /
  `tool_decision` (the high-frequency bulk no stats query reads) age out on
  `DEFAULT_VERBOSE_EVENT_RETENTION_DAYS` (**7d**, mirroring spans), matched in both
  the bare and `claude_code.`-prefixed forms. `api_request` (per-ticket cost),
  `user_prompt` / `assistant_response` (human-meaningful), and the `token.usage` /
  `cost.usage` metrics keep the full `telemetry_retention_days` window. This cut is
  independent of the general window, so it trims the bulk even under keep-forever.
  (The 7d window is a constant for now — a setting can follow.)

### 85.2.4 Diagnostic FIRST — confirm the dominant table
HS-8882 *suspected* spans dominate but couldn't confirm row distribution without
the user's DB. Before relying on the span-targeted cap/window, ship a small
diagnostic: a **per-table row + on-disk size breakdown** — a one-line startup log
(`otel_spans=N (X MB) otel_metrics=… otel_events=…`) and/or a field on the
existing `GET /api/telemetry/_debug` route. This both validates the "spans
dominate" assumption and gives an ongoing signal if the real driver shifts. This
is **step 1** and is filed as its own follow-up (it's useful regardless of the
rest).

## 85.3 Non-goals / deferred
- **Whole-DB byte-size cap** — rejected in favor of the per-table row cap
  (§85.2.3); revisit only if a non-span table is later shown to dominate.
- **User-facing cadence control** — 24 h is hard-coded initially; expose a setting
  only if there's demand.
- Disk reclaim itself (`VACUUM`) is already handled by HS-8884; the periodic sweep
  reuses that scheduling group so a sweep's deletes get reclaimed on the normal
  VACUUM cadence.

## 85.4 Implementation (shipped)
All three follow-ups landed 2026-06-19:

1. **Per-table telemetry diagnostic** (HS-8888) — `src/db/telemetryDiagnostics.ts`:
   `telemetryTableBreakdown(dataDir)` (per-table row counts + cluster size) +
   `formatTelemetryBreakdown`. Surfaced on `GET /api/telemetry/_debug`
   (`tableBreakdown`, active project) and as a per-DB startup log via
   `scheduleTelemetryBreakdownLog` (off-loop, §75 scheduler, GC + `deferUnderLag`).
2. **Periodic 24 h retention sweep** (HS-8889) — `src/telemetryRetentionTimer.ts`:
   `startTelemetryRetentionTimer` arms an `unref`'d 24 h interval whose tick
   submits one coalesced `telemetry-retention-sweep` job (GC, `deferUnderLag`)
   that runs `cleanupAllProjectsTelemetry` then nudges the §75 vacuum pass;
   `stopTelemetryRetentionTimer` is a `gracefulShutdown` step. Wired in `cli.ts`.
3. **Per-table retention windows + span row cap** (HS-8890) — `src/cleanup.ts`:
   `cleanupTelemetryRows` / `cleanupCentralTelemetry` split the span window
   (`telemetry_span_retention_days` / `centralSpanRetentionDays`, default 7) from
   metrics/events (`telemetry_retention_days` / `centralTelemetryRetentionDays`,
   default 30), each `0` = forever; then `capSpanRows(db, secret, cap=SPAN_ROW_CAP)`
   trims `otel_spans` to its newest 500k (a safety limit applied even when the
   span window is "forever").

Coverage (§67.6 test style): `telemetryDiagnostics.test.ts`,
`telemetryRetentionTimer.test.ts`, `telemetryRetention.test.ts` (span-vs-metric
windows, `0`-means-forever, the row-cap trim keeping exactly the newest N), plus
the existing `cleanupTelemetry.test.ts`.
