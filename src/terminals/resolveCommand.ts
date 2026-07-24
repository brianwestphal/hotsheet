import { dirname, isAbsolute, resolve as resolvePath } from 'path';

import { slugifyDataDir } from '../channel-config.js';
import { codexDriveDiscoverEnabled, codexTerminalAttachCommand, codexTerminalRemoteCommand } from '../codexAppServer.js';
import { readFileSettings } from '../file-settings.js';
import { readGlobalConfig } from '../global-config.js';
import { isExecutableOnPath } from '../utils/isExecutableOnPath.js';
import { DEFAULT_TERMINAL_ID, findTerminalConfig, type TerminalConfig } from './config.js';

export interface ResolvedCommand {
  command: string;
  cwd: string;
}

const CLAUDE_TOKEN = '{{claudeCommand}}';
// HS-8009 — alias for `{{claudeCommand}}`; both resolve via the `ai_tool`-aware
// `pickAiCommand`. The `claudeCommand` name stays for back-compat.
const AI_TOKEN = '{{aiCommand}}';
const PROJECT_DIR_TOKEN = '{{projectDir}}';
const CLAUDE_BASE = 'claude';

// HS-8009 (docs/113 §113.3) — the non-Claude CLI agents whose binary a terminal
// launches when `ai_tool` selects them. For most the binary name == the tool id;
// `AGENT_BINARIES` overrides that where they differ. The channel/play loop for
// these is the drive work (HS-9310 spike proved Antigravity rides MCP like
// Claude); until that lands the terminal just runs the tool's REPL.
const CLI_AGENTS: ReadonlySet<string> = new Set(['codex', 'gemini', 'opencode', 'goose', 'antigravity']);

// HS-9319 — tool id → executable name, for agents whose binary differs from the
// `ai_tool` id. Antigravity's CLI is `agy`. Others fall through to id == binary.
const AGENT_BINARIES: Readonly<Record<string, string>> = { antigravity: 'agy' };

/** HS-9333 — true when a command template contains an AI-tool placeholder that
 *  `resolveTerminalCommand` will expand: either the legacy `{{claudeCommand}}` or the
 *  `ai_tool`-aware `{{aiCommand}}` alias. Callers that special-case "does this need
 *  server-side resolution?" (e.g. the ad-hoc runCommand path) must check BOTH tokens —
 *  before HS-9333 the ad-hoc path only checked `{{claudeCommand}}`, so an ad-hoc
 *  `{{aiCommand}}` was launched verbatim. */
export function commandUsesAiToken(command: string): boolean {
  return command.includes(CLAUDE_TOKEN) || command.includes(AI_TOKEN);
}

/** HS-8349 — build the development-channel command for a given project.
 *  The MCP server name is now per-project (`hotsheet-channel-<slug>`), so
 *  this needs to mirror the slug from `slugifyDataDir(dataDir)`. */
export function claudeWithChannelCommand(dataDir: string): string {
  return `claude --dangerously-load-development-channels server:hotsheet-channel-${slugifyDataDir(dataDir)}`;
}

/**
 * Pure: resolve a user-entered terminal `cwd` string against the project
 * root. HS-7991. Three rules in priority order:
 *
 * 1. **Empty / unset** → project root. Matches the placeholder hint
 *    "Leave blank to use the project root."
 * 2. **`{{projectDir}}` token** → substitute the project root inline
 *    before path resolution, so `{{projectDir}}/scratch` works exactly
 *    like a hand-typed absolute path.
 * 3. **Absolute** → used verbatim (`/abs`, Windows `C:\...`).
 * 4. **Relative** (after token expansion) → resolved against the project
 *    root via `path.resolve`. Lets the user type `./sub-folder` or just
 *    `sub-folder` and have it land in the project's subdirectory.
 *
 * `~` is NOT expanded here — most shells handle that on their own at
 * launch time, and substituting `~` would cross the OS user-home boundary
 * in a way that's surprising for a per-project setting. Use
 * `{{projectDir}}/...` or an absolute path for explicit cross-tree paths.
 */
export function resolveTerminalCwd(cwdSetting: string | undefined, projectDir: string): string {
  const trimmed = (cwdSetting ?? '').trim();
  if (trimmed === '') return projectDir;
  const expanded = trimmed.split(PROJECT_DIR_TOKEN).join(projectDir);
  if (isAbsolute(expanded)) return expanded;
  return resolvePath(projectDir, expanded);
}

export interface ResolveOptions {
  /** Path to the project's data directory (e.g. /path/to/project/.hotsheet). */
  dataDir: string;
  /**
   * Which configured terminal to resolve. Defaults to `'default'`. Ignored
   * when `configOverride` is supplied (e.g. ad-hoc dynamic terminals).
   */
  terminalId?: string;
  /** Direct TerminalConfig override — wins over settings lookup. Used for dynamic (unconfigured) terminals. */
  configOverride?: TerminalConfig;
  /** Override for claude-on-PATH detection. Injected in tests. */
  isClaudeOnPath?: () => boolean;
  /** Override for channelEnabled. Injected in tests. */
  channelEnabledOverride?: boolean;
  /** Override for default shell resolution. Injected in tests. */
  defaultShellOverride?: () => string;
  /** Override for the `ai_tool` setting. Injected in tests. */
  aiToolOverride?: string;
  /** Override for CLI-agent-on-PATH detection. Injected in tests. */
  isAiToolOnPath?: (bin: string) => boolean;
  /** HS-9394 — override for the codex daemon-attach command resolution. Injected in
   *  tests. Defaults to `codexTerminalAttachCommand` (null → plain `codex`). */
  codexAttachOverride?: (dataDir: string) => string | null;
  /** HS-9429 — override for the model-B daemon-HOSTED command (`codex --remote`).
   *  Injected in tests. Defaults to `codexTerminalRemoteCommand`. */
  codexRemoteOverride?: (dataDir: string) => string | null;
  /** HS-9429 — force the model-B branch on/off (default: the `codexDriveDiscoverEnabled`
   *  env gate). Injected in tests so they don't touch process.env. */
  codexModelB?: boolean;
}

/**
 * Resolve the terminal command + working directory for a project.
 * Reads the configured terminal entry from `.hotsheet/settings.json` and
 * substitutes `{{claudeCommand}}` per docs/22-terminal.md §22.5.
 */
export function resolveTerminalCommand(options: ResolveOptions): ResolvedCommand {
  const config = options.configOverride ?? lookupConfig(options);
  // HS-9334 — default to the `ai_tool`-aware `{{aiCommand}}` when no command is set;
  // both tokens resolve via `pickAiCommand`, so this is identical for claude/auto and
  // launches the selected agent otherwise.
  const template = config.command !== '' ? config.command : AI_TOKEN;
  const projectDir = dirname(options.dataDir);
  const cwd = resolveTerminalCwd(config.cwd, projectDir);

  let command = template;
  if (command.includes(CLAUDE_TOKEN) || command.includes(AI_TOKEN)) {
    const resolved = pickAiCommand(options);
    command = command.split(CLAUDE_TOKEN).join(resolved).split(AI_TOKEN).join(resolved);
  }

  return { command, cwd };
}

function lookupConfig(options: ResolveOptions): TerminalConfig {
  const id = options.terminalId ?? DEFAULT_TERMINAL_ID;
  const found = findTerminalConfig(options.dataDir, id);
  if (found) return found;
  // Unknown id — fall back to the default AI-tool template so launch still works.
  return { id, command: AI_TOKEN };
}

/**
 * HS-8009 — resolve the terminal command for the project's `ai_tool` (docs/113).
 * `auto`/`claude`/unset (and the editor-only tools, which aren't terminal agents)
 * keep today's Claude behavior via `pickClaudeCommand`. An explicit non-Claude CLI
 * agent launches that tool's bare binary when present, else the default shell.
 */
function pickAiCommand(options: ResolveOptions): string {
  const tool = (options.aiToolOverride ?? readAiTool(options.dataDir)).trim().toLowerCase();
  if (!CLI_AGENTS.has(tool)) return pickClaudeCommand(options); // auto / claude / editor tools
  const bin = AGENT_BINARIES[tool] ?? tool; // e.g. antigravity → agy; else id == binary
  const onPath = options.isAiToolOnPath ?? isExecutableOnPath;
  if (!onPath(bin)) return (options.defaultShellOverride ?? defaultShell)();
  if (tool === 'codex') {
    // HS-9429 (docs/129 model-B) — when the discovery gate is on, launch the
    // terminal DAEMON-HOSTED (`codex --remote … -C <projectDir>`) so it owns its own
    // live thread and the drive discovers + drives it in place. Else (model-A, the
    // default) fall back to HS-9394's attach that resumes the DRIVE's thread. Both
    // fall through to plain `codex` when their precondition (daemon up / rollout on
    // disk) isn't met.
    const modelB = options.codexModelB ?? codexDriveDiscoverEnabled();
    if (modelB) {
      const remote = (options.codexRemoteOverride ?? codexTerminalRemoteCommand)(options.dataDir);
      if (remote !== null) return remote;
    } else {
      const attach = (options.codexAttachOverride ?? codexTerminalAttachCommand)(options.dataDir);
      if (attach !== null) return attach;
    }
  }
  return bin;
}

/** Read the project's `ai_tool` setting (default `auto` when absent). */
function readAiTool(dataDir: string): string {
  const value = readFileSettings(dataDir).ai_tool;
  return typeof value === 'string' && value.trim() !== '' ? value : 'auto';
}

function pickClaudeCommand(options: ResolveOptions): string {
  const claudePresent = (options.isClaudeOnPath ?? defaultClaudeDetector)();
  const channelEnabled = options.channelEnabledOverride ?? isChannelEnabled(options.dataDir);
  if (claudePresent && channelEnabled) return claudeWithChannelCommand(options.dataDir);
  if (claudePresent) return CLAUDE_BASE;
  return (options.defaultShellOverride ?? defaultShell)();
}

function isChannelEnabled(dataDir: string): boolean {
  const global = readGlobalConfig().channelEnabled;
  if (typeof global === 'boolean') return global;
  const perProject = readFileSettings(dataDir).channel_enabled;
  return perProject === true || perProject === 'true';
}

function defaultClaudeDetector(): boolean {
  return isExecutableOnPath('claude');
}

// HS-8491 — `isExecutableOnPath` moved to `src/utils/isExecutableOnPath.ts`
// so `src/skills.ts` and `src/projects.ts` can reuse it without pulling
// in this module's terminal-launch surface. Re-exported here so callers
// that imported the private helper indirectly through path-traversal
// imports keep compiling.

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}
