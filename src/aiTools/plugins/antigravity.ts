// HS-9490 (docs/132) — Antigravity. The first MCP+hooks agent (docs/115); its binary is
// `agy`, which is why `AGENT_BINARIES` exists at all (id ≠ binary for this one tool).

import type { AiToolPlugin } from '../types.js';

export const antigravityPlugin: AiToolPlugin = {
  id: 'antigravity',
  displayName: 'Antigravity',
  productName: 'Antigravity',
  tier: 'cli-agent',
  transport: 'mcp-hooks',
  detection: { binaries: ['agy'], paths: ['AGENTS.md'] },
  instructions: {
    relPath: 'AGENTS.md',
    frontmatter: '',
    adapterSkillsRoot: '.agents/skills',
  },
  // HS-9328 / HS-9497 — default OFF: agy runs the worklist unattended unless the user
  // opts in. Note this is the OPPOSITE polarity to codex's identically-named setting.
  preferences: [{
    key: 'antigravity_interactive_permissions',
    label: 'Interactive permission prompts (Antigravity)',
    type: 'boolean',
    default: false,
    description: 'When on, the play button runs `agy` **without** `--dangerously-skip-permissions` and installs a `.agents/hooks.json` hook that routes each tool call through Hot Sheet\'s permission popup (Allow / Deny). Off = agy runs the worklist unattended (auto-approve). Requires a trusted agy workspace.',
  }],
};
