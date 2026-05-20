# 68. Beta enhanced tracing — span tree + waterfall

## 68.1 Goal

Extend the per-prompt drilldown ([67-telemetry.md](67-telemetry.md) §67.10.3) so that, when Claude Code's **beta enhanced-tracing** opt-in is on, the modal renders the captured span tree (parent / child relationships intact) and surfaces an inline Chrome-style waterfall for spotting which sub-span dominated a slow turn.

This is the user-visible payoff for `otel_spans` (the third PGLite table from §67.6) and the trace-payload branch of the OTLP receiver (`persistTracesPayload` in `src/db/otelWriters.ts`). Both already exist; this doc is the rendering layer that consumes them.

Marked **beta** in the UI: Claude Code's upstream surface (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) is explicitly labelled beta and may shift attribute shapes between Claude Code releases without notice. The doc + the UI both call this out so the user knows why the trace view occasionally renders a span with `(unknown)` attributes after a Claude Code upgrade.

## 68.2 Scope

### In scope

- Spawn-env wiring for the beta trace opt-in (the bytes that turn it on for a running `claude` inside a Hot Sheet terminal).
- Per-prompt drilldown integration: when spans exist for the prompt, the body renders as a span tree **in place of** the flat event list (per the §68.5.1 decision); when spans don't exist, the existing flat event list stays exactly as it shipped under HS-8149.
- Inline collapsible waterfall panel at the top of the drilldown body when spans exist.
- BETA badging in the drilldown header + Settings → Telemetry sub-toggle.

### Out of scope

- A standalone "traces explorer" view outside the per-prompt drilldown — the drilldown is the entry point for trace data because every span carries a `prompt.id` correlation key.
- Span-level filtering / search across all traces — defer until usage shows the need.
- Cross-prompt trace comparison (diff two slow turns side-by-side) — defer.
- Persisting trace payloads (already shipped under HS-8470 / `persistTracesPayload`); this doc is read-side only.
- Exporting traces to an external observability backend — explicitly out of scope per §67.12.

## 68.3 Spawn-env: beta trace opt-in

`src/terminals/registry/otelEnv.ts::buildOtelEnv(dataDir)` already reads `telemetry_traces_enabled` per §67.3 and, when both `telemetry_enabled === true` AND `telemetry_traces_enabled === true`, injects:

```
OTEL_TRACES_EXPORTER=otlp
CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
```

These two env vars together flip Claude Code's exporter into the beta-trace mode that emits turn / LLM-request / tool / hook spans every 5 seconds. The `buildOtelEnv` plumbing is already in place — this doc is the consumer; the producer ships under §67.3 already.

If the spawn-env wiring needs a follow-up adjustment (e.g. Claude Code renames the env var, or a future Claude Code release graduates the surface out of beta), the change lands in `otelEnv.ts` exclusively; no UI work in this doc has to change as long as the resulting `otel_spans` rows keep the same shape.

## 68.4 Data shape

### What lands in `otel_spans`

Per §67.6 schema:

```sql
CREATE TABLE otel_spans (
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
```

Every span carries `trace_id` + `span_id` + (nullable) `parent_span_id`. The set of rows where `prompt_id = ?` forms the tree for that prompt. Root spans have a `parent_span_id` of `NULL` OR a `parent_span_id` whose `span_id` is not in the result set (e.g. a session-scoped root that lives outside the prompt's span boundary — the renderer treats these as roots regardless).

### Tree assembly

A pure helper `assembleSpanTree(spans: SpanRow[]): SpanTreeNode[]` lives in `src/client/spanTree.ts`. Single pass:

1. Index every row by `span_id` into a `Map<spanId, SpanTreeNode>`.
2. Iterate the indexed map; each node whose `parent_span_id` is in the map gets pushed onto that parent's `children`. Nodes whose `parent_span_id` is `NULL` or missing become roots.
3. Sort each level by `start_ts ASC` (then `span_id` as a stable tiebreaker).

The function is pure (no DOM) and shape-isolated (`SpanTreeNode = { row, children, depth }`) so it's trivially unit-testable. Tree assembly runs once per drilldown open.

### Why a fresh route vs. extending `/api/telemetry/prompt/:id`

The existing `getPromptTimeline` route (HS-8149) returns events only. Adding a `spans: SpanRow[]` field to its `PromptTimeline` response is a one-line additive change to the existing `src/db/otelQueries.ts::getPromptTimeline` query — UNION the `otel_events` rows with an aliased `otel_spans` query OR add a second `SELECT … FROM otel_spans WHERE prompt_id = $1` and bundle into the same `Promise.all`. The second variant is cleaner (no UNION needed, span rows keep their own column shape).

When `spans.length > 0`, the drilldown switches to span-tree mode. When `spans.length === 0`, the existing flat-events render path runs unchanged.

## 68.5 UI integration

### 68.5.1 Span tree replaces the flat event list

Decision: when spans exist for the prompt, the drilldown body **renders the span tree in place of** the flat `<ol>` event list. Events fold into the relevant span as leaf rows under the deepest enclosing span (matched by `event.ts ∈ [span.start_ts, span.end_ts]` AND closest `start_ts` first when multiple spans contain the timestamp).

Why replace rather than augment-as-tab:

- The trace tree is the richer hierarchy — the event list is a flat projection of the same underlying activity. Showing both means the user has to mentally reconcile two views of the same data.
- A second tab adds navigation friction for the common case (open drilldown → look at slowest sub-span). Replace keeps the canonical view one click away.
- For prompts with no spans (the common case in non-beta mode), the existing flat list stays as the canonical view. Two UIs do exist, but they're mutually exclusive based on data presence — never both at once.

Indentation is per-depth `20 px` with a left rule that mirrors the existing reader-mode indent treatment. The span row carries:

- `span_name` (e.g. `claude_code.turn` / `claude_code.llm_request` / `claude_code.tool.bash`)
- duration (`end_ts - start_ts`) formatted via the existing `formatDuration` helper
- a small status badge (`OK` / `ERROR` / `UNSET`) sourced from `status_code`
- optional `model` attribute pinned when `span_name === 'claude_code.llm_request'`

Each span row is click-expandable like the existing event rows — expansion reveals `attributes_json` verbatim.

### 68.5.2 Inline waterfall panel

The "Trace" surface lives **inline** at the top of the drilldown body, **above** the span tree. Decision rationale per §68.1 clarifying-question answer:

- A separate stacked modal forces the user to bounce between two overlays to correlate a waterfall bar with its row in the tree below.
- A content-toggle (swap drilldown body between waterfall and timeline) hides the correlation entirely — you can't see both at once.
- Inline lets the user scroll the waterfall + tree as a single document; clicking a bar scrolls the tree to the corresponding row, clicking a tree row scrolls + flashes the bar.

The waterfall panel is collapsed by default (a `<details>`-like disclosure with the BETA badge in the summary row); the user expands it when they want the visual.

Layout:

- Horizontal canvas (full body width minus padding), height = `(maxDepth + 1) * 24px`, capped at `240px` (10 rows). Beyond 10 levels, the canvas grows and scrolls vertically inside its container.
- Each span = a `<rect>` positioned by `start_ts` (x) and `end_ts - start_ts` (width). x-axis spans `[firstSpanStart, lastSpanEnd]`. y-axis = depth in the tree.
- `<title>` on each `<rect>` for hover tooltip ("`claude_code.llm_request` — 12.3 s — sonnet").
- Click a bar → scroll the span tree to the corresponding row and apply a 600 ms `.span-tree-row-flash` highlight class.
- Inline `<svg>` only (no chart library dep), matching the §67.10.5 per-tool histogram precedent.

### 68.5.3 Beta gating + badge

Two surfaces carry the `BETA` badge:

- **Settings → Telemetry → "Enhanced tracing (beta)"** sub-toggle row already exists per §67.9 / HS-8146; add a `BETA` chip next to the label. Tooltip: "Claude Code's enhanced-tracing surface is upstream-beta and may change without notice."
- **Drilldown waterfall summary row** ("▶ Trace (BETA)") — only visible when spans exist for the prompt.

When `telemetry_traces_enabled === false` AND the prompt has no spans (the normal case), the drilldown stays in the existing flat-events shape with no waterfall affordance at all — no greyed-out button, no "enable traces" tooltip. The user discovers the feature by visiting Settings → Telemetry, not by hunting for a disabled button in the drilldown.

When `telemetry_traces_enabled === true` but the specific prompt happens to have no spans (e.g. it ran before the user enabled traces), the drilldown renders flat events; an inline `<p class="telemetry-traces-beta-note">` near the top of the body says "No spans recorded for this prompt — traces are emitted starting after the next session-start." No waterfall affordance.

## 68.6 Open questions

### Span name stability

Claude Code's beta surface emits span names like `claude_code.turn`, `claude_code.llm_request`, `claude_code.tool.<name>`. None of these are guaranteed stable across Claude Code releases. The renderer treats `span_name` as a raw string — no per-name logic that would break on a rename. The optional `model` extraction (§68.5.1) is gated on `span_name === 'claude_code.llm_request'`; if Claude Code renames it, the pin disappears silently and the row still renders.

### Spans that span multiple prompts

A trace can in principle span more than one prompt (e.g. a parent span representing a multi-turn agent loop). Per §67.6 each span row carries the `prompt_id` it was emitted under, so the per-prompt drilldown only sees spans tagged with that prompt. Cross-prompt parent visualisation is deferred — the per-prompt scope keeps the surface simple and the most-common case (which is a single turn).

### Histogram convergence with §67.10.5

The HS-8150 per-tool latency histograms (shipped) currently source `duration_ms` from `claude_code.tool_result` events. When traces are on, `otel_spans` carries higher-fidelity per-tool timing (every tool invocation gets its own span with `start_ts` + `end_ts`). A follow-up could swap the histogram source to `otel_spans` when present and fall back to events when absent. Tracked as a follow-up to this doc (§68.8 ticket map). Not in scope for the initial waterfall ship.

## 68.7 Out of scope (deferred)

- Span-search filter ("show me every span where `model = sonnet` AND `duration > 5s`") — defer until the inline browse experience proves insufficient.
- Cross-prompt waterfall comparison — defer.
- Per-span CSV export — defer (the existing `attributes_json` expansion exposes the raw data already).
- Persisting a synthetic root span for prompts that came in without any — the renderer treats events as the fallback view; no synthetic spans needed.

## 68.8 Ticket map

The full feature decomposes into the following implementation tickets:

| Ticket | Phase | Surface |
|---|---|---|
| HS-8155 | Foundation | This requirements doc |
| HS-8475 | Backend | Extend `getPromptTimeline` to also return `spans: SpanRow[]` via a second query bundled into the existing `Promise.all`; add `src/client/spanTree.ts` pure tree-assembly helper + unit tests |
| HS-8476 | Client | `promptDrilldown.tsx` — render span tree in place of flat events when `spans.length > 0` (events fold under the deepest enclosing span) |
| HS-8477 | Client | `promptDrilldown.tsx` — inline `<details>`-shaped waterfall panel above the span tree with bar-to-row scroll-link + `BETA` badging in Settings + drilldown |
| HS-8478 | Polish | Spans-first source for `getToolLatencyHistogram` (§67.10.5) with events-fallback when no spans present |

## 68.9 References

- [67-telemetry.md](67-telemetry.md) §67.3 (spawn-env), §67.6 (otel_spans schema), §67.9 (Settings UI), §67.10.3 (per-prompt drilldown), §67.10.4 (trace waterfall — this is the doc).
- [Claude Code agent SDK observability](https://code.claude.com/docs/en/agent-sdk/observability.md) — upstream beta-trace surface.
- OTLP/HTTP spec — span payload format the receiver already decodes via `decodeProtobufPayload('traces', bytes)`.
