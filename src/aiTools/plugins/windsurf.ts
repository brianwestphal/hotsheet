// HS-9490 (docs/132) — Windsurf. Tier-B, same shape as Cursor.

import type { AiToolPlugin } from '../types.js';

const SECTION_DESCRIPTION = 'Hot Sheet — ticket-driven work, testing, and requirements-doc conventions';
const WINDSURF_FRONTMATTER = `---\ntrigger: manual\ndescription: ${SECTION_DESCRIPTION}\n---\n`;

export const windsurfPlugin: AiToolPlugin = {
  id: 'windsurf',
  displayName: 'Windsurf',
  productName: 'Windsurf',
  tier: 'editor',
  maturity: 'stable',
  detection: { binaries: ['windsurf'], paths: ['.windsurf'] },
  instructions: {
    relPath: '.windsurf/rules/hotsheet-instructions.md',
    frontmatter: WINDSURF_FRONTMATTER,
    adapterSkillsRoot: null,
  },
};
