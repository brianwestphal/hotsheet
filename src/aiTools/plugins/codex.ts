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
    // Inclusive parents + derivable totals: real counters, deliberately unrouted.
    'codex.turn.token_usage.input_tokens': 'ignore',
    'codex.turn.token_usage.reasoning_output_tokens': 'ignore',
    'codex.turn.token_usage.total_tokens': 'ignore',
    'codex.usage.total_tokens': 'ignore',
  },
  // HS-9605 — stated rather than left absent: codex reports tokens in detail and
  // cost NEVER (verified against 0.146.0 — zero `*.cost*` metrics exist). Absence
  // would read as "nobody checked".
  telemetryReportsCost: false,
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
