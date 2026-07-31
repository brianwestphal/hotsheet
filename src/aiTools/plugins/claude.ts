// HS-9490 (docs/132) — Claude Code. The default tool and the deepest integration:
// a PERSISTENT channel session (docs/12) rather than a spawn, native permissions, and
// the canonical `CLAUDE.md` + `.claude/skills` source every adapter-family tool
// references (docs/118). docs/132 §132.6 has it migrating LAST for exactly that reason.

import type { AiToolPlugin } from '../types.js';

export const claudePlugin: AiToolPlugin = {
  id: 'claude',
  displayName: 'Claude',
  productName: 'Claude Code',
  tier: 'cli-agent',
  maturity: 'stable',
  transport: 'claude-channel',
  detection: {
    binaries: ['claude'],
    // HS-9500 — `CLAUDE.md` counts. The two predicates this spec will replace had
    // disagreed since they were written (`aiInstructionsTools.ts` checked the file,
    // `skills.ts::ensureSkillsForDir` did not), so a project with a committed
    // `CLAUDE.md` and no `.claude/` got its instruction file maintained while its
    // skills were never generated. Maintainer decision (2026-07-29): union everywhere,
    // and `skills.ts` was brought into line — so phase 2 (HS-9491) now inherits an
    // answer both call sites already agree on, rather than having to pick one.
    paths: ['.claude', 'CLAUDE.md'],
  },
  // The CANONICAL source (docs/118): every adapter-family tool's file references
  // this one, so it never becomes an adapter itself.
  instructions: {
    relPath: 'CLAUDE.md',
    frontmatter: '',
    adapterSkillsRoot: null,
  },
};
