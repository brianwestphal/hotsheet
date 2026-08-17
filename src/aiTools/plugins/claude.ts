// HS-9490 (docs/132) — Claude Code. The default tool and the deepest integration:
// a PERSISTENT channel session (docs/12) rather than a spawn, native permissions, and
// the canonical `CLAUDE.md` + `.claude/skills` source every adapter-family tool
// references (docs/118). docs/132 §132.6 has it migrating LAST for exactly that reason.

// `channelSlug.js`, NOT `channel-config.js` — the latter imports `fs` / `path` and the
// whole server graph, and this module is client-reachable (HS-9615).
import { claudeWithChannelCommand } from '../../channelSlug.js';
import { workerIdEnvPrefix, workerIdPromptLine } from '../../workerIdentity.js';
import type { AiToolPlugin } from '../types.js';

export const claudePlugin: AiToolPlugin = {
  id: 'claude',
  displayName: 'Claude',
  productName: 'Claude Code',
  // HS-9602 — Claude Code's OTLP namespace (`claude_code.cost.usage`, …).
  telemetryMetricPrefix: 'claude_code.',
  // HS-9604 — Claude reports tokens on ONE metric with a `type` attribute
  // rather than a metric per counter, so the name-keyed map cannot express it;
  // `otelRollupIngest.ts::tokenColumnFor` handles the attribute split. Declared
  // here anyway so the metric is recognized as a routed token counter, with the
  // per-datapoint column coming from `type`.
  telemetryTokenMetrics: { 'claude_code.token.usage': 'by-type-attribute' },
  // HS-9601 — the worker launch line, moved here out of `workers/launchWorker.ts`
  // per §132's rule that tool-specific code lives in the tool's own module.
  //
  // HS-9036 — the development-channel flag is the load-bearing part: it routes
  // the worker's PERMISSION PROMPTS to its channel server so they surface in the
  // Hot Sheet UI. Pre-fix the worker launched as a bare `claude "/hotsheet-worker"`
  // — MCP tools worked, but Claude never sent `permission_request`, so every
  // worker permission fell back to its terminal and the worker blocked forever.
  worker: {
    // HS-9676 — inject the canonical lease id: `HOTSHEET_WORKER_ID=<id>` env +
    // a verbatim line in the prompt, so the agent doesn't derive its id from the
    // generated worktree folder name (`hotsheet-worker-1-12`) and claim under the
    // wrong identity.
    launchCommand: (ownerDataDir: string, workerId?: string) =>
      `${workerIdEnvPrefix(workerId)}${claudeWithChannelCommand(ownerDataDir)} "/hotsheet-worker${workerIdPromptLine(workerId)}"`,
    binary: 'claude',
  },
  // HS-9605 — `claude_code.cost.usage`; the whole cost UI was built on it.
  telemetryReportsCost: true,
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
