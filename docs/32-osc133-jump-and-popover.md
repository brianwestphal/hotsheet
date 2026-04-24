# 32. OSC 133 Phase 2 — Jump shortcuts + hover popover (HS-7269)

## 32.1 Overview

Phase 2 of the OSC 133 rollout (see [26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.6) turns the Phase 1 marker ring into a navigational and interactive affordance:

- **Keyboard jumps.** `Cmd/Ctrl+Up` and `Cmd/Ctrl+Down` scroll the xterm viewport to the previous / next command's prompt marker.
- **Hover popover.** Hovering any gutter glyph (from Phase 1a) pops a small three-button menu anchored to the glyph: Copy command / Copy output / Rerun.
- **Settings toggle.** A per-project "Enable shell integration UI" checkbox under Settings → Terminal. When off, the OSC 133 parser still runs (markers are tracked) but the gutter / popover / shortcuts don't render, and toggling back on reveals everything without losing history.

Phase 3 (HS-7270, Ask-Claude-about-this) uses Phase 2's popover and `readRecordCommand` / `readRecordOutput` helpers as its foundation.

## 32.2 Keyboard shortcuts

Implementation: `term.attachCustomKeyEventHandler` in `mountXterm`. The handler intercepts key events and:

1. Ignores the key when `shell_integration_ui` is off (setting-gated).
2. Ignores the key when `shellIntegration.enabled` is false (no markers → nothing to jump to).
3. Calls `isJumpShortcut(e)` from `src/client/terminalKeybindings.ts` (HS-7460), which returns `'prev' | 'next' | null`. The helper rejects `keyup` / `keypress`, both-modifiers-held, Alt/Shift held, the wrong-platform modifier (so macOS `Ctrl+Up/Down` falls through to xterm — preserved for tmux pane resize, vim/nvim, fish-shell history-token-search, etc.), and any non-arrow key.
4. On `'prev' | 'next'`, calls `jumpToPromptMarker(inst, direction)` and returns `false` to swallow the event.

`jumpToPromptMarker` walks `shellIntegration.commands`, collects `.line` values from alive `promptStart` markers, passes them to `findPromptLine(input)` (pure helper in `terminalOsc133.ts`) with the current `buffer.active.viewportY` as the anchor, and calls `term.scrollToLine(target)` when a target exists. When no target exists the keystroke is still swallowed (to avoid emitting `\e[1;5A` escape sequences that would confuse the user) — the no-op is silent.

`findPromptLine` rules:

- `direction: 'prev'` → newest line strictly LESS than `fromLine`. Null when all markers are at or above `fromLine`.
- `direction: 'next'` → oldest line strictly GREATER than `fromLine`. Null when all markers are at or below `fromLine`.
- Does not assume the input list is sorted (ring buffer pushes in chronological order which happens to be line-increasing, but we compute the min/max explicitly).

8 new unit tests cover empty list, prev / next basics, skip-at-equal-line, null when all above / below, out-of-order input, single marker.

## 32.3 Hover popover

Implementation: per-decoration event handlers attached in `attachGutterDecoration`'s `onRender` callback. On `mouseenter`, `showGutterPopover(el, term, record)` disposes any existing popover and mounts a fresh one positioned via `getBoundingClientRect()` on the glyph — `position: fixed`, `left = rect.right + 6`, `top = rect.top + rect.height/2`, `transform: translateY(-50%)`, `z-index: 600`.

The popover has three buttons:

- **Copy command** — reads `record.commandStart` → `record.outputStart` (B→C) via `readRecordCommand(term, record)`, writes to `navigator.clipboard`. Silently no-ops when B or C is disposed / missing (shell that skips B).
- **Copy output** — reads `record.outputStart` → `record.commandEnd` (C→D) via `readRecordOutput(term, record)`. When D is missing (still running) falls back to current cursor position + 1.
- **Rerun** — calls `term.paste(readRecordCommand(term, record).replace(/\n+$/,'') + '\r')`. Uses xterm's public `paste` API so the bytes go through the same `onData` → WS path as normal typing, bypassing any custom key handler. The trailing `\r` fires the shell's Enter.

Close behaviour: `mouseleave` on either the glyph OR the popover starts a 200 ms close timer (`scheduleGutterPopoverClose`). Moving the cursor from glyph to popover cancels the timer via the popover's `mouseenter` handler, so users can leave the glyph and click a button without the popover vanishing. Clicking a button fires the action then closes immediately.

A single module-level `gutterPopoverEl` is reused — hovering a different glyph retargets the same position. Only one popover is ever in the DOM.

Buttons fire copy / rerun without any visual confirmation; the clipboard update is instantaneous and invisible by design (Phase 1b's toolbar button flashes on success because the click is on a persistent affordance, but the popover already provides visual feedback by closing after the click).

## 32.4 Settings toggle

Added field: `shell_integration_ui: boolean` in `AppSettings` (default `true`). Persistence: stored as `"true"` / `"false"` string in the existing per-project settings store (`/api/settings` PATCH). Loader handles missing keys gracefully — an upgraded install with no `shell_integration_ui` in `settings.json` reads as `true` (the default), so Phase 2 turns on automatically for existing projects.

UI: a checkbox under Settings → Terminal (`#settings-shell-integration-ui`) with a one-line hint explaining what the UI comprises and noting that the parser stays on.

When the checkbox flips:

1. `state.settings.shell_integration_ui` updates.
2. `PATCH /api/settings` persists the new value.
3. A custom DOM event `hotsheet:shell-integration-ui-changed` dispatches.
4. `initTerminal` listens for the event and walks every instance, running `applyShellIntegrationToolbarVisibility` (copy-output button show/hide) and `reapplyShellIntegrationDecorations` (gutter glyphs re-register or dispose). No PTY restart needed.

The keyboard shortcut handler and `attachGutterDecoration` both check `shellIntegrationUiEnabled()` on every call, so toggling the setting mid-session takes effect immediately without touching the command ring — markers keep accumulating in the background, and re-enabling restores the full UI against the complete history.

## 32.5 Edge cases

- **Viewport anchor.** Jumps use `buffer.active.viewportY` (top of the visible scrollback) as the anchor, not `cursorY`. Rationale: if the user has scrolled up and their cursor is off-screen, they care about "the prompt above / below what I'm looking at", not "the prompt above / below some invisible cursor". `scrollToLine` moves the viewport so the target line is at the top.
- **No alt + shift modifier.** The custom key handler only fires on Cmd/Ctrl + ArrowUp/Down with NO Alt or Shift. `Cmd+Shift+Up` falls through to xterm's default (selection extend), preserving text-selection workflows.
- **Rerun via `term.paste`.** `paste` is the public xterm API for injecting input — it goes through the normal `onData` path, which our `term.onData` handler forwards to the WebSocket. This is more reliable than `inst.ws.send` directly (handles encoding, bracketed-paste mode, etc.).
- **Popover vs. Phase 1a `title`.** The gutter glyph's `title` attribute (from Phase 1a, "Command (exit N)") still renders a native tooltip after ~1 s hover. The popover appears immediately on mouseenter; both are visible simultaneously but they don't overlap (native tooltip below, popover to the right). Harmless.
- **Scrollback trim during hover.** If the command's marker disposes while the user is hovering (rare — requires heavy continuous output), a click on Copy / Rerun no-ops silently. The popover remains open until mouseleave.

## 32.6 Testing

### Unit tests (`src/client/terminalOsc133.test.ts`)

9 new cases in `describe('findPromptLine (HS-7269)')` block cover empty list, prev newest-below, skip-at-equal-line for prev, null-when-all-above, next oldest-above, skip-at-equal-line for next, null-when-all-below, out-of-order input, single marker with both directions.

### E2E (HS-7328)

Playwright coverage shipped — `e2e/terminal-osc133-jump-popover.spec.ts` against the shared `e2e/fixtures/terminal-osc133.sh` fixture in `MODE=multi` (three sequential A → B → C → output → D;0 cycles). Two tests:

1. `three OSC 133 cycles render three gutter glyphs; Cmd/Ctrl+Up jumps and the popover surfaces (HS-7328)` — opens the drawer, activates the tab, waits for `OUTPUT-1` / `OUTPUT-3` / `READY` in `.xterm-screen`, asserts `.terminal-osc133-gutter` count is 3, hovers the second glyph, asserts the popover surfaces with Copy command / Copy output / Rerun buttons, clicks "Copy command" and asserts `navigator.clipboard.writeText` was called with the cycle's command text (`echo "line 2"`). Then scrolls to the bottom, focuses the xterm helper textarea, and presses the platform-correct chord (`Meta+ArrowUp` on macOS, `Control+ArrowUp` elsewhere — detected via `navigator.userAgent.includes('Mac')`); asserts the `.xterm-viewport` `scrollTop` is `<=` the pre-press value (i.e. the chord was intercepted by `isJumpShortcut` rather than forwarded to the shell as `\e[1;5A`).
2. `disabling shell_integration_ui hides the gutter glyphs (HS-7328)` — drives the actual Settings UI: clicks `#settings-btn`, switches to the Terminal tab, unchecks `#settings-shell-integration-ui`, presses Escape to close the dialog, asserts `.terminal-osc133-gutter` count drops to 0. PATCHing `/api/settings` directly is NOT enough — the `hotsheet:shell-integration-ui-changed` custom event that `terminal.tsx` listens for is dispatched from the checkbox change handler in `settingsDialog.tsx`, not from a settings-poll, so the test has to drive the checkbox to exercise the real reload path.

The clipboard is stubbed in `addInitScript` before bundle load (push-onto-`window.__clipboardWrites`) so the assertion is deterministic across browsers without Playwright clipboard permissions.

## 32.7 Out of scope

- **Jump to first / last command.** `Home` / `End` already scroll to buffer top / bottom via xterm's default; Cmd/Ctrl+Home/End is left to xterm too.
- **Visual scroll flash.** The jump is an instantaneous viewport move; no easing animation. Adds complexity without clear user benefit.
- **Show command text on hover of a glyph.** The popover's "Copy command" is one click away; a tooltip with the full command text is redundant and would collide with the native `title` attribute.
- **Copy colour codes.** Everything goes through `translateToString(true)` which flattens cell colours to plain text, same as Phase 1b.
- **Popover keyboard navigation.** The popover is mouse-only; Tab/Enter handling adds framework cost without meaningful benefit (hover is the common case).

## 32.8 Manual test plan (add to `docs/manual-test-plan.md` §26)

- In a shell-integrated terminal, run three distinct commands (`echo first`, `pwd`, `echo third`).
- Press `Cmd/Ctrl+Up` — viewport scrolls so the `pwd` prompt line is at the top. Press again — scrolls to `echo first`. Press once more when at the topmost marker — nothing happens (and no `\e[1;5A` escape leaks into the shell).
- `Cmd/Ctrl+Down` reverses the direction.
- Hover the top gutter glyph — a three-button popover appears to the right. Move cursor to the popover — it stays open. Click "Copy command" → clipboard has `echo first`. Paste elsewhere to verify.
- Hover same glyph, click "Rerun" — `echo first` appears at the prompt and runs.
- Hover same glyph, click "Copy output" → clipboard has `first`.
- Open Settings → Terminal. Uncheck "Enable shell integration UI" — gutter glyphs vanish, copy-output toolbar button hides. Cmd/Ctrl+Up does nothing (no scroll). Hovering where glyphs used to be → no popover.
- Re-check the box — glyphs reappear at their original positions (markers were preserved).

## 32.9 Cross-references

- [26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.6 Phase 2 — this doc is the implementation.
- [31-osc133-copy-last-output.md](31-osc133-copy-last-output.md) — Phase 1b (sibling).
- `src/client/terminalOsc133.ts` — `findPromptLine`, `computeLastOutputRange`.
- `src/client/terminal.tsx` — `jumpToPromptMarker`, `attachGutterHoverPopover`, `showGutterPopover`, `readRecordCommand` / `readRecordOutput`, `copyCommandOfRecord` / `copyOutputOfRecord` / `rerunCommandOfRecord`, `applyShellIntegrationToolbarVisibility`, `reapplyShellIntegrationDecorations`, `shellIntegrationUiEnabled`.
- `src/client/settingsDialog.tsx`, `src/client/settingsLoader.tsx`, `src/client/state.tsx` — `shell_integration_ui` setting plumbing.
- `src/client/styles.scss` — `.terminal-osc133-popover` + button styles.
- **Tickets:** HS-7269 (this doc), HS-7267 / HS-7268 (prior phases), HS-7270 (Phase 3 — Ask Claude), HS-7328 (Playwright e2e — shipped, see §32.6 E2E), HS-7460 (platform-specific `Cmd/Ctrl+Up/Down` match via `isJumpShortcut` so the wrong-platform modifier falls through to xterm).
