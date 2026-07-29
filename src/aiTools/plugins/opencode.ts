// HS-9490 (docs/132) — OpenCode, the lead ACP agent (docs/114). Reads `.claude/skills`
// directly, so its skills generation is a canonical REFRESH rather than an adapter tree
// (docs/118 §118.4a) — a phase-2 concern, noted here so the difference isn't lost.

import type { AiToolPlugin } from '../types.js';

export const opencodePlugin: AiToolPlugin = {
  id: 'opencode',
  displayName: 'OpenCode',
  productName: 'OpenCode',
  tier: 'cli-agent',
  devGateKey: 'dev_tool_opencode',
  detection: { binaries: ['opencode'], paths: ['AGENTS.md'] },
};
