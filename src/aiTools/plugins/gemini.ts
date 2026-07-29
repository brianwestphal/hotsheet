// HS-9490 (docs/132) — Gemini CLI. Instruction + skills generation only: there is NO
// drive transport, so the play button does not work for it (docs/118 §118.4a). Verified
// against gemini-cli 0.49.0 — hierarchical `GEMINI.md`, skills at `.gemini/skills`.

import type { AiToolPlugin } from '../types.js';

export const geminiPlugin: AiToolPlugin = {
  id: 'gemini',
  displayName: 'Gemini',
  productName: 'Gemini CLI',
  tier: 'cli-agent',
  devGateKey: 'dev_tool_gemini',
  detection: { binaries: ['gemini'], paths: ['GEMINI.md', '.gemini'] },
  // Verified against gemini-cli 0.49.0: hierarchical GEMINI.md, no AGENTS.md support
  // in its bundle, skills discovered at `.gemini/skills`.
  instructions: {
    relPath: 'GEMINI.md',
    frontmatter: '',
    adapterSkillsRoot: '.gemini/skills',
  },
};
