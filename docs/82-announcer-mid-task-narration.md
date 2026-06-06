# 82. Announcer Live — Mid-task Narration off the Telemetry Stream

**Status: Shipped (HS-8789, 2026-06-06).** Origin: HS-8781 part 2 ("option A").
Makes live mode (§80) "more live" by narrating work **as Claude is doing it**
(mid-task), not only after a unit lands — by adding the §67 telemetry event
stream as a signal source, and using the summarizer to **rate importance and drop
the uninteresting** so the mid-task stream doesn't become spoken noise.

Builds on [80-announcer-live-mode.md](80-announcer-live-mode.md) (the
producer/consumer live loop), [78-announcer.md](78-announcer.md) (the announcer +
summarizer), and [67-telemetry.md](67-telemetry.md) (the OTLP event stream).

## 82.1 The gap it closes

Before this, the live generator's only signals were **after a unit completes**:
completion/ticket notes, status changes, and the §14 command-log
(`collectWorkSignals`). So nothing was narrated until a ticket was marked done or
a note written. Claude Code already emits `user_prompt` + `tool_result` telemetry
events every few seconds *while working* (§67) — this feeds those in.

## 82.2 New signal source

`src/announcer/telemetrySignals.ts` → `collectTelemetrySignals(projectSecret,
since)` reads the shared telemetry DB (`getTelemetryDb`, keyed by
`project_secret`) and renders a few chronological lines, **grouped by
user-prompt turn** (a burst of tool calls becomes ONE line, not dozens):

- one line per in-window `user_prompt`: `"[in progress] working on: \"<snippet>\"
  (used Bash ×3, Edit ×2)"` — the prompt body trimmed to a 200-char snippet with
  the `<!-- hotsheet:ticket=… -->` marker stripped, plus that turn's tool counts;
- one catch-all `"[in progress] ongoing work (used …)"` for tool activity whose
  prompt turn started before the cursor.

No cursor → it looks back 30 min only (mid-task cares about *now*). It's a dumb,
deterministic collector — it does NOT decide what's worth saying (§82.4 does).

`collectWorkSignals(since, { projectSecret, includeTelemetry })` merges these
chronologically with the existing signals under the same `capMaterial` budget.

## 82.3 Triggering + coalescing

- **Wake on telemetry:** the OTLP receiver (`src/routes/otel.ts`) now calls
  `notifyChange()` after a successful metrics/logs ingest with `inserted > 0`
  (mirrors `addLogEntry`'s HS-8767 wiring), so the live loop wakes on tool/prompt
  activity, not just ticket/command-log changes.
- **15 s debounce:** the live loop's `CoalescingTrigger` quiet window is **15 s**
  (max-wait 30 s) — a turn's burst of telemetry (prompt + many tool calls)
  coalesces into one narration pass. (This governs the whole shared live loop, so
  the completion path is also 15 s-debounced now.)

## 82.4 Importance rating + exclusion

The mid-task stream is noisy, so the **AI decides what's worth narrating**
(HS-8789): every generated entry carries an `importance` of `low` | `medium` |
`high` (`EntrySchema` + the Anthropic `output_config` schema + the local-provider
prompt). The system prompt instructs: completed features/fixes/decisions are
medium/high; routine, mechanical, or merely in-progress activity (`[in progress]`
tool churn, single commands, boilerplate) is `low` and should usually be omitted.
`dropUnimportant()` then filters `low` entries before persist — applied to **all**
provider paths (Anthropic / Apple / local). Only an explicit `low` is dropped, so
a provider that omits the field (Apple guided generation) keeps its entries.

## 82.5 Gating + cost

- **Off unless live + telemetry on:** `generateAnnouncementsOnce` includes
  telemetry only when the live generator passes `includeTelemetry: true` AND the
  project hasn't opted out of telemetry (`telemetry_enabled !== false`). The
  manual after-the-fact `POST /api/announcer/generate` never includes it.
- **Budget:** unchanged — the HS-8770 `callBudget` (6 summarize calls / 60 s per
  project) still gates the paid call, and the off-unless-listening lease (§80)
  still gates the whole loop, so mid-task generation can't run away or spend in
  the background. Spend lands on the §70/§71 dashboards via `announcer_usage`.

## 82.6 Tests

- `telemetrySignals.test.ts` — turn grouping (snippet + tool counts), marker
  strip, orphan-tool fold, cursor + project scoping, empty.
- `collectSignals.test.ts` — telemetry merged only when
  `includeTelemetry`+`projectSecret`; default path untouched.
- `summarize.test.ts` — `low` entries dropped, medium/high/unrated kept, usage
  still captured.

## 82.7 Follow-ups

- **Prompt tuning:** the global `low`-importance filter now affects the
  after-the-fact digest too; if it ever over-drops there, scope the filter to the
  live/telemetry path or tune the prompt (tracked separately).
- **Prompt-text privacy toggle:** mid-task narration sends a trimmed user-prompt
  snippet to the model (same trust class as the notes already sent). A per-project
  "don't send prompt text" option could narrate tool activity only (follow-up).
- **Real-data validation:** behavior with a live Anthropic key + a real telemetry
  stream is a manual pass (`docs/manual-test-plan.md` §15).
