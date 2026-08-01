import { dirname, isAbsolute, resolve as resolvePath } from 'path';

import { commandCapabilityOrDefault } from '../aiTools/serverCapabilities.js';
import { readFileSettings } from '../file-settings.js';
import { readGlobalConfig } from '../global-config.js';
import { isExecutableOnPath } from '../utils/isExecutableOnPath.js';
import { DEFAULT_TERMINAL_ID, findTerminalConfig, type TerminalConfig } from './config.js';
// HS-9492 — moved to `channel-config.ts` (beside the slug it mirrors) so the Claude
// command capability and `workers/launchWorker.ts` can both use it without a cycle.
// Re-exported so existing importers of this module keep working.
export { claudeWithChannelCommand } from '../channel-config.js';

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

/** HS-9333 — true when a command template contains an AI-tool placeholder that
 *  `resolveTerminalCommand` will expand: either the legacy `{{claudeCommand}}` or the
 *  `ai_tool`-aware `{{aiCommand}}` alias. Callers that special-case "does this need
 *  server-side resolution?" (e.g. the ad-hoc runCommand path) must check BOTH tokens —
 *  before HS-9333 the ad-hoc path only checked `{{claudeCommand}}`, so an ad-hoc
 *  `{{aiCommand}}` was launched verbatim. */
export function commandUsesAiToken(command: string): boolean {
  return command.includes(CLAUDE_TOKEN) || command.includes(AI_TOKEN);
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
  /** HS-9429 — override for the model-B daemon-HOSTED command (`codex --remote`).
   *  Injected in tests. Defaults to `codexTerminalRemoteCommand` (null → plain `codex`). */
  codexRemoteOverride?: (dataDir: string) => string | null;
  /** HS-9429 — force the model-B branch on/off (default: `codexDriveDiscoverEnabled`).
   *  HS-9513 removed the `codexModelBTerminals` setting this used to also read, so the
   *  only remaining override is the `HOTSHEET_CODEX_DISCOVER_THREAD` env var. Injected
   *  in tests so they don't touch process.env. */
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
 *
 * HS-9492 (docs/132 phase 3) — the per-tool knowledge moved to the plugins'
 * `command` capability. This is now the plumbing: read the setting, hand the
 * capability the injected test seams, and let it answer. `auto`, unset, an unknown
 * id and the Tier-B editor tools all resolve through the Claude capability by
 * default (`commandCapabilityOrDefault`), which is what the old
 * `!CLI_AGENTS.has(tool)` branch did — Claude as the DEFAULT rather than a carve-out.
 *
 * This is also what removes `codexAppServer` from this module: the model-B branch is
 * one of the five generic-module imports docs/132 §132.1.1 is about, and terminal
 * command resolution has no business knowing that Codex has a daemon.
 */
function pickAiCommand(options: ResolveOptions): string {
  const tool = (options.aiToolOverride ?? readAiTool(options.dataDir)).trim().toLowerCase();
  return commandCapabilityOrDefault(tool).resolve(options.dataDir, {
    // `isAiToolOnPath` and `isClaudeOnPath` were two seams for the same question,
    // split only because the old code had two branches. Either satisfies the one
    // capability call now; both are kept so existing callers/tests are unaffected.
    isOnPath: options.isAiToolOnPath ?? (options.isClaudeOnPath !== undefined
      ? (bin: string) => (bin === CLAUDE_BASE ? options.isClaudeOnPath!() : isExecutableOnPath(bin))
      : undefined),
    defaultShell: options.defaultShellOverride,
    channelEnabled: options.channelEnabledOverride ?? isChannelEnabled(options.dataDir),
    codexRemote: options.codexRemoteOverride,
    codexModelB: options.codexModelB,
  });
}

/** Read the project's `ai_tool` setting (default `auto` when absent). */
function readAiTool(dataDir: string): string {
  const value = readFileSettings(dataDir).ai_tool;
  return typeof value === 'string' && value.trim() !== '' ? value : 'auto';
}

function isChannelEnabled(dataDir: string): boolean {
  const global = readGlobalConfig().channelEnabled;
  if (typeof global === 'boolean') return global;
  const perProject = readFileSettings(dataDir).channel_enabled;
  return perProject === true || perProject === 'true';
}

// HS-8491 — `isExecutableOnPath` moved to `src/utils/isExecutableOnPath.ts`
// so `src/skills.ts` and `src/projects.ts` can reuse it without pulling
// in this module's terminal-launch surface. Re-exported here so callers
// that imported the private helper indirectly through path-traversal
// imports keep compiling.

// HS-9492 — the default-shell fallback moved into `aiTools/serverCapabilities.ts`
// alongside the command capabilities that use it. This module no longer decides what a
// terminal launches; it only substitutes the token.
