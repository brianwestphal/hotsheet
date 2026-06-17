# 83. Command-Button Long-Press Actions

> **Status:** Shipped. **§83.1 (HS-8539)** — long-press a custom *shell* command button → run it in a new terminal. **§83.2 (HS-8538)** — long-press a custom *Claude* command button → create a Task ticket.

Custom command buttons in the sidebar (§15 shell-commands, §16 command-groups) support a **secondary gesture** — a press-and-hold (long-press) — that runs an alternative action to the normal click, so a single button offers two related behaviors without extra UI. The alternative differs by the button's target:

| Target | Normal click | Long-press (≥ 500 ms) |
|---|---|---|
| **Shell** | Inline streaming run (§53), unless "Launch in New Terminal" is on (then = new terminal) | Run in a **new drawer terminal** (default shell) — §83.1 |
| **Claude** | Send the prompt to the channel | Create a **Task ticket** from the command — §83.2 (HS-8538) |

The long-press threshold is **500 ms** (`LONG_PRESS_MS` in `src/client/commandSidebar.tsx`). While held, the button shows a subtle press feedback (`.channel-command-btn.is-long-pressing` — slight scale/opacity). On the threshold the alternative action fires immediately and the trailing `click` event is suppressed (a `longPressed` flag → `preventDefault` + `stopPropagation`), so the normal action does NOT also fire.

## 83.1 Shell command → run in a new terminal (HS-8539, shipped)

### Behavior
- **Long-press a shell command button** opens a **new drawer terminal running the user's default shell** and runs the command in it — as if typed — leaving a live prompt + shell history afterward. This is **always** available (regardless of the per-command option below).
- **Per-command option "Launch in New Terminal"** (`CustomCommand.launchInNewTerminal`, default **off**). When on, a *normal click* also opens a new terminal instead of the inline run. Edited via a shell-only checkbox in the command editor (`src/client/commandEditor.tsx`), next to "Show log on completion".
- **Option × long-press interaction (Option B, per the user).** Long-press is *always* the new-terminal action — it is **not** an inverse of the click. So when "Launch in New Terminal" is on, a click and a long-press do the same thing (long-press is simply redundant there). This was a deliberate choice over an "inverse" model for predictability.
- **First-use hint toast.** The first time the user does a *normal click* on any shell command button, a one-time toast appears: *"Tip: long-press a shell command button to run it in its own new terminal instead."* Persisted via the `localStorage` key `hotsheet:shell-longpress-hint-shown` (same one-time pattern as the §53 streaming toast), so it shows at most once across reloads and projects. It does **not** fire on a long-press (the user clearly already knows the gesture).

### Implementation
- **Server.** `POST /api/terminal/create` gains an optional `runCommand` field (`CreateTerminalReqSchema`, `src/api/terminal.ts`). When set, the route (`src/routes/terminal.ts`) eager-spawns the terminal with the **default shell** as the PTY command (NOT `runCommand` as the command), then injects `runCommand\n` into the PTY via `writeInput(secret, data, terminalId)` (`src/terminals/registry`) **once the shell's output has settled** — see below. `writeInput` is a no-op if the PTY already exited. The command's output is captured in the PTY ring buffer and replayed on WebSocket attach, so it's visible even though it runs before the client connects.
- **Output-settle injection (HS-8840).** Rather than a fixed delay, `injectCommandWhenSettled` (`src/routes/terminal.ts`) polls `getLastOutputAtMs`: it injects once the shell has produced output **and** that output has been quiet for `quietMs` (150 ms — the prompt has rendered and the shell is awaiting input). This **adapts to the shell's real startup time**, so a slow shell (PowerShell on Windows can take noticeably longer to be ready for input) doesn't drop or garble the command the way a fixed 300 ms could. A `maxWaitMs` ceiling (3000 ms) is a hard fallback so the gesture never silently does nothing even if the shell never settles or emits no output. Timings live in the exported `_settleInjectTimings` (test-overridable). This replaced the original fixed-300 ms delay.
- **Client.** `openTerminalRunningCommand(command, name?)` (`src/client/terminal.tsx`) calls `createTerminal({ spawn: true, runCommand, name })`, applies the same "hide in non-default visibility groupings" rule as the drawer "+" button, then opens the drawer (if closed) and selects the new terminal's tab via the new `openDrawerTab(tab)` helper (`src/client/commandLog.tsx`). The sidebar's `wireShellButtonPress` (`src/client/commandSidebar.tsx`) wires the pointerdown/up/leave/cancel timer + click branching; `runShellInNewTerminal(cmd)` lazy-imports `terminal.js` so the terminal stack isn't pulled into the sidebar's import graph at load.
- **Why "in the default shell" (not the command as the PTY program).** Running the command as the PTY's program would make the terminal exit when the command finishes and wouldn't give a real shell session. Writing it into a default-shell PTY keeps the prompt, environment, and history — matching the user's "in the default shell" requirement.

### Tests
- **Server (unit).** `src/routes/api.test.ts` "terminal route" — `POST /create` with `runCommand` spawns the default shell (the PTY command is NOT `runCommand`); covers both injection paths with fake timers + a PTY factory that captures writes AND can emit data: the **settle** path (simulate the shell printing its prompt → inject after the quiet window) and the **fallback** path (no output → inject after `maxWaitMs`).
- **E2E (HS-8839).** `e2e/command-long-press.spec.ts` drives a real press-and-hold past the 500 ms threshold and asserts a new dynamic terminal tab (`terminal:dyn-*`) opens + becomes active (and the button never enters the inline-run state), plus a normal click opening a new terminal when "Launch in New Terminal" is on. Skips gracefully when the sidebar command container isn't present in the environment.
- **Manual (platform).** The per-OS default-shell resolution (zsh/bash/PowerShell) + the first-use toast are covered in `docs/manual-test-plan.md` — platform behavior is inherently manual.

## 83.2 Claude command → create a Task ticket (HS-8538, shipped)

### Behavior
- **Long-press a Claude command button** creates a **Task ticket** from the command instead of sending the prompt to the channel: the ticket's **title** is the command's name and its **details** are the command's prompt (the text that would otherwise go to Claude). A success toast confirms ("Created a task from \"<name>\".") and the ticket list reloads so it appears immediately. Always available (Claude buttons have no per-command option, unlike the shell "Launch in New Terminal").
- **Normal click** is unchanged — sends the prompt to the channel (or a warning toast when Claude isn't connected).
- **First-use hint toast** — the first time the user does a *normal click* on any Claude command button, a one-time toast teaches the gesture: *"Tip: long-press a Claude command button to make a task from it instead of running it."* Persisted via `localStorage` key `hotsheet:claude-longpress-hint-shown` (once globally; doesn't fire on a long-press).

### Category = always `task` (TSK)
The created ticket's category is always **`task`** (whose `shortLabel` is "TSK"). `tickets.category` is a **free string** column (`TicketCategory = string`), and the create API stores whatever is passed — so the ticket is categorized `task` **even when the project removed `task` from its configured category list** (per the user's request). The only cosmetic consequence in that edge case is the ticket may render without a configured color/label for `task`; it's still a valid, filterable ticket. (So the "if that would cause too much trouble" caveat didn't apply — free-string categories made it trivial.)

### Implementation
- `wireClaudeButtonPress(btn, cmd)` (`src/client/commandSidebar.tsx`) mirrors §83.1's `wireShellButtonPress`: a pointerdown/up/leave/cancel timer at the shared `LONG_PRESS_MS` (500 ms), with the trailing click suppressed after a long-press. `makeTaskFromClaudeCommand(cmd)` calls the typed `createTicket({ title: cmd.name, defaults: { category: 'task', details: cmd.prompt } })`, toasts, and lazy-imports `loadTickets` to refresh. `maybeFireClaudeLongPressHintToast()` is the one-time hint. (While here, the connect-failure `window.alert` was replaced with an in-app warning toast — `window.alert` no-ops in Tauri's WKWebView.)

### Tests
- **E2E (HS-8844).** `e2e/command-long-press.spec.ts` long-presses a Claude command button and asserts a Task ticket was created from it (title = command name, details = the prompt, category `task`) — proving the gesture and that the prompt wasn't sent to the channel. Skips when the Claude button can't render (channel disabled / no compatible Claude CLI). The first-use hint toast stays a manual-test-plan item.

## Cross-references
- [15-shell-commands.md](15-shell-commands.md) — custom shell command targets + execution.
- [16-command-groups.md](16-command-groups.md) — the command sidebar.
- [22-terminal.md](22-terminal.md) — drawer terminal lifecycle + PTY.
- [53-streaming-shell-output.md](53-streaming-shell-output.md) — the inline-run streaming path the normal click uses.
- [57-shell-command-button-spinner.md](57-shell-command-button-spinner.md) — running-state spinner + stop confirm on the same buttons.
