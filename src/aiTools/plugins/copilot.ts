// HS-9490 (docs/132) — GitHub Copilot. Tier-B. Detection is path-only: there is no
// `copilot` binary to probe, so presence is inferred from the files it reads.

import type { AiToolPlugin } from '../types.js';

export const copilotPlugin: AiToolPlugin = {
  id: 'copilot',
  displayName: 'Copilot',
  productName: 'GitHub Copilot',
  tier: 'editor',
  devGateKey: null,
  detection: { binaries: [], paths: ['.github/copilot-instructions.md', '.github/prompts'] },
  instructions: {
    relPath: '.github/copilot-instructions.md',
    frontmatter: '',
    adapterSkillsRoot: null,
  },
};
