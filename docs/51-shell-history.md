# 51. Per-Terminal Shell History Scoping

HS-7964 (investigation) / HS-7965 (implementation). Each Hot Sheet terminal tab gets its own up-arrow history pool, scoped per (project, terminal id). Pre-fix every Hot Sheet shell across every project shared the user's global `~/.bash_history` / `~/.zsh_history` / fish default-session history file, so up-arrow recall mixed commands from unrelated tabs and projects.

> **Status:** Shipped.

## 51.1 Why the simple `HISTFILE` env-var fix isn't enough

Setting `HISTFILE` in the PTY's spawn env is silently clobbered on default-macOS zsh: `/etc/zshrc_Apple_Terminal` unconditionally rewrites `HISTFILE` to a per-session file, and that rc runs AFTER our env injection but BEFORE the user's interactive prompt. Any user `~/.zshrc` that does `HISTFILE=...` defeats the same trick. So the fix has to inject AFTER the user's rc loads, which means using each shell's init-file override mechanism.

## 51.2 Per-shell mechanism

Each shell exposes a different override hook:

| Shell | Override | Generated init-file content |
| --- | --- | --- |
| **bash** | `--rcfile <path>` CLI arg | sources `~/.bashrc` (defensive `[ -f ]`) → exports per-terminal `HISTFILE` → `history -r "$HISTFILE"` |
| **zsh**  | `ZDOTDIR=<dir>` env var | generated `<dir>/.zshrc` sources `$HOME/.zshrc` → exports `HISTFILE` → `fc -p "$HISTFILE"`. Companion `<dir>/.zshenv` + `<dir>/.zprofile` shims source the user's matching home rcs so the full rc-load chain is preserved. |
| **fish** | `XDG_CONFIG_HOME=<dir>` env var | generated `<dir>/fish/config.fish` sources `~/.config/fish/config.fish` → `set -x fish_history hotsheet_<projectHash>_<terminalId>` (fish indexes by session NAME, not file path; the resulting file lives at `~/.local/share/fish/<name>_history`) |

Other shells (sh, dash, ksh, pwsh, cmd) are skipped — they either lack a meaningful interactive history file OR have no equivalent rc-override mechanism worth implementing for v1.

**Detection** — `classifyShellCommand(command)` extracts the first whitespace-delimited token, strips path + Windows `.exe` extension, and matches the basename (case-insensitive) against `bash` / `zsh` / `fish`. Returns `null` for everything else (TUI commands like `claude`, `vim`, `less`, `htop` — those programs own their own internal state, not shell history). Spaces in Windows paths aren't supported in the classifier — users with spaces in shell paths can use the short DOS name (`C:\msys64\usr\bin\bash.exe` style).

## 51.3 Storage layout

All generated init files + history files live under `<dataDir>/.hotsheet/` so they don't pollute the project tree:

- `<dataDir>/.hotsheet/shell_init/<terminalId>/` — generated rc files per terminal (overwritten on every PTY spawn, idempotent).
- `<dataDir>/.hotsheet/shell_history/<terminalId>` — per-terminal history file (bash + zsh).
- Fish history: lives where fish puts it, under the redirected `XDG_CONFIG_HOME`. The session-name uses an 8-char SHA-256-hex prefix of the dataDir + the terminalId so multiple projects can't collide on the same fish session-name.

`<dataDir>/.hotsheet/` is gitignored by default (per [§2 + `src/gitignore.ts`](2-data-storage.md)) — no project-tree pollution.

## 51.4 Bash command rewrite

Bash is the awkward one: `--rcfile` is a CLI argument, not an env var, so we can't override via `buildEnv()`. The wrap happens in `setupShellHistoryForSpawn` via the pure helper `rewriteBashCommand(command, rcPath)`:

- `bash` → `bash --rcfile '<path>'`.
- `bash -i` → `bash --rcfile '<path>' -i` (preserves trailing args).
- Skipped when the command already has `--rcfile` (defensive — user already opted out).
- Skipped when the command has `-l` or `--login` — login shells read `~/.bash_profile`, not `~/.bashrc`, so `--rcfile` has no effect there.
- The rcfile path goes through `shellEscape` so paths with spaces / single-quotes survive intact.

zsh + fish are env-var-only — no command rewrite needed.

## 51.5 Wire-up

`spawnIntoSession` in `src/terminals/registry.ts` calls `setupShellHistoryForSpawn({ dataDir, terminalId, command })` after `resolveTerminalCommand`. The helper returns `{ env, rewrittenCommand, shell }`. The PTY is then spawned with:

- `command: rewrittenCommand ?? resolved.command` (bash gets the `--rcfile` injection; zsh/fish/non-shells unchanged).
- `env: buildEnv(shellInit.env)` (existing scrub + standard env vars + the per-shell override vars).

`buildEnv` was extended from a no-arg function to `buildEnv(extra: Record<string, string> = {})` so the override env vars layer on top of the existing scrub + standard vars cleanly.

## 51.6 Settings

New per-project file-settings key:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `terminal_history_scope` | `'per-terminal'` \| `'inherit'` | `'per-terminal'` | `'inherit'` falls back to the pre-HS-7965 behaviour (no `HISTFILE` injection → user's rc default). Pure helper `normaliseHistoryScope(raw)` accepts unknown / non-string values and falls back to the default. |

No UI for this in v1 — the default Just Works; power users who want the global-history behaviour back can edit `settings.json` by hand. A Settings → Terminal toggle is a follow-up if the user reports friction.

## 51.7 Lifecycle

- **Spawn:** generate init files (idempotent overwrite — content is deterministic from `(terminalId, dataDir)`) + inject env / rewrite command.
- **Terminal config delete:** GC the per-terminal init dir + history file. **Not yet implemented** — orphan dirs accumulate under `<dataDir>/.hotsheet/shell_init/`. Low priority because (a) the dirs are tiny (~200 bytes each), (b) only configured terminals get generated dirs (dynamic `dyn-*` terminals also get them but those clean up the same way). Worth a follow-up if a user reports clutter.
- **Dynamic terminals (`dyn-*` ids):** session-only conceptually, but the generated init files are persistent. The history files survive a session end and would re-attach if the same `dyn-*` id was reused (it isn't — they're randomly generated each session). Net effect: a small accumulation of dead history files for dynamic terminals.

## 51.8 Out of scope

- **Windows PowerShell + cmd history scoping.** PowerShell uses `PSReadLine` which has its own history mechanism (`$env:PSReadLineHistorySavePath`); cmd's `doskey` is per-process. Both are separate tickets if asked.
- **Migration of the user's existing global history into per-terminal pools.** One-time manual; documented here.
- **Cross-terminal recall ("search all my history across projects").** `atuin` and similar SQLite-backed tools do this externally — Hot Sheet doesn't replicate.
- **TUI-level history (`claude`, `vim`, `less`, `htop`).** Those programs own their own state. Up-arrow inside Claude only recalls Claude's own command palette regardless of what we do at the shell layer.
- **GC sweep of orphaned per-terminal init dirs** (see §51.7).

## 51.9 Implementation files

- New `src/terminals/shellHistory.ts` — the entire feature. Pure helpers (`classifyShellCommand`, `normaliseHistoryScope`, `shellEscape`, `sanitiseFishName`, `buildBashRc` / `buildZshRc` / `buildZshShim` / `buildFishConfig`, `rewriteBashCommand`) + the imperative entry point `setupShellHistoryForSpawn`.
- Edited `src/terminals/registry.ts` — `spawnIntoSession` calls the new helper; `buildEnv` extended to accept extra vars.
- 25 unit tests in `src/terminals/shellHistory.test.ts` covering classification, scope normalisation, shell-escape rules, fish-name sanitisation, all 4 init-file builders, and bash-command rewrite (bare / with-args / already-has-rcfile / login-shell-skip / quote-escaping).
