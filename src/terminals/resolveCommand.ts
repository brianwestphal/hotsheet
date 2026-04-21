import { existsSync } from 'fs';
import { delimiter, dirname, join } from 'path';

import { readFileSettings } from '../file-settings.js';
import { readGlobalConfig } from '../global-config.js';
import { DEFAULT_TERMINAL_ID, findTerminalConfig, type TerminalConfig } from './config.js';

export interface ResolvedCommand {
  command: string;
  cwd: string;
}

const CLAUDE_TOKEN = '{{claudeCommand}}';
const CLAUDE_WITH_CHANNEL = 'claude --dangerously-load-development-channels server:hotsheet-channel';
const CLAUDE_BASE = 'claude';

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
}

/**
 * Resolve the terminal command + working directory for a project.
 * Reads the configured terminal entry from `.hotsheet/settings.json` and
 * substitutes `{{claudeCommand}}` per docs/22-terminal.md §22.5.
 */
export function resolveTerminalCommand(options: ResolveOptions): ResolvedCommand {
  const config = options.configOverride ?? lookupConfig(options);
  const template = config.command !== '' ? config.command : CLAUDE_TOKEN;
  const cwdSetting = typeof config.cwd === 'string' ? config.cwd.trim() : '';
  const cwd = cwdSetting !== '' ? cwdSetting : dirname(options.dataDir);

  const command = template.includes(CLAUDE_TOKEN)
    ? template.split(CLAUDE_TOKEN).join(pickClaudeCommand(options))
    : template;

  return { command, cwd };
}

function lookupConfig(options: ResolveOptions): TerminalConfig {
  const id = options.terminalId ?? DEFAULT_TERMINAL_ID;
  const found = findTerminalConfig(options.dataDir, id);
  if (found) return found;
  // Unknown id — fall back to the first configured entry so launch still works.
  return { id, command: CLAUDE_TOKEN };
}

function pickClaudeCommand(options: ResolveOptions): string {
  const claudePresent = (options.isClaudeOnPath ?? defaultClaudeDetector)();
  const channelEnabled = options.channelEnabledOverride ?? isChannelEnabled(options.dataDir);
  if (claudePresent && channelEnabled) return CLAUDE_WITH_CHANNEL;
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

function isExecutableOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === '') continue;
    for (const ext of exts) {
      if (existsSync(join(dir, name + ext))) return true;
    }
  }
  return false;
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/sh';
}
