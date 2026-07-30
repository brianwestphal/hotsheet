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
import { claudeWithChannelCommand } from '../channel-config.js';
import { codexDriveDiscoverEnabled, codexTerminalRemoteCommand } from '../codexAppServer.js';
import {
  ensureAgentsFamilySkills,
  ensureClaudeSkills,
  ensureCopilotPrompts,
  ensureCursorRules,
  ensureGeminiSkills,
  ensureOpencodeSkills,
  ensureWindsurfRules,
} from '../skills.js';
import { isExecutableOnPath } from '../utils/isExecutableOnPath.js';

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

// ── Command resolution (HS-9492, docs/132 phase 3) ──────────────────────────

/**
 * Test seams, all optional. `resolveCommand.ts` already carried these as injected
 * overrides so the branches are testable without the real binary, a live daemon, or a
 * particular `$SHELL`; they move here rather than being lost. A capability whose command
 * resolution can only be exercised with the tool installed would defeat the point.
 *
 * `codexRemote` / `codexModelB` are tool-specific in a shared bag, which is a wart. The
 * alternative — per-capability dep types threaded through one caller — costs more than
 * the wart, and `ResolveOptions` already had exactly this shape.
 */
export interface CommandResolveDeps {
  isOnPath?: (bin: string) => boolean;
  defaultShell?: () => string;
  /** Whether the Claude channel is on for this project (drives the `--dangerously-…` flag). */
  channelEnabled?: boolean;
  codexRemote?: (dataDir: string) => string | null;
  codexModelB?: boolean;
}

export interface CommandCapability {
  /** The executable to look for on PATH. Usually the tool id; `agy` for Antigravity. */
  binary: string;
  /** The launch line for a `{{aiCommand}}` terminal. Falls back to the user's shell when
   *  the binary is absent — a terminal that opens a shell is better than one that fails. */
  resolve(dataDir: string, deps: CommandResolveDeps): string;
}

function shellOf(deps: CommandResolveDeps): string {
  return (deps.defaultShell ?? systemDefaultShell)();
}

function systemDefaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}

/** The plain "run the tool's REPL if it is installed" shape — every CLI agent except
 *  Claude (its channel flag) and Codex (its model-B hosting). */
function bareBinaryCommand(binary: string) {
  return (_dataDir: string, deps: CommandResolveDeps): string =>
    (deps.isOnPath ?? isExecutableOnPath)(binary) ? binary : shellOf(deps);
}

const COMMANDS: Readonly<Record<string, CommandCapability>> = {
  claude: {
    binary: 'claude',
    // HS-8349 — the MCP server name is per-project, so the channel flag mirrors
    // `slugifyDataDir`. Without the channel enabled it is the bare binary.
    resolve: (dataDir, deps) => {
      if (!(deps.isOnPath ?? isExecutableOnPath)('claude')) return shellOf(deps);
      return deps.channelEnabled === true ? claudeWithChannelCommand(dataDir) : 'claude';
    },
  },
  codex: {
    binary: 'codex',
    // HS-9429 (docs/129 model-B, default ON) — launch the terminal DAEMON-HOSTED
    // (`codex --remote … -C <projectDir>`) so it owns its own live thread and the drive
    // discovers and drives it in place. Falls through to plain `codex` when the daemon
    // isn't up, or when model-B is off (the drive then keeps its own headless thread —
    // HS-9430 deleted the model-A attach that used to chase it).
    resolve: (dataDir, deps) => {
      if (!(deps.isOnPath ?? isExecutableOnPath)('codex')) return shellOf(deps);
      const modelB = deps.codexModelB ?? codexDriveDiscoverEnabled();
      if (modelB) {
        const remote = (deps.codexRemote ?? codexTerminalRemoteCommand)(dataDir);
        if (remote !== null) return remote;
      }
      return 'codex';
    },
  },
  // HS-9319 — Antigravity is the one tool whose binary differs from its id.
  antigravity: { binary: 'agy', resolve: bareBinaryCommand('agy') },
  gemini: { binary: 'gemini', resolve: bareBinaryCommand('gemini') },
  opencode: { binary: 'opencode', resolve: bareBinaryCommand('opencode') },
  goose: { binary: 'goose', resolve: bareBinaryCommand('goose') },
  // cursor / copilot / windsurf: absent. Tier-B editor tools are not terminal agents
  // (docs/113 §113.2), so a `{{aiCommand}}` terminal for them falls back to Claude —
  // see `commandCapabilityOrDefault`.
};

/** The command capability for a tool id, or null when it is not a terminal agent. */
export function commandCapabilityFor(aiTool: string): CommandCapability | null {
  return COMMANDS[aiTool.trim().toLowerCase()] ?? null;
}

/**
 * What a `{{aiCommand}}` terminal should launch for `aiTool`.
 *
 * The fallback to Claude covers `auto`, unset, an unrecognized id, and the Tier-B editor
 * tools — all of which used to reach the same `pickClaudeCommand` through
 * `!CLI_AGENTS.has(tool)`. Expressing it as "no command capability → the default one"
 * makes Claude the DEFAULT rather than a special case, which is the same move docs/132
 * §132.6 asks for elsewhere.
 */
export function commandCapabilityOrDefault(aiTool: string): CommandCapability {
  return commandCapabilityFor(aiTool) ?? COMMANDS.claude;
}

/** Ids that declare a command capability (for the conformance suite). */
export function commandCapabilityIds(): string[] {
  return Object.keys(COMMANDS);
}
