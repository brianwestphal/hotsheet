// HS-9490 (docs/132) — Antigravity. The first MCP+hooks agent (docs/115); its binary is
// `agy`, which is why `AGENT_BINARIES` exists at all (id ≠ binary for this one tool).

import type { AiToolPlugin } from '../types.js';

export const antigravityPlugin: AiToolPlugin = {
  id: 'antigravity',
  displayName: 'Antigravity',
  productName: 'Antigravity',
  tier: 'cli-agent',
  devGateKey: 'dev_tool_antigravity',
  detection: { binaries: ['agy'], paths: ['AGENTS.md'] },
  instructions: {
    relPath: 'AGENTS.md',
    frontmatter: '',
    adapterSkillsRoot: '.agents/skills',
  },
};
