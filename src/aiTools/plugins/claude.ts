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
  devGateKey: null, // the default tool — never gated
  detection: {
    binaries: ['claude'],
    // NOTE (HS-9500): `CLAUDE.md` is the UNION of two predicates that disagree today —
    // `aiInstructionsTools.ts` checks it, `skills.ts::ensureSkillsForDir` does not.
    // Nothing consumes this spec yet (phase 1 is identity only), so recording the
    // superset changes no behavior; phase 2 has to make the choice deliberately.
    paths: ['.claude', 'CLAUDE.md'],
  },
};
