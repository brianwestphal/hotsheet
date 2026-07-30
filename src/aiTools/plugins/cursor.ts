// HS-9490 (docs/132) — Cursor. Tier-B (docs/113 §113.2): Hot Sheet supplies rules and
// instructions; it is not terminal-driven, so it has no command, drive or permissions.

import type { AiToolPlugin } from '../types.js';

const SECTION_DESCRIPTION = 'Hot Sheet — ticket-driven work, testing, and requirements-doc conventions';
const CURSOR_FRONTMATTER = `---\ndescription: ${SECTION_DESCRIPTION}\nalwaysApply: false\n---\n`;

export const cursorPlugin: AiToolPlugin = {
  id: 'cursor',
  displayName: 'Cursor',
  productName: 'Cursor',
  tier: 'editor',
  detection: { binaries: ['cursor'], paths: ['.cursor'] },
  instructions: {
    relPath: '.cursor/rules/hotsheet-instructions.mdc',
    frontmatter: CURSOR_FRONTMATTER,
    adapterSkillsRoot: null,
  },
};
