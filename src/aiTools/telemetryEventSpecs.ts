/**
 * HS-9622 / HS-9623 — per-tool declarations for how a tool's OTLP LOG events are
 * treated at ingest and read time. Both exist because codex, unlike Claude Code,
 * has no per-signal OTLP routing: it POSTs its ENTIRE internal `tracing` stream
 * to the single `/v1/logs` endpoint (see `codexTelemetry.ts`), and it stamps no
 * `prompt.id`. So Hot Sheet has to do at ingest/read what Claude's exporter does
 * at the source — decide what is noise, and decide what clusters into a "prompt".
 *
 * Pure types only (no imports), so `aiTools/types.ts`, the codex plugin, and the
 * two registry-driven helpers (`logNoise.ts`, `db/otelPromptGrouping.ts`) can all
 * share them without an import cycle.
 */

/**
 * HS-9622 — which of a tool's log events carry no dashboard or timeline value and
 * should be DROPPED at ingest rather than bloat the JSONL event store.
 *
 * Codex is the reason this exists. Measured against codex-cli 0.147.0, it floods
 * the logs endpoint with internal transport/lifecycle records — a
 * `codex.websocket_request` per HTTP request, a `codex.sse_event` per streamed
 * chunk — none of which the dashboard or the docs/68 timeline render. The
 * semantic events that DO matter (`codex.user_prompt`, `codex.api_request`, and
 * the token-bearing `codex.sse_event`/`response.completed`) are the codex analogs
 * of Claude Code's curated `logs & events` set, so keeping them and dropping the
 * rest is "route it the way Claude does" — Claude's exporter simply never emits
 * the transport chatter in the first place.
 *
 * A DROP list (not an allowlist) so a future useful codex event survives by
 * default; only what is positively known to be noise is discarded.
 */
export interface TelemetryLogNoiseSpec {
  /** Full `event.name` values that are always internal noise (dropped whole). */
  readonly dropEventNames: readonly string[];
  /**
   * For a high-volume streaming event, keep ONLY records whose `event.kind` is in
   * the list and drop every other kind. Codex sends one `codex.sse_event` per
   * streamed chunk (`response.created`, `response.output_text.delta`, …); only
   * `response.completed` carries the turn's token totals and closes the turn, so
   * that is the single kind worth keeping.
   */
  readonly keepOnlyKinds?: Readonly<Record<string, readonly string[]>>;
}

/**
 * HS-9623 — how a tool's log events cluster into "prompts" for the docs/68
 * timeline when the tool does NOT stamp Claude's `prompt.id`.
 *
 * Claude Code stamps every `user_prompt` / `api_request` / `tool_result` with a
 * shared `prompt.id`, and the timeline groups by it. Codex stamps none, so a
 * codex *turn* — one `user_prompt` through the following `response.completed` — is
 * the natural analog of a Claude prompt, and Hot Sheet synthesizes a stable
 * per-turn id at read time (`db/otelPromptGrouping.ts`). This spec is the per-tool
 * "what identifies a prompt" declaration HS-9609 anticipated.
 */
export interface PromptGroupingSpec {
  /** Attribute that scopes a conversation/thread — codex: `conversation.id`. Used
   *  to keep concurrent threads' events from bleeding into each other's turns. */
  readonly threadAttr: string;
  /** The full stored `event.name` that OPENS a new prompt/turn — codex:
   *  `codex.user_prompt`. Each occurrence starts a fresh synthetic prompt id. */
  readonly turnStartEvent: string;
  /** Prefix for the synthesized id (`<prefix>.<thread>.<epochMs>`), kept
   *  URL-safe (dots + the thread uuid) so it round-trips through the
   *  `/telemetry/prompt/:id` drilldown route unescaped. */
  readonly turnIdPrefix: string;
}
