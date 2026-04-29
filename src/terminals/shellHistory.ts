/**
 * HS-7964 / HS-7965 — per-(project, terminal-id) shell history scoping.
 *
 * Generates per-terminal init files + injects the appropriate env vars (and
 * for bash, rewrites the spawn command) so each Hot Sheet terminal tab gets
 * its own up-arrow history pool. Pre-fix every shell across every project
 * shared the user's global `~/.bash_history` / `~/.zsh_history` / fish
 * default-session history file, which made up-arrow recall mix commands
 * across unrelated tabs and projects.
 *
 * The simple `HISTFILE=...` env-var fix doesn't work standalone — verified
 * empirically against macOS-default zsh, where `/etc/zshrc_Apple_Terminal`
 * unconditionally rewrites `HISTFILE` to a per-session file AFTER our env
 * injection but BEFORE the user's interactive prompt. The fix here uses
 * each shell's init-file override mechanism so the user's normal rc loads
 * FIRST and our HISTFILE override runs AFTER:
 *
 * - **bash** — spawn with `--rcfile <dir>/.bashrc`. Generated `.bashrc`
 *   sources `~/.bashrc` (defensive `[ -f ]` guard) then exports the
 *   per-terminal HISTFILE + `history -r` to load.
 * - **zsh** — `ZDOTDIR=<dir>` env redirects rc-file lookup. Generated
 *   `<dir>/.zshrc` sources `$HOME/.zshrc` (guarded) + exports HISTFILE +
 *   `fc -p $HISTFILE`. We also generate `.zshenv` and `.zprofile` shims so
 *   the user's full rc-load chain is preserved.
 * - **fish** — `XDG_CONFIG_HOME=<dir>` redirects fish's config search.
 *   Generated `<dir>/fish/config.fish` sources `~/.config/fish/config.fish`
 *   (guarded) + `set -x fish_history hotsheet_<projectHash>_<terminalId>`
 *   (fish indexes by session NAME, not file path).
 *
 * Other shells (sh, dash, ksh, pwsh, cmd) are skipped — they either lack a
 * meaningful interactive history file OR don't have an equivalent rc
 * override worth implementing for v1.
 *
 * See docs/51-shell-history.md for the full spec.
 */
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

import { readFileSettings } from '../file-settings.js';

export type ShellKind = 'bash' | 'zsh' | 'fish' | null;

/**
 * Pure: classify a resolved terminal command (e.g. `/bin/zsh -i`,
 * `bash --login`, `claude --dangerously-load-development-channels …`) into
 * one of the three handled shells, or null when it's something else (a TUI,
 * a npm script, an unrelated shell). Strips path + Windows `.exe`
 * extension. Case-insensitive on the basename.
 */
export function classifyShellCommand(command: string): ShellKind {
  const trimmed = command.trim();
  if (trimmed === '') return null;
  const firstToken = trimmed.split(/\s+/)[0] ?? '';
  if (firstToken === '') return null;
  const basename = firstToken.replace(/.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
  if (basename === 'bash') return 'bash';
  if (basename === 'zsh') return 'zsh';
  if (basename === 'fish') return 'fish';
  return null;
}

export type HistoryScope = 'per-terminal' | 'inherit';

/**
 * Pure: read the project's `terminal_history_scope` file-settings key,
 * normalising any unknown value to the default `'per-terminal'`. Exported
 * for unit testing — the production caller goes through `readFileSettings`
 * directly.
 */
export function normaliseHistoryScope(raw: unknown): HistoryScope {
  return raw === 'inherit' ? 'inherit' : 'per-terminal';
}

export interface ShellInitResult {
  /** Env vars to inject into the PTY's environment. */
  env: Record<string, string>;
  /** When non-null, the command that should be passed to the PTY's `-c`
   *  argument instead of the originally-resolved command. Bash needs this
   *  because `--rcfile` is a CLI argument, not an env var. zsh + fish use
   *  env-var-only overrides so this is null for them. */
  rewrittenCommand: string | null;
  /** Diagnostic — which shell was detected (or null for skipped). Useful
   *  for tests + future telemetry; not consumed by production callers. */
  shell: ShellKind;
}

const NOOP: ShellInitResult = { env: {}, rewrittenCommand: null, shell: null };

/**
 * Pure-ish — given a resolved terminal command + project context, generate
 * the init files on disk + return the env / command-rewrite needed to point
 * the spawned shell at them. No-ops (returns NOOP) when:
 *  - The command isn't bash / zsh / fish.
 *  - The project's `terminal_history_scope` setting is `'inherit'`.
 *
 * The init-file generation is idempotent — overwrite is fine, the per-shell
 * file content is deterministic given (terminalId, dataDir).
 */
export function setupShellHistoryForSpawn(opts: {
  dataDir: string;
  terminalId: string;
  command: string;
}): ShellInitResult {
  const shell = classifyShellCommand(opts.command);
  if (shell === null) return NOOP;

  const settings = readFileSettings(opts.dataDir);
  const scope = normaliseHistoryScope(settings.terminal_history_scope);
  if (scope === 'inherit') return NOOP;

  const hotsheetDir = join(opts.dataDir, '.hotsheet');
  const initRoot = join(hotsheetDir, 'shell_init', opts.terminalId);
  const histDir = join(hotsheetDir, 'shell_history');
  const histFile = join(histDir, opts.terminalId);

  try {
    mkdirSync(initRoot, { recursive: true });
    mkdirSync(histDir, { recursive: true });
  } catch {
    // Permissions / read-only FS — skip the override so the spawn doesn't
    // fail on what is supposed to be a transparent QOL feature.
    return NOOP;
  }

  if (shell === 'bash') return setupBash(opts.dataDir, initRoot, histFile, opts.command);
  if (shell === 'zsh') return setupZsh(opts.dataDir, initRoot, histFile);
  return setupFish(opts.dataDir, initRoot, opts.terminalId);
}

// -------------------------------------------------------------------------
// Per-shell setup
// -------------------------------------------------------------------------

function setupBash(_dataDir: string, initRoot: string, histFile: string, command: string): ShellInitResult {
  const rcPath = join(initRoot, '.bashrc');
  writeAtomic(rcPath, buildBashRc(histFile));
  const rewritten = rewriteBashCommand(command, rcPath);
  return {
    env: {},
    rewrittenCommand: rewritten,
    shell: 'bash',
  };
}

function setupZsh(_dataDir: string, initRoot: string, histFile: string): ShellInitResult {
  // Generate the full rc chain: zshenv → zprofile → zshrc. zsh sources them
  // in that order for an interactive login shell; for non-login interactive
  // it's zshenv → zshrc. We override HISTFILE in `.zshrc` so it lands AFTER
  // every other rc has run (which is the whole point — see module header).
  writeAtomic(join(initRoot, '.zshenv'), buildZshShim('zshenv'));
  writeAtomic(join(initRoot, '.zprofile'), buildZshShim('zprofile'));
  writeAtomic(join(initRoot, '.zshrc'), buildZshRc(histFile));
  return {
    env: { ZDOTDIR: initRoot },
    rewrittenCommand: null,
    shell: 'zsh',
  };
}

function setupFish(dataDir: string, initRoot: string, terminalId: string): ShellInitResult {
  // fish indexes its history by SESSION NAME (`fish_history` env var), not
  // by file path — the resulting file lives at
  // `$XDG_DATA_HOME/fish/<name>_history` (default `~/.local/share/fish/...`).
  // Use a deterministic name keyed on (project hash, terminalId) so multiple
  // projects don't collide on the same name.
  const projectHash = createHash('sha256').update(dataDir).digest('hex').slice(0, 8);
  const sessionName = `hotsheet_${projectHash}_${sanitiseFishName(terminalId)}`;
  const fishConfigDir = join(initRoot, 'fish');
  try { mkdirSync(fishConfigDir, { recursive: true }); } catch { return NOOP; }
  writeAtomic(join(fishConfigDir, 'config.fish'), buildFishConfig(sessionName));
  return {
    env: { XDG_CONFIG_HOME: initRoot },
    rewrittenCommand: null,
    shell: 'fish',
  };
}

// -------------------------------------------------------------------------
// Init-file content builders (pure)
// -------------------------------------------------------------------------

/** Pure: generate the bash init-file body. Sources the user's normal
 *  `~/.bashrc` first (guarded) so the user's prompt / aliases / etc. are
 *  preserved, then exports the per-terminal HISTFILE + reads it. Exported
 *  for tests. */
export function buildBashRc(histFile: string): string {
  const escaped = shellEscape(histFile);
  return `# Hot Sheet — generated. Sources the user's bashrc first, then overrides
# HISTFILE so up-arrow recall is scoped to this terminal tab.
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc"
export HISTFILE=${escaped}
[ -f "$HISTFILE" ] && history -r "$HISTFILE"
`;
}

/** Pure: generate the zshrc body. Same structure as bash. Exported for
 *  tests. */
export function buildZshRc(histFile: string): string {
  const escaped = shellEscape(histFile);
  return `# Hot Sheet — generated. Sources the user's zshrc first, then overrides
# HISTFILE so up-arrow recall is scoped to this terminal tab.
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"
export HISTFILE=${escaped}
fc -p "$HISTFILE"
`;
}

/** Pure: generate one of the zsh shims (.zshenv / .zprofile) that just
 *  sources the user's matching home rc so the rc-load chain is preserved
 *  even though we redirected `ZDOTDIR`. */
export function buildZshShim(name: 'zshenv' | 'zprofile'): string {
  return `# Hot Sheet — generated. Source the user's ~/.${name} so the chain is preserved.
[ -f "$HOME/.${name}" ] && source "$HOME/.${name}"
`;
}

/** Pure: generate the fish config body. Sources the user's normal config
 *  first, then sets the per-terminal session name. Exported for tests. */
export function buildFishConfig(sessionName: string): string {
  return `# Hot Sheet — generated. Source the user's config.fish first, then point
# fish at a per-terminal history session so up-arrow is scoped to this tab.
test -e "$HOME/.config/fish/config.fish"; and source "$HOME/.config/fish/config.fish"
set -x fish_history ${sessionName}
`;
}

/** Pure: rewrite a bash spawn command to inject `--rcfile <rcPath>`. Skips
 *  the rewrite when `--rcfile` is already present OR when the command is a
 *  login shell (`-l` / `--login`) — bash login shells read `~/.bash_profile`
 *  not `~/.bashrc`, so the rcfile flag has no effect there. Exported for
 *  tests. */
export function rewriteBashCommand(command: string, rcPath: string): string {
  if (/--rcfile\b/.test(command)) return command;
  if (/\s(-l|--login)\b/.test(command)) return command;
  // Replace the first whitespace-delimited token (the bash invocation) with
  // `<token> --rcfile <rcPath>`.
  const tokens = command.split(/\s+/);
  if (tokens.length === 0) return command;
  const head = tokens[0];
  const tail = tokens.slice(1).join(' ');
  const rcFlag = `--rcfile ${shellEscape(rcPath)}`;
  return tail === '' ? `${head} ${rcFlag}` : `${head} ${rcFlag} ${tail}`;
}

// -------------------------------------------------------------------------
// Pure helpers
// -------------------------------------------------------------------------

/** Pure: single-quote a path for safe inclusion in a shell command. Wraps
 *  in `'...'` and escapes any embedded single quotes via `'\''`. */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Pure: drop characters from a terminal id that fish's session-name parser
 *  doesn't accept. fish accepts `[A-Za-z0-9_]`; we replace anything else
 *  with `_`. */
export function sanitiseFishName(id: string): string {
  return id.replace(/[^A-Za-z0-9_]/g, '_');
}

function writeAtomic(path: string, content: string): void {
  // Idempotent overwrite — the content is deterministic per-(terminalId,
  // dataDir) so a clobbering write is the right move on every spawn (no
  // stale content can persist if the user's HOME path or terminalId
  // changes).
  try {
    writeFileSync(path, content, 'utf-8');
  } catch {
    // Best-effort. A spawn that lands without the per-terminal history
    // override degrades to today's behaviour (shared HISTFILE) rather than
    // failing the spawn outright.
  }
}
