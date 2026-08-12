// HS-9490 (docs/132) — Codex. MCP-native (no ACP mode in codex-cli); driven over its
// app-server JSON-RPC protocol (docs/121) with model-B terminal hosting (docs/129).

import type { AiToolPlugin } from '../types.js';

export const codexPlugin: AiToolPlugin = {
  id: 'codex',
  displayName: 'Codex',
  productName: 'Codex',
  // HS-9602 — measured against codex-cli 0.146.0: `codex.api_request`,
  // `codex.conversation.turn.count`, … over the standard OTLP exporter.
  telemetryMetricPrefix: 'codex.',
  // HS-9601 — worker-pool support (maintainer decision 2026-08-05: option (a),
  // a PTY worker like Claude's rather than a headless drive session).
  //
  // `codex [OPTIONS] [PROMPT]` takes a positional prompt to start an interactive
  // session, so the shape matches Claude's. What does NOT match is how the skill
  // is invoked: Claude takes `"/hotsheet-worker"` and resolves it to a skill.
  // Codex discovers skills under `.agents/skills` (docs/118) but its
  // slash-command syntax from a positional prompt is unverified, so the prompt
  // NAMES THE FILE instead of guessing at an invocation syntax. Worse case that
  // fails visibly in the worker's own terminal rather than silently doing
  // nothing, which is the HS-9594 failure mode this ticket exists to avoid.
  //
  // No channel flag, and that is not an omission: codex reaches the `hotsheet_*`
  // tools through its GLOBAL cwd-resolving MCP config (docs/115, `src/codex.ts`),
  // so a worktree is served by cwd alone. Its permission bridge is
  // `.codex/hooks.json`, written into the worktree by `ensureSkillsForDir` —
  // note that bridge is opt-in (`codex_interactive_permissions`); with it off a
  // worker's approvals prompt in its own terminal rather than the Hot Sheet UI.
  worker: {
    launchCommand: () =>
      'codex "Read .agents/skills/hotsheet-worker/SKILL.md and follow it exactly, starting now."',
    binary: 'codex',
  },
  // HS-9604 — codex's counters are NESTED, so the inclusive parents are
  // positively ignored rather than omitted. Measured over 4,778 real
  // `TokenUsage` records: `cached_input_tokens` <= `input_tokens` and
  // `reasoning_output_tokens` <= `output_tokens`, both 4778/4778. Routing the
  // parents alongside their children would report ~2x the real total.
  telemetryTokenMetrics: {
    // The disjoint pair — `input = cached + non_cached`.
    'codex.turn.token_usage.non_cached_input_tokens': 'input_tokens',
    'codex.turn.token_usage.cached_input_tokens': 'cache_read_tokens',
    'codex.turn.token_usage.cache_write_input_tokens': 'cache_creation_tokens',
    'codex.turn.token_usage.output_tokens': 'output_tokens',
    // A BREAKDOWN of output_tokens, not a peer — stored for detail, never summed.
    'codex.turn.token_usage.reasoning_output_tokens': 'reasoning_output_tokens',
    // Inclusive parent + derivable totals: real counters, deliberately unrouted.
    'codex.turn.token_usage.input_tokens': 'ignore',

    'codex.turn.token_usage.total_tokens': 'ignore',
    'codex.usage.total_tokens': 'ignore',
    // The `codex.usage.*` family is the SESSION-cumulative counterpart of the
    // per-turn ones above. Routing this alongside the turn-level reasoning
    // counter would count reasoning twice, so it is excluded for the same
    // reason `codex.usage.total_tokens` is. (Enumerated from codex-cli 0.146.0:
    // these two are the only `codex.usage.*` token metrics.)
    'codex.usage.reasoning_output_tokens': 'ignore',
  },
  // HS-9621 — the LIVE token path. Measured on the wire against codex-cli 0.147.0
  // (OTLP captured through a proxy, protoc-decoded): codex emits token usage ONLY
  // as an OTLP LOG record — `event.name='codex.sse_event'`,
  // `event.kind='response.completed'`, with the counters as attributes — and
  // sends ZERO token metrics, so the `telemetryTokenMetrics` map above matches
  // nothing on the stream (it is kept for a possible future/interactive build
  // that emits the `codex.turn.token_usage.*` metrics). The counters are nested
  // exactly like the rollout files (`input_token_count` ⊇ `cached_token_count`,
  // `output_token_count` ⊇ `reasoning_token_count`); because a log record carries
  // them together, the ingest resolves the nesting by subtraction rather than by
  // ignoring the parents. Values arrive as a mix of strings and ints.
  telemetryLogTokens: {
    eventName: 'codex.sse_event',
    eventKind: 'response.completed',
    modelAttr: 'model',
    inputInclusive: 'input_token_count',
    outputInclusive: 'output_token_count',
    cacheRead: 'cached_token_count',
    cacheCreation: 'cache_write_token_count',
    reasoning: 'reasoning_token_count',
  },
  // HS-9605 — stated rather than left absent: codex reports tokens in detail and
  // cost NEVER (verified against 0.146.0 — zero `*.cost*` metrics exist). Absence
  // would read as "nobody checked".
  telemetryReportsCost: false,
  // HS-9622 — codex has no per-signal OTLP routing, so it POSTs its whole internal
  // `tracing` stream to `/v1/logs`: a `websocket_request` per HTTP request, a
  // `sse_event` per streamed chunk, a `startup_phase` per process. None of it
  // reaches the dashboard or the docs/68 timeline, and it bloats the JSONL event
  // store. Drop it at ingest so codex's STORED events match Claude's curated
  // `logs & events` set — i.e. the semantic records only. What is KEPT (not listed
  // here): `codex.user_prompt`, `codex.api_request`, the token-bearing
  // `codex.sse_event`/`response.completed`, and low-volume lifecycle markers
  // (`conversation_starts`, `turn_ttft`) the timeline can render.
  telemetryLogNoise: {
    dropEventNames: [
      'codex.startup_phase',
      'codex.websocket_connect',
      'codex.websocket_request',
    ],
    // The highest-volume noise: one `codex.sse_event` per streamed chunk. Only
    // `response.completed` carries the turn's token totals and closes the turn
    // (it is the SAME record `telemetryLogTokens` reads), so keep that kind alone.
    keepOnlyKinds: {
      'codex.sse_event': ['response.completed'],
    },
  },
  // HS-9623 — codex stamps no `prompt.id`, so the docs/68 timeline synthesizes a
  // per-turn id at read time: each `codex.user_prompt` opens a turn, and the
  // following events (scoped by `conversation.id` where present) join it. A codex
  // turn is the analog of a Claude prompt.
  promptGrouping: {
    threadAttr: 'conversation.id',
    turnStartEvent: 'codex.user_prompt',
    turnIdPrefix: 'codex.turn',
  },
  tier: 'cli-agent',
  maturity: 'beta',
  transport: 'mcp-hooks',
  detection: { binaries: ['codex'], paths: ['AGENTS.md'] },
  instructions: {
    relPath: 'AGENTS.md',
    frontmatter: '',
    adapterSkillsRoot: '.agents/skills',
  },
  // HS-9359 / HS-9383 (docs/121 O4) / HS-9497 — default ON: absent ⇒ overlay approvals,
  // explicit false ⇒ auto-approve. The OPPOSITE default to antigravity's, which is why
  // the declaration carries it rather than assuming false.
  preferences: [{
    key: 'codex_interactive_permissions',
    label: 'Interactive permission prompts (Codex)',
    type: 'boolean',
    default: true,
    description: 'When on, the play button runs `codex` **without** the approvals/sandbox bypass (workspace-write sandbox + hooks instead) and installs `.codex/hooks.json` hooks that route each mutating tool call and approval request through Hot Sheet\'s permission popup (Allow / Deny). Hot Sheet\'s own `hotsheet_*` tools are auto-allowed. Off = codex runs the worklist unattended (auto-approve).',
  }],
};
