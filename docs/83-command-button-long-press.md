# 83. Command-Button Long-Press Actions

> **Status:** Partial. **§83.1 (HS-8539) — long-press a custom *shell* command button → run it in a new terminal — shipped.** §83.2 (HS-8538) — long-press a custom *Claude* command button → create a ticket — is designed here but not yet built (separate ticket).

Custom command buttons in the sidebar (§15 shell-commands, §16 command-groups) support a **secondary gesture** — a press-and-hold (long-press) — that runs an alternative action to the normal click, so a single button offers two related behaviors without extra UI. The alternative differs by the button's target:

| Target | Normal click | Long-press (≥ 500 ms) |
|---|---|---|
| **Shell** | Inline streaming run (§53), unless "Launch in New Terminal" is on (then = new terminal) | Run in a **new drawer terminal** (default shell) — §83.1 |
| **Claude** | Send the prompt to the channel | Create a **ticket** to run the command — §83.2 (HS-8538, designed only) |

The long-press threshold is **500 ms** (`LONG_PRESS_MS` in `src/client/commandSidebar.tsx`). While held, the button shows a subtle press feedback (`.channel-command-btn.is-long-pressing` — slight scale/opacity). On the threshold the alternative action fires immediately and the trailing `click` event is suppressed (a `longPressed` flag → `preventDefault` + `stopPropagation`), so the normal action does NOT also fire.

## 83.1 Shell command → run in a new terminal (HS-8539, shipped)

### Behavior
- **Long-press a shell command button** opens a **new drawer terminal running the user's default shell** and runs the command in it — as if typed — leaving a live prompt + shell history afterward. This is **always** available (regardless of the per-command option below).
- **Per-command option "Launch in New Terminal"** (`CustomCommand.launchInNewTerminal`, default **off**). When on, a *normal click* also opens a new terminal instead of the inline run. Edited via a shell-only checkbox in the command editor (`src/client/commandEditor.tsx`), next to "Show log on completion".
- **Option × long-press interaction (Option B, per the user).** Long-press is *always* the new-terminal action — it is **not** an inverse of the click. So when "Launch in New Terminal" is on, a click and a long-press do the same thing (long-press is simply redundant there). This was a deliberate choice over an "inverse" model for predictability.
- **First-use hint toast.** The first time the user does a *normal click* on any shell command button, a one-time toast appears: *"Tip: long-press a shell command button to run it in its own new terminal instead."* Persisted via the `localStorage` key `hotsheet:shell-longpress-hint-shown` (same one-time pattern as the §53 streaming toast), so it shows at most once across reloads and projects. It does **not** fire on a long-press (the user clearly already knows the gesture).

### Implementation
- **Server.** `POST /api/terminal/create` gains an optional `runCommand` field (`CreateTerminalReqSchema`, `src/api/terminal.ts`). When set, the route (`src/routes/terminal.ts`) eager-spawns the terminal with the **default shell** as the PTY command (NOT `runCommand` as the command) and, after a **300 ms** delay, writes `runCommand\n` into the PTY via the existing `writeInput(secret, data, terminalId)` (`src/terminals/registry`). The delay lets the shell's line editor (bash readline / zsh zle) finish rc-file startup so the injected input isn't dropped or garbled; `writeInput` is a no-op if the PTY already exited. The command's output is captured in the PTY ring buffer and replayed on WebSocket attach, so it's visible even though it runs before the client connects.
- **Client.** `openTerminalRunningCommand(command, name?)` (`src/client/terminal.tsx`) calls `createTerminal({ spawn: true, runCommand, name })`, applies the same "hide in non-default visibility groupings" rule as the drawer "+" button, then opens the drawer (if closed) and selects the new terminal's tab via the new `openDrawerTab(tab)` helper (`src/client/commandLog.tsx`). The sidebar's `wireShellButtonPress` (`src/client/commandSidebar.tsx`) wires the pointerdown/up/leave/cancel timer + click branching; `runShellInNewTerminal(cmd)` lazy-imports `terminal.js` so the terminal stack isn't pulled into the sidebar's import graph at load.
- **Why "in the default shell" (not the command as the PTY program).** Running the command as the PTY's program would make the terminal exit when the command finishes and wouldn't give a real shell session. Writing it into a default-shell PTY keeps the prompt, environment, and history — matching the user's "in the default shell" requirement.

### Tests
- **Server (unit).** `src/routes/api.test.ts` "terminal route" — `POST /create` with `runCommand` spawns the default shell (the PTY command is NOT `runCommand`), writes nothing before the delay, and writes `runCommand\n` after advancing 300 ms (fake timers + a PTY factory that captures writes).
- **Manual (gesture + platform).** Long-press timing, the press visual, the click-suppression, the first-use toast, the per-command option, and the default-shell resolution on Windows/Linux are covered in `docs/manual-test-plan.md` (long-press + platform behavior are inherently manual, per the testing philosophy).

## 83.2 Claude command → create a ticket (HS-8538, designed only)

Long-pressing a custom **Claude** command button should create a **ticket** to run the command later, rather than sending the prompt to the channel immediately. Per HS-8538 the ticket should default to a **TSK** category even when "task" isn't in the project's configured category list (or fall back gracefully if that's infeasible), and a first-use hint toast should teach the gesture. This shares the same long-press plumbing as §83.1 (`wireShellButtonPress`'s claude-target analogue) and is tracked in **HS-8538**.

## Cross-references
- [15-shell-commands.md](15-shell-commands.md) — custom shell command targets + execution.
- [16-command-groups.md](16-command-groups.md) — the command sidebar.
- [22-terminal.md](22-terminal.md) — drawer terminal lifecycle + PTY.
- [53-streaming-shell-output.md](53-streaming-shell-output.md) — the inline-run streaming path the normal click uses.
- [57-shell-command-button-spinner.md](57-shell-command-button-spinner.md) — running-state spinner + stop confirm on the same buttons.
