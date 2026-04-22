# 23. Terminal titles and bell indicators (HS-6473)

## 23.1 Overview

Two related quality-of-life features for the embedded terminal (see [22-terminal.md](22-terminal.md)):

1. **Title-change escape sequences** — when the running process pushes a title via the standard OSC 0 / OSC 2 escapes (`\x1b]0;TITLE\x07` or `\x1b]2;TITLE\x07`), the drawer tab and in-pane terminal header label update to reflect it. Most modern shells push title updates that include the current working directory or the running command, which is far more informative than a static "Terminal" label.
2. **Bell character indicator** — when the process rings the terminal bell (`\x07` byte), display a Lucide `bell` glyph on the tab so the user is aware of the event even when looking at a different tab. Cleared as soon as the user views the tab.

Together these two features let the user see at a glance _what_ each terminal is doing and _which one wants attention_ without needing to switch tabs to peek.

## 23.2 Title-change escape sequences

xterm.js handles parsing of OSC 0 / OSC 2 / OSC 1 (icon name, treated equivalently) natively. The client subscribes to `term.onTitleChange((newTitle) => { ... })` in `mountXterm` and stores the value on the `TerminalInstance` as `runtimeTitle`.

**Label resolution priority** (in `effectiveTabLabel`):
1. `runtimeTitle` if non-empty
2. `config.name` if set in Settings → Terminal
3. Derived from `config.command` (basename of the executable, with `claude` recognized specially)

**Reset on PTY restart.** When the user clicks the Stop/Start power button to restart the PTY, `onPowerClick` clears `runtimeTitle = ''` so the label falls back to the configured name until the new process pushes its own title.

**Reset on project switch.** A project switch tears down every `TerminalInstance` (`onProjectSwitch` in `terminal.tsx`) and rebuilds them on demand, so `runtimeTitle` resets to empty for the new project's terminals automatically. The next attach will replay scrollback that includes any prior title escapes — xterm processes them while replaying — so the title is restored to whatever the process most recently set.

**Empty-string semantics.** If a process explicitly pushes an empty title (`\x1b]0;\x07`), `runtimeTitle` becomes `''` and the label falls back to the configured name. This matches xterm emulator behavior.

## 23.3 Bell character indicator (`\x07`)

xterm.js fires `term.onBell()` whenever it parses an unescaped bell byte. The client default `bellStyle` is `'none'` so xterm itself does not beep — the only effect is the indicator described here.

### Phase 1 — same-project terminals (shipped)

When the bell fires in a terminal whose tab is **not** the currently active drawer tab in this project, the tab gets a `has-bell` class and a Lucide `bell` icon is inserted as a sibling of the label. CSS triggers a one-shot 350 ms wiggle animation so the indicator catches the eye on first appearance; subsequent re-renders (e.g. tab label changing) do not re-trigger the wiggle.

The indicator clears when the user activates the tab (`activateTerminal` checks `inst.hasBell` and removes the icon + class). It also clears implicitly if the bell fires while the tab is already active — the `isTerminalTabActive` guard in the `onBell` handler suppresses the indicator in that case.

### Phase 2 — cross-project terminals (deferred)

The same indicator is intended to appear on the **project tab** when any terminal in a non-current project fires a bell, and on the terminal tab inside that project's drawer once the user navigates to it. This requires server-side detection of `\x07` bytes in the PTY output stream (the client only sees bells for xterms that are mounted, which is none in non-active projects). Tracked separately as a follow-up because it adds:

- A scan for `\x07` bytes inside `TerminalRegistry`'s data handler (negligible overhead but new code path)
- A per-terminal `bellPending` field surfaced via `/api/terminal/list` and a global `/api/terminals/bell-state` long-poll (so non-active projects can be notified without each one opening a WebSocket per terminal)
- A `POST /api/terminal/clear-bell` endpoint
- Project tab indicator rendering and clear-on-activate semantics

Until Phase 2 ships, bells in non-active projects are silently dropped and bells in non-active-but-not-yet-mounted terminals (lazy terminals never opened) are not surfaced.

## 23.4 Manual test plan

See [manual-test-plan.md §12](manual-test-plan.md#12-embedded-terminal):
- Run `printf '\\033]0;custom-title\\007'` in a terminal — the drawer tab and the in-pane header switch to "custom-title".
- Restart the PTY (Stop, then Start) — the label reverts to the configured name until the new process pushes a title.
- Run `printf '\\007'` (or `tput bel`) in terminal A while terminal B is the active drawer tab — terminal A's tab gains a wiggling bell glyph; clicking on terminal A clears it.
- The same bell fired while terminal A *is* active produces no indicator (the user is already looking).

## 23.5 Cross-references

- [22-terminal.md](22-terminal.md) — base terminal feature; this doc adds two surface enhancements.
- xterm.js API: `term.onTitleChange(handler)`, `term.onBell(handler)`, `bellStyle: 'none'`.
- **Tickets:** HS-6473 (this doc).
