# 37. Quit confirmation when terminals are running (HS-7591)

## 37.1 Overview

Hot Sheet runs long-lived processes inside its embedded terminals (claude sessions, dev servers, build watchers, debuggers). Today, quitting the app via ⌘Q on macOS / Alt+F4 on Windows / closing the last window via the traffic-light button silently destroys every running PTY and discards in-flight work — easy to do by accident, hard to recover from. This document specifies the **quit-confirm** behavior: an opt-in confirmation dialog modeled after macOS Terminal.app's "Ask before closing" preference, with a configurable list of process names to ignore so quitting an idle shell session doesn't pester the user.

**Core promises:**

1. The user is **never silently quit** while a meaningful process is running in any of their terminals.
2. The default is conservative — the prompt fires whenever there's anything other than an idle login shell or a known-safe utility (`less`, `htop`, etc.) running.
3. The user controls **per-project** when the prompt fires (always / never / only-with-non-exempt-processes) and can edit the exempt list.
4. **All four** quit paths are gated: ⌘Q / Alt+F4 (1), red traffic-light close of the last window (2), `hotsheet --close` CLI (3), and POST `/api/shutdown` (4 — used by stale-instance cleanup).

## 37.2 The decision model — macOS Terminal.app parity

The mental model is taken directly from macOS Terminal.app's _Settings → Profiles → Shell → "Ask before closing"_ control. Three modes per project:

- **Always** — confirm on every quit, regardless of what's running.
- **Never** — never confirm; quit silently. Power-user opt-out.
- **Only if there are processes other than the login shell and:** — the default. Confirm only when at least one terminal is running a process that is (a) NOT the configured base command (the login shell, in macOS Terminal's parlance), AND (b) NOT on the user-editable **exempt list** (defaults to a curated set of benign / interactive tools the user can quit out of trivially).

The exempt list is a flat list of process basenames the prompt should ignore. macOS Terminal.app's defaults — and the values Hot Sheet ships with as initial defaults — are:

```
screen, tmux, less, more, view, mandoc, tail, log, top, htop
```

The user can add or remove entries via Settings → Terminal → Quit confirmation (HS-7591 follow-up implementation ticket; spec deferred to that ticket since the v1 doc is about behavior, not UI chrome).

## 37.3 The "one level deeper" rule

A configured terminal's `command` field is what gets exec'd at PTY spawn. When that command IS itself a shell (`bash`, `zsh`, `fish`, `sh`, `dash`, `ash`, `pwsh`, `powershell`, `cmd`, `cmd.exe`), the shell itself is the "login shell" — meaning its mere presence doesn't justify a prompt. To know whether a non-trivial process is running, we have to look ONE LEVEL DEEPER into the PTY's process tree and pick the foreground child of the shell. macOS Terminal.app does the same — the shell IS the login shell, so the question becomes "what is the shell currently running?"

Concretely:

| Configured `command`        | PTY's shell child                | Decision rule                                                    |
|-----------------------------|----------------------------------|------------------------------------------------------------------|
| `zsh` / `bash` / `fish` / … | (no foreground child)            | Idle login shell — **no prompt**                                 |
| `zsh`                       | `claude`                         | `claude` not in exempt list — **prompt**                         |
| `zsh`                       | `htop`                           | `htop` IS in exempt list — **no prompt**                         |
| `zsh`                       | `tmux`                           | `tmux` IS in exempt list — **no prompt**                         |
| `claude`                    | (claude is the PTY root)         | `claude` not exempt — **prompt**                                 |
| `htop`                      | (htop is the PTY root)           | `htop` is exempt, AND it IS the configured base command — **no prompt** |
| `npm run dev`               | `node` (npm exec'd into node)    | `node` not exempt — **prompt**                                   |

When the PTY's root process is itself NOT a shell (e.g. terminal command is `claude` or `npm run dev`), there's no "one level deeper" — that root process is what we evaluate. The shell-detection check uses a small fixed list (`SHELL_BASENAMES`) — see §37.6 for the exact list.

When the foreground-child detection fails (process exited mid-check, OS lookup error, Windows job-object oddity), the safe-default is to **assume there's a non-exempt process** and prompt. Users prefer one extra prompt over a silent kill of unfinished work.

## 37.4 The prompt itself

A single in-app `confirmDialog` (NOT per-terminal — the user explicitly didn't want N popups for N alive terminals) anchored to the active window. The prompt is a batch confirm listing every project + every running terminal that contributed to the prompt firing:

```
┌─────────────────────────────────────────────────────────┐
│ Quit Hot Sheet?                                         │
│                                                         │
│ The following terminals are running active processes:   │
│                                                         │
│   My App                                                │
│     • claude (claude)                                   │
│     • build (npm run dev → node)                        │
│   Other Project                                         │
│     • default (gh auth login)                           │
│                                                         │
│ Quitting will stop all of them.                         │
│                                                         │
│ ☐ Don't ask again for any project                       │
│                                                         │
│              [Cancel]   [Quit Anyway]                   │
└─────────────────────────────────────────────────────────┘
```

- Each line shows: project name → terminal label → currently-foreground process basename (one level deeper than the shell when applicable).
- The "Don't ask again" checkbox flips every project's `confirm_quit` setting (see §37.5) to `'never'` for the lifetime of the user's setup. A more granular per-project version is possible via the explicit Settings UI (§37.5) but isn't in the prompt to keep it simple.
- Cancel keeps the app running. Quit Anyway proceeds with the normal shutdown flow (every PTY teardown path already works — destroyAllTerminals in src/terminals/registry.ts).

The prompt does NOT give per-terminal "kill this one but keep the others" granularity — that's what the existing in-drawer Stop button + tab-close confirmation are for. The Quit prompt's job is "all-or-nothing."

## 37.5 Settings — per-project + global

Two new keys, both per-project in `.hotsheet/settings.json`:

- `confirm_quit_with_running_terminals: 'always' | 'never' | 'with-non-exempt-processes'` (default `'with-non-exempt-processes'`).
- `quit_confirm_exempt_processes: string[]` (default `['screen', 'tmux', 'less', 'more', 'view', 'mandoc', 'tail', 'log', 'top', 'htop']`).

Settings UI: Settings → Terminal gains a new "Quit confirmation" section with:

- A radio group matching macOS Terminal's three options (mapped to the values above).
- An editable list of exempt process basenames (text-area-style with one entry per line; basenames only, case-insensitive match).
- A "Reset to defaults" link.

When the user has multiple Hot Sheet projects open, the prompt aggregates ALL projects' alive terminals — the macOS quit confirmation is global to the app, not per project. The setting that controls whether to prompt is read PER project, and the prompt fires if ANY project's `confirm_quit_with_running_terminals` is `'always'` OR if ANY project's `'with-non-exempt-processes'` resolves to "yes, prompt." A project set to `'never'` contributes its alive terminals to the displayed list (so the user sees what they're killing) but does NOT cause the prompt to fire on its own. If every project is `'never'`, no prompt — silent quit.

## 37.6 Implementation surface

**Detection.** Server-side, given a PTY's pid, walk to the foreground child via the OS process-table:

- macOS / Linux: `ps -o pid,ppid,comm -A` parsed to a parent→children map; pick the most recent child of the PTY's pid (or its shell child) whose `comm` is non-empty.
- Windows: `Get-Process -IncludeChildren` (PowerShell) or the WMI Win32_Process query — slower but matches the existing Tauri sidecar's process management.

A new server endpoint `GET /api/terminal/foreground-process?terminalId=` returns `{ command: string, isShell: boolean, isExempt: boolean, error: string | null }` for a single terminal. Aggregated cross-project in `GET /api/projects/quit-summary` so the JS can compute the prompt's terminal list with one round-trip total. The implementation lives in `src/terminals/processInspect.ts` (helpers: `normalizeComm`, `parsePsOutput`, `descendantChain`, `pickForegroundProcess`, `inspectForegroundProcess`) with pure-helper unit tests in `processInspect.test.ts`. Server-side, `getTerminalPid(secret, terminalId)` in `src/terminals/registry.ts` exposes the live PTY's pid; `listAliveTerminalsAcrossProjects()` enumerates every alive terminal across every registered project for the cross-project aggregator.

> **HS-7790 fix.** macOS `ps -o comm` emits the executable's full path (e.g. `/bin/zsh`) and login shells are reported with a leading dash (e.g. `-zsh`). Pre-fix, `parsePsOutput` stored those values verbatim, and the downstream `SHELL_BASENAMES` / exempt-list comparisons all silently failed to match — so the user's "exempt zsh" choice was ignored and an idle login shell tripped the prompt. The new `normalizeComm` helper strips the directory prefix, the leading dash, and any `.exe` suffix, applied in `parsePsOutput` so every downstream consumer sees a stable basename. Two new regression tests in `processInspect.test.ts` cover the macOS path + login-dash cases plus a full end-to-end check that an idle `/bin/zsh` correctly resolves to "exempt shell" with `zsh` in the user's exempt list.

> **HS-7789 fix.** The quit-summary aggregator previously labeled entries via `listTerminalConfigs(dataDir)` only — that returns the persisted (settings-backed) terminals. Dynamic (ad-hoc) terminals created via `POST /api/terminal/create` keep their `name` in the in-memory `dynamicConfigs` map in `src/routes/terminal.ts`, so a dynamic terminal's row in the dialog fell through to the raw `dyn-…` id. The route now also consults the new `listDynamicTerminalConfigs(secret)` export and merges those configs into the label lookup, matching how `/api/terminal/list` already labels dynamic tabs. Two new regression tests in `projects.test.ts` cover both the explicit-name and command-derived-fallback paths.

The shell-detection list:

```
SHELL_BASENAMES = ['bash', 'zsh', 'fish', 'sh', 'dash', 'ash', 'ksh', 'tcsh', 'pwsh', 'powershell', 'cmd', 'cmd.exe']
```

**Tauri quit-handler.** Three converging paths in `src-tauri/src/lib.rs` ensure every quit trigger gates through the JS dialog: (1) a `tauri::WindowEvent::CloseRequested` handler catches the red traffic-light close + Alt+F4. (2) A custom `app-quit` menu item with `CmdOrCtrl+Q` accelerator (replacing the predefined `.quit()` — see HS-7596 fix below) catches ⌘Q + the App-menu Quit click. (3) A `RunEvent::ExitRequested` handler in the run loop catches programmatic `app.exit()` calls + the dock-menu Quit on macOS. All three check the `QuitConfirmed: AtomicBool` state — when false, they prevent the exit and emit a `quit-confirm-requested` event to the JS frontend. The JS side (`initQuitConfirm` in `src/client/quitConfirm.tsx`) listens via `__TAURI__.event.listen`, runs `runQuitConfirmFlow()` which fetches `/api/projects/quit-summary` and shows the dialog, then on "Quit Anyway" invokes the new `confirm_quit` Tauri command. `confirm_quit` flips the AtomicBool to true and calls `app.exit(0)`; the second `ExitRequested` fire sees the flag set and lets the exit proceed normally; `RunEvent::Exit` then kills the sidecar. The decision logic itself (`evaluateQuitDecision`) is a pure function in the same module, covered by 9 unit tests in `quitConfirm.test.ts`.

> **HS-7596 follow-up:** the predefined `PredefinedMenuItem::quit()` on macOS maps to `NSApp::terminate:`, which in this Tauri version did NOT reliably fire `RunEvent::ExitRequested` — so ⌘Q bypassed the gate even after the `ExitRequested` handler was added. The fix is to own the menu item ourselves: a custom `MenuItemBuilder` with id `app-quit` + `CmdOrCtrl+Q` accelerator routes through `on_menu_event`, which emits `quit-confirm-requested` directly. The `RunEvent::ExitRequested` handler is kept as a safety net for paths we don't own (programmatic `app.exit()` and the macOS dock-menu Quit).

**CLI `hotsheet --close`.** Extends `handleClose` in `src/cli.ts` with a new `confirmCloseAgainstQuitSummary` step: before the DELETE /api/projects/{secret}, fetch /api/projects/quit-summary, filter to the project being closed, apply the §37.5 logic, and prompt the user via stdin (`y/N`) if needed. The new `--force` flag (added to `ParsedArgs`) skips the prompt for non-interactive use. Errors fetching the summary fall through to "no prompt needed" so older instances don't break the CLI.

**Stale-instance cleanup.** This path (`/api/shutdown` from the stale-instance lock-file detector) is genuinely programmatic — there's no human at the keyboard. The cleanup intentionally bypasses the prompt and proceeds to teardown (it's already running because the user opened a NEW Hot Sheet window targeting the same data dir, so the OLD window is stale by definition). This matches the user's clarification that all four paths gate, but the stale-instance path's gate is "skip the prompt because the user is already quitting through the new window."

## 37.7 Out of scope (v1)

- **Per-terminal kill confirm** — handled separately by the existing tab-close + Stop button flows (§22). The Quit prompt is all-or-nothing.
- **"Save my session" / re-spawn-on-restart of the running processes** — too risky; the user can recreate dynamic terminals manually.
- **Send SIGINT / SIGTERM and wait for graceful shutdown before forcing SIGHUP/SIGKILL** — out of scope for the prompt; the existing teardown signal flow (HS-7528) already does the right thing.
- **Cross-window aggregation across separate Tauri processes** — the prompt only sees the current Tauri window's known projects. Two separate Hot Sheet windows running independently each prompt independently.

## 37.8 Manual test plan

See [manual-test-plan.md §12](manual-test-plan.md#12-embedded-terminal) — gets a new Quit-confirm subsection covering:

1. Idle shell only — quit silently with no prompt.
2. Shell running `claude` — prompt fires, lists "claude (claude)".
3. Shell running `htop` — prompt does NOT fire (htop in exempt list); quitting kills it silently.
4. Multiple projects with a mix — prompt aggregates all running non-exempt terminals.
5. Setting set to `'never'` — no prompt regardless of what's running.
6. Setting set to `'always'` — prompt fires even with idle shells.
7. macOS ⌘Q, traffic-light close, Alt+F4 (Linux), `hotsheet --close` — all four paths gate.
8. `hotsheet --close --force` — bypasses the prompt.
9. Cancel — app stays running, no PTYs killed.
10. Quit Anyway — every PTY torn down via destroyAllTerminals's existing SIGHUP path (HS-7528).

## 37.9 Cross-references

- [22-terminal.md](22-terminal.md) §22.7 — base PTY lifecycle. The quit-confirm is a new gate IN FRONT OF the existing `destroyAllTerminals` shutdown flow (HS-7528 SIGHUP path).
- [10-desktop-app.md](10-desktop-app.md) — Tauri shell. The `CloseRequested` handler lives there.
- [8-cli-server.md](8-cli-server.md) — CLI shutdown command flow.
- **Status:** Shipped (HS-7596). Files: `src/terminals/processInspect.ts` + `.test.ts` (22 tests), `src/client/quitConfirm.tsx` + `.test.ts` (9 tests), `src/client/quitConfirmSettingsUI.tsx` (Settings panel), `src/routes/projects.ts` (cross-project /quit-summary route), `src/routes/terminal.ts` (per-terminal /foreground-process route), `src/terminals/registry.ts` (`getTerminalPid` + `listAliveTerminalsAcrossProjects`), `src/file-settings.ts` (added `quit_confirm_exempt_processes` to JSON_VALUE_KEYS), `src-tauri/src/lib.rs` (QuitConfirmed AtomicBool + on_window_event handler + confirm_quit Tauri command), `src/client/app.tsx` (initQuitConfirm wiring), `src/client/tauriIntegration.tsx` (getTauriEventListener helper), `src/cli.ts` (--force flag + handleClose quit-summary prompt), `src/routes/pages.tsx` (Settings → Terminal Quit confirmation panel), `src/client/settingsDialog.tsx` (loadAndWireQuitConfirmSettings hook on dialog open).
