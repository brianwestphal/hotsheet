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
