/**
 * HS-9503 (docs/132 §132.11.1) — the SERVER-ONLY half of the AI-tool plugin interface.
 *
 * Phase 1 established that `types.ts`, `registry.ts` and `plugins/**` import no node
 * builtins: `agentDisplayName` consumes the registry and is re-exported into the client
 * bundle, so anything the plugins import becomes client code. That splits capabilities
 * in two:
 *
 *  - **Declarative** — plain data, lives on the plugin. `instructions` (HS-9491).
 *  - **Behavioral** — needs the host (filesystem, processes). Lives HERE, keyed by
 *    plugin id, imported only by server code.
 *
 * This module is the pattern for the rest of the migration. Command resolution shells
 * out and the drive spawns processes, so phases 3–5 land here too — `serverCapabilities`
 * rather than `skillsCapabilities` for that reason. One file, one lookup, capabilities
 * added as they move.
 *
 * ## Every `ensure` is a wrapper, never a bare reference
 *
 * `ensure: (root, dataDir) => ensureClaudeSkills(root, dataDir)`, not
 * `ensure: ensureClaudeSkills`. The bare form reads the imported binding while this
 * object literal is being EVALUATED — at module scope — and that is the HS-9498 trap
 * again one level up: `routes/api.test.ts` partially mocks `skills.js`, so the moment
 * this module joined its dependency graph the whole file died at import with
 * "No 'ensureClaudeSkills' export is defined on the mock".
 *
 * Written the first time with bare references, caught immediately by that suite. The
 * wrapper defers the lookup to call time, where a missing export surfaces in the caller
 * instead of during module evaluation. Same lesson as HS-9498: resolve late.
 *
 * ## The import cycle is deliberate
 *
 * `skills.ts` imports `skillsCapabilityFor` (to iterate) and this module imports its
 * generators — a genuine cycle. It resolves because the generators are hoisted
 * `function` declarations and the wrappers above defer the read to call time. Moving
 * every generator out of `skills.ts` would separate them from the shared machinery they
 * use (`updateFile`, the version header, `ensureAdapterSkillTree`) for no gain.
 */
import { canonicalClaudeSourceExists } from '../aiInstructions.js';
import {
  ensureAgentsFamilySkills,
  ensureClaudeSkills,
  ensureCopilotPrompts,
  ensureCursorRules,
  ensureGeminiSkills,
  ensureOpencodeSkills,
  ensureWindsurfRules,
} from '../skills.js';

export interface SkillsCapability {
  /**
   * The artifact whose presence + version header answer "is this tool prepared?"
   * (docs/119). `projectRoot` is needed because OpenCode's target depends on whether
   * the canonical Claude source exists.
   *
   * MUST name a file `ensure()` actually writes. A mismatch is the docs/119 failure
   * where tool-prep reports "needed" forever because it checks a path nothing
   * produces — pinned by the conformance suite.
   */
  mainArtifactRelPath(projectRoot?: string): string;
  /** Generate/refresh. Idempotent; returns whether anything was written. */
  ensure(projectRoot: string, dataDir: string): boolean;
  /** Label `ensureSkillsForDir` reports for this tool. */
  platformLabel: string;
}

/** Paths are declared POSIX-style and joined by the caller. */
const CLAUDE_SKILL = '.claude/skills/hotsheet/SKILL.md';
const AGENTS_SKILL = '.agents/skills/hotsheet/SKILL.md';

const CAPABILITIES: Readonly<Record<string, SkillsCapability>> = {
  claude: {
    platformLabel: 'Claude Code',
    mainArtifactRelPath: () => CLAUDE_SKILL,
    ensure: (root: string, dataDir: string) => ensureClaudeSkills(root, dataDir),
  },
  // docs/118 — Codex and Antigravity share `.agents/skills` (the video-studio model):
  // thin adapters when the canonical Claude source exists, full bodies otherwise. The
  // double-write is idempotent, so both declaring it needs no special-casing.
  codex: {
    platformLabel: 'Codex',
    mainArtifactRelPath: () => AGENTS_SKILL,
    ensure: (root: string, dataDir: string) => ensureAgentsFamilySkills(root, dataDir),
  },
  antigravity: {
    platformLabel: 'Antigravity',
    mainArtifactRelPath: () => AGENTS_SKILL,
    ensure: (root: string, dataDir: string) => ensureAgentsFamilySkills(root, dataDir),
  },
  gemini: {
    platformLabel: 'Gemini',
    mainArtifactRelPath: () => '.gemini/skills/hotsheet/SKILL.md',
    ensure: (root: string, dataDir: string) => ensureGeminiSkills(root, dataDir),
  },
  // docs/118 §118.4a — OpenCode reads `.claude/skills` DIRECTLY, so with a canonical
  // source its generator only keeps THAT fresh (adapters would duplicate names in its
  // skill list); without one it seeds full bodies into `.agents/skills`. Which is why
  // this is the one `mainArtifactRelPath` that reads the filesystem.
  opencode: {
    platformLabel: 'OpenCode',
    // `projectRoot === undefined` must NOT fall through to a filesystem probe:
    // `canonicalClaudeSourceExists('')` resolves against the CWD, so a caller asking for
    // the static answer would get one derived from whatever project the SERVER was
    // started in. Callers that omit the root get the no-canonical-source answer, which
    // is what the pre-HS-9503 switch returned.
    mainArtifactRelPath: (projectRoot?: string) =>
      projectRoot !== undefined && projectRoot !== '' && canonicalClaudeSourceExists(projectRoot)
        ? CLAUDE_SKILL
        : AGENTS_SKILL,
    ensure: (root: string, dataDir: string) => ensureOpencodeSkills(root, dataDir),
  },
  cursor: {
    platformLabel: 'Cursor',
    mainArtifactRelPath: () => '.cursor/rules/hotsheet.mdc',
    ensure: (root: string) => ensureCursorRules(root),
  },
  copilot: {
    platformLabel: 'GitHub Copilot',
    mainArtifactRelPath: () => '.github/prompts/hotsheet.prompt.md',
    ensure: (root: string) => ensureCopilotPrompts(root),
  },
  windsurf: {
    platformLabel: 'Windsurf',
    mainArtifactRelPath: () => '.windsurf/rules/hotsheet.md',
    ensure: (root: string) => ensureWindsurfRules(root),
  },
  // goose: absent. Its conventions are unverified (not installed) — HS-9347,
  // docs/118 §118.6. Absence means "no skill format", which is the honest answer;
  // inventing one would be a guess, and every entry above is pinned by a live check.
};

/** The skills capability for a plugin id, or null when the tool has no skill format. */
export function skillsCapabilityFor(aiTool: string): SkillsCapability | null {
  return CAPABILITIES[aiTool.trim().toLowerCase()] ?? null;
}

/** Ids that declare a skills capability (for the conformance suite). */
export function skillsCapabilityIds(): string[] {
  return Object.keys(CAPABILITIES);
}
