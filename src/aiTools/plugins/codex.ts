// HS-9490 (docs/132) — Codex. MCP-native (no ACP mode in codex-cli); driven over its
// app-server JSON-RPC protocol (docs/121) with model-B terminal hosting (docs/129).

import type { AiToolPlugin } from '../types.js';

export const codexPlugin: AiToolPlugin = {
  id: 'codex',
  displayName: 'Codex',
  productName: 'Codex',
  tier: 'cli-agent',
  devGateKey: 'dev_tool_codex',
  transport: 'mcp-hooks',
  detection: { binaries: ['codex'], paths: ['AGENTS.md'] },
  instructions: {
    relPath: 'AGENTS.md',
    frontmatter: '',
    adapterSkillsRoot: '.agents/skills',
  },
};
