# 26. Shell integration via OSC 133 (design spike, HS-7265)

## 26.1 Status

**Design only.** This doc is the feasibility spike produced for HS-7265. The protocol, data model, UI, and phased scope are proposed here; implementation tickets (HS-7265-a through HS-7265-d below) are separately tracked and land in later changes.

## 26.2 What OSC 133 does

OSC 133 (aka "FinalTerm shell integration", also adopted verbatim by iTerm2, VS Code's integrated terminal, Warp, Ghostty, Kitty, WezTerm) is a four-mark protocol a shell emits around every prompt-command-output cycle:

| Escape | Meaning | When the shell emits it |
|---|---|---|
| `\x1b]133;A\x07` | **prompt start** | immediately before drawing PS1 |
| `\x1b]133;B\x07` | **command start** (user input region begins) | immediately after PS1 is drawn, before readline runs |
| `\x1b]133;C\x07` | **output start** (command has been entered, output follows) | after the user presses Enter, before `eval`'ing the command |
| `\x1b]133;D;<exit>\x07` | **command end** with exit code | in `precmd` / `PROMPT_COMMAND`, before the next prompt |

Users opt in by sourcing a shell-integration snippet. Real-world sources:
- **Starship** (via `eval "$(starship init zsh)"`) — emits A/B/C/D automatically.
- **VS Code** (`shellIntegration.rc.zsh`, `shellIntegration-bash.sh`, `shellIntegration.fish`) — same protocol with VS Code-specific extensions under OSC 633 (superset).
- **iTerm2** (`iterm2_shell_integration.zsh` et al.) — emits OSC 133 plus iTerm2-proprietary OSC 1337.
- **Manual PS1 hooks** — users with custom prompts add the escapes by hand.

## 26.3 Why this is the highest-value terminal feature we could add

Once a host knows where each command starts and ends, it can expose:

1. **Jump to previous / next command** (keyboard shortcut, scroll-like glyphs in a gutter). Today scrolling the drawer or a dashboard tile means eyeball-scanning walls of output.
2. **Copy last command output** — single click, grabs the range between the most recent C and the next A. Massively reduces friction for "send me the error" / "paste the logs" flows.
3. **Rerun last command** — re-send the captured B→C range as input.
4. **Exit-code glyph in the gutter** (green check / red X / grey "running") next to each command. A one-glance view of "which commands in this scrollback failed".
5. **AI-assisted command analysis** — with structured command + output + exit code ranges, the Claude Channel can be handed "the last failed command and its full output" as a single blob, unlocking "ask Claude why this failed" from the toolbar. This is the strongest unique-to-Hot-Sheet angle since Hot Sheet already has the channel wired up.

Developers who cite "the integrated terminal" as VS Code's killer feature are almost always citing OSC 133 behaviours (1)–(4). Item (5) is the Hot-Sheet-specific wedge.

## 26.4 Protocol coverage assessment

xterm.js has **no built-in OSC 133 handling**. Parsing is straightforward via `term.parser.registerOscHandler(133, handler)` — the handler receives the payload (`A`, `B`, `C`, or `D;<exit>`) and returns `true` to indicate we've consumed the escape. xterm.js does not swallow it even when handled; that's fine — the escape is invisible to the renderer anyway.

**Range tracking.** Buffer ranges are kept alive across scrollback trimming via `term.registerMarker(lineOffset)` — xterm markers follow a buffer line as rows are trimmed off the top, and fire a `dispose` event when their line falls out of scrollback. This is the right primitive for "where does command N start / end".

**Decorations.** xterm's `term.registerDecoration({ marker, x, width, backgroundColor })` API attaches DOM elements to a marker; it's how we'll draw the gutter glyphs and hover regions. Decoration positions follow their marker automatically.

## 26.5 Data model

Per-terminal instance, on `TerminalInstance`:

```ts
interface CommandRecord {
  id: string;                       // monotonically increasing per terminal
  promptStart: IMarker;             // A mark
  commandStart: IMarker | null;     // B mark (some shells skip B)
  outputStart: IMarker | null;      // C mark
  commandEnd: IMarker | null;       // D mark; null while running
  exitCode: number | null;          // null while running or if D missing
  commandText: string | null;       // captured between B and C (xterm row-range read)
  decorations: IDisposable[];       // gutter glyph decoration(s) to dispose on eviction
}

interface TerminalInstance {
  // ... existing fields ...
  shellIntegration: {
    enabled: boolean;               // true once we see the first OSC 133
    commands: CommandRecord[];      // bounded ring (keep last 500)
    current: CommandRecord | null;  // the in-flight command (A seen, D not yet)
  };
}
```

**Bounded ring.** Cap at 500 records per terminal. When evicting the oldest, dispose its markers (xterm will clean up decorations automatically) so we don't leak DOM.

**Persistence.** `shellIntegration.commands` is in-memory on the client only. Server-side scrollback replay reseeds it — OSC 133 escapes are in the replayed byte stream, xterm parses them on replay, so the client rebuilds the record list automatically on reattach. No schema change needed.

## 26.6 UI proposal

Ship across three phases so we can land value incrementally and re-evaluate.

### Phase 1 — Gutter glyphs + "copy last output"

- Add a 12-px gutter column on the left side of the xterm pane. Green check (exit 0), red X (non-zero), grey spinner (running). Glyphs attached via `registerDecoration` to the `promptStart` marker.
- Toolbar button: **Copy last output**. Reads the row range between the most recent `outputStart` and the most recent `commandEnd` (or current line if running), converts to plain text via `term.buffer.active.getLine(row).translateToString()`, writes to clipboard.
- No new scrollback widgets, no keybindings — keep the first phase visually calm.
- Decision point: only render the gutter when `shellIntegration.enabled === true`, so users who don't opt into shell integration see no layout change.

### Phase 2 — Jump shortcuts + hover actions

- `Cmd/Ctrl+Up` / `Cmd/Ctrl+Down`: scroll the xterm buffer to the previous / next `promptStart` marker. Implement via `term.scrollToLine(marker.line)`.
- Hover a gutter glyph → show a popover (positioned by DOM offset of the decoration) with three actions: **Copy command**, **Copy output**, **Rerun**. Rerun sends `commandText + \r` back through the `onData` WS path.
- Settings toggle "Enable shell integration features" (default on). When off, the OSC handler still runs but no UI is rendered.

### Phase 3 — AI integration via channel

- Toolbar button on the gutter glyph popover: **Ask Claude about this**. Packs `{command, output, exitCode, cwd-if-OSC7-shipped}` into a channel trigger (§12) with the template "The command `$CMD` exited with code $N in `$CWD`. Output:\n\n$OUTPUT\n\nPlease diagnose and propose a fix."
- Gated on Claude Channel being alive (same gate as other channel features).
- Optional: auto-expand the command log (§14) with a `shell_analysis` entry the user can later revisit.

## 26.7 Shell integration installation

**We do not ship shell rc fragments.** Users opt in themselves, same as VS Code. We'll document three routes in a README section under §26.9:

1. **Starship** — `eval "$(starship init zsh)"` in `~/.zshrc` (users who already have Starship are one-line done).
2. **VS Code** — tell zsh/bash users to source VS Code's published rc file directly. Cross-referenced in VS Code's docs; keeps us out of the maintenance path.
3. **Manual minimal snippet** — publish a ~15-line zsh / bash / fish snippet in the doc for users who want to opt in without pulling in Starship or VS Code.

Rationale: bundling a Hot-Sheet-owned rc script turns into a support matrix (zsh vs. bash vs. fish × macOS vs. Linux × "I already have integration" detection). Cheaper to document the three external options.

## 26.8 Scope boundaries

**Explicitly in scope for Phase 1:**
- OSC 133;A / B / C / D handler.
- Gutter column with exit-code glyphs.
- "Copy last output" toolbar button.
- Record eviction at 500 commands / terminal.
- Scrollback-replay rehydration (just works via xterm parser).

**Deferred to Phase 2 / 3:**
- Keyboard shortcuts.
- Hover popover with Copy / Rerun.
- AI "ask Claude about this" integration.

**Explicitly out of scope (may revisit):**
- **OSC 633** (VS Code shell integration superset — adds `E` for command-line, `P` for properties, etc.). VS Code's zsh integration emits OSC 633 alongside OSC 133. If Phase 1 ships with a pure OSC 133 handler, VS Code users will work in "133-only" mode (we get A/B/C/D but miss the commandLine-as-a-separate-field that 633;E provides). Acceptable for v1; revisit if users report issues.
- **iTerm2's OSC 1337 proprietary marks.** Parallel namespace, not needed for the features above.
- Replaying markers into the server-side ring buffer so the Terminal Dashboard (§25) tiles can also render glyphs — interesting but requires invasive changes and the dashboard tiles are already content-dense; defer unless users ask.
- Cross-terminal command history search (the "open any previous command from any terminal" iTerm2 feature). Feels out of scope for an embedded dev-tool terminal.

## 26.9 Known edge cases

1. **Shells that skip B.** Some minimal integrations emit only A and D. Record creation must tolerate `commandStart === null`; the "Copy command" action gracefully degrades ("command text unavailable").
2. **OSC 133 inside alternate-screen apps.** `tmux`, `vim`, `less`, and similar enter the alternate screen buffer; any 133 escapes they emit are drawn there and then discarded when the alt screen exits. Markers attached to alt-screen rows dispose automatically when the buffer is torn down — we just drop records whose `promptStart` marker fires its `onDispose`.
3. **Runaway `C` without `D`.** If a process is killed mid-output (SIGKILL, not `exit`), no `D` is emitted — the record stays `current` indefinitely. Mitigation: when the PTY exits (§22 registry emits `exit`), mark any in-flight record's `exitCode = -1` and clear `current`.
4. **Nested shells.** `bash -c 'zsh'` inside a zsh prompt: both shells emit A/D. Records interleave; our flat ring handles this fine, but the gutter glyph for the outer shell's prompt won't appear where you'd expect during the inner session. Call out in docs; don't try to nest.
5. **Replay ordering.** Our replay writes the entire history frame in one `term.write` — xterm's parser walks the bytes synchronously, so 133 escapes fire in order. We must register the OSC handler *before* calling `replayHistoryToTerm`. Enforce in `mountXterm`.

## 26.10 Implementation tickets (created alongside this doc)

- **HS-7267** — Phase 1a foundation: OSC 133 handler + `CommandRecord` model + gutter column.
- **HS-7268** — Phase 1b copy-last-output toolbar button.
- **HS-7269** — Phase 2 jump shortcuts + hover popover (Copy / Rerun).
- **HS-7270** — Phase 3 "Ask Claude about this" channel integration.

HS-7265 (this doc) is the feasibility spike only; it closes when this doc lands. Shipping HS-7267 through HS-7270 is tracked against those separate tickets.

## 26.11 Cross-references

- [22-terminal.md](22-terminal.md) — base terminal infrastructure.
- [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) — companion QOL features (OSC 0/2/bell).
- [14-commands-log.md](14-commands-log.md) — potential sink for Phase 3 "shell_analysis" entries.
- [12-claude-channel.md](12-claude-channel.md) — the channel is the vehicle for Phase 3.
- xterm.js API: `term.parser.registerOscHandler`, `term.registerMarker`, `term.registerDecoration`, `term.buffer.active.getLine`, `term.scrollToLine`.
- Spec: [FinalTerm OSC 133 proposal](https://iterm2.com/documentation-shell-integration.html), [VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration).
