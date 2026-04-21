import { readFileSettings } from '../file-settings.js';

/**
 * Configuration for a single terminal within a project. Defaults are stored in
 * `.hotsheet/settings.json` under the `terminals` key (array, ordered).
 *
 * `id` is a stable slug used both as the in-memory registry key and the client
 * tab id. For settings-backed defaults it is allocated on first save and never
 * re-used even if the user deletes and re-adds a terminal with the same name.
 * Dynamic (ad-hoc) terminals created via POST /api/terminal/create use a
 * runtime-generated id prefixed with `dyn-`.
 */
export interface TerminalConfig {
  id: string;
  /** Tab label. When omitted, `default-<index>` or the command's first word is used. */
  name?: string;
  /** Command template. May contain `{{claudeCommand}}` (see §22.5). */
  command: string;
  /** Working directory override. Blank/unset = project root. */
  cwd?: string;
  /** When true, PTY is spawned on first WebSocket attach (today's behavior).
   *  When false, the server spawns eagerly on first project load. Default: true. */
  lazy?: boolean;
}

export const DEFAULT_TERMINAL_ID = 'default';
const CLAUDE_TEMPLATE = '{{claudeCommand}}';

/**
 * Read the configured default terminals for a project, applying migration from
 * the legacy single-terminal `terminal_command` / `terminal_cwd` settings when
 * a modern `terminals` array is not present.
 *
 * Always returns at least one entry (the implicit `default`).
 */
export function listTerminalConfigs(dataDir: string): TerminalConfig[] {
  const settings = readFileSettings(dataDir);
  const rawList = settings.terminals;
  if (Array.isArray(rawList) && rawList.length > 0) {
    return rawList
      .map((raw, idx) => normalizeConfig(raw, idx))
      .filter((c): c is TerminalConfig => c !== null);
  }

  // Legacy fallback: build a single default entry from terminal_command/terminal_cwd.
  const legacyCommand = typeof settings.terminal_command === 'string' && settings.terminal_command !== ''
    ? settings.terminal_command
    : CLAUDE_TEMPLATE;
  const legacyCwd = typeof settings.terminal_cwd === 'string' ? settings.terminal_cwd : '';
  const entry: TerminalConfig = {
    id: DEFAULT_TERMINAL_ID,
    name: 'Terminal',
    command: legacyCommand,
  };
  if (legacyCwd !== '') entry.cwd = legacyCwd;
  return [entry];
}

/** Look up a single terminal config by id, or null if not found. */
export function findTerminalConfig(dataDir: string, terminalId: string): TerminalConfig | null {
  for (const entry of listTerminalConfigs(dataDir)) {
    if (entry.id === terminalId) return entry;
  }
  return null;
}

function normalizeConfig(input: unknown, index: number): TerminalConfig | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Partial<TerminalConfig>;
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : `default-${index}`;
  const command = typeof raw.command === 'string' && raw.command !== '' ? raw.command : CLAUDE_TEMPLATE;
  const out: TerminalConfig = { id, command };
  if (typeof raw.name === 'string' && raw.name !== '') out.name = raw.name;
  if (typeof raw.cwd === 'string' && raw.cwd !== '') out.cwd = raw.cwd;
  if (typeof raw.lazy === 'boolean') out.lazy = raw.lazy;
  return out;
}
