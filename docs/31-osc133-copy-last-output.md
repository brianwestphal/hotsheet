# 31. OSC 133 Phase 1b — Copy last output (HS-7268)

## 31.1 Overview

Phase 1a of the OSC 133 rollout ([26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.6) shipped the foundation: an OSC 133 parser, a bounded ring of `CommandRecord` markers, and a gutter glyph encoding each command's exit code. Phase 1b (this doc) uses those markers to ship a second affordance: a toolbar button that copies the most recent command's **output** to the clipboard.

Rationale: "Send me the error output" / "paste the log" flows are the single highest-friction interaction in a terminal today. Without shell integration, users select-drag across scrollback, which is fiddly in a small drawer pane and fails when output wraps past the viewport. With OSC 133 markers already tracked client-side, the host knows exactly where each command's output begins and ends — surfacing that as a single-click copy costs almost nothing on top of the Phase 1a foundation.

## 31.2 UI

A new toolbar button lives between the CWD chip (§29) and the stop/clear pair, rendered with a Lucide `clipboard-copy` glyph:

```
[status-dot] [label] [cwd-chip] ────── [copy-output] [stop] [clear]
```

The button is rendered with `display:none` in the initial tab markup and only revealed when the OSC 133 A handler fires for the first time (`applyShellIntegrationToolbarVisibility` in `terminal.tsx`). Users whose shells don't emit OSC 133 (no Starship, no VS Code rc, no manual hook) see no change in the toolbar. On PTY restart `resetShellIntegration` flips `enabled` back to false and the button hides again until the next A arrives.

### Visual feedback

- **Success**: button glyph swaps to a Lucide `check`, `color` animates to green (matches the Phase 1a gutter success glyph), reverts after 900 ms. Intentionally not a toast — the click was a direct action on the button, so a toast would feel redundant and the button-level flash keeps the attention where the user's pointer is.
- **No-op** (nothing to copy, clipboard write failed): button briefly shakes (`terminal-copy-output-shake` keyframe, 350 ms). Same treatment as the drawer-tab bell shake so the idiom is consistent.

### Keyboard shortcut (deferred to Phase 2)

HS-7269 adds Cmd/Ctrl+Up/Down jump shortcuts; a copy-output keyboard shortcut is not shipping with Phase 1b. Users click the button; that's the v1 contract.

## 31.3 Range computation (`computeLastOutputRange`)

Pure helper in `src/client/terminalOsc133.ts` with a narrow, test-friendly signature:

```ts
function computeLastOutputRange(input: {
  current: { outputStart: MarkerView | null } | null;
  commands: ReadonlyArray<{
    outputStart: MarkerView | null;
    commandEnd: MarkerView | null;
  }>;
  cursorLine: number;
}): { start: number; end: number } | null;
```

Priority order:

1. **In-flight record (running command).** If `current !== null` and its `outputStart` (C) marker is alive, the user is mid-output and wants what's on screen so far. Returns `[outputStart.line, cursorLine + 1)`. The `+1` makes the current cursor row inclusive.
2. **Most recent completed record.** If there's no alive in-flight C, fall back to the last element of `commands`. Returns `[outputStart.line, commandEnd.line)` when D is alive; if D has been disposed (rare — only scrollback trim between C-fire and copy click), falls back to `cursorLine + 1`.
3. **Null** when neither path is available: no records at all, the chosen record has no C (shell emits only A/D — output range is ambiguous), the C marker is disposed (scrollback trimmed past it), or the range is empty/inverted.

The C marker's own line is **included** in the range. Most shells place C on the line immediately after the user's Enter keypress — that line holds either the first output byte or is blank, and trimming trailing blank lines in the caller handles the blank-line case cleanly.

### Buffer reading in `terminal.tsx`

`copyLastOutput(inst)` reads the range via xterm's live buffer:

```ts
const buf = term.buffer.active;
const cursorLine = buf.baseY + buf.cursorY;
const range = computeLastOutputRange({
  current: inst.shellIntegration.current,
  commands: inst.shellIntegration.commands,
  cursorLine,
});
if (range === null) { shakeCopyOutputBtn(inst); return; }

const lines: string[] = [];
for (let y = range.start; y < range.end; y++) {
  const line = buf.getLine(y);
  if (line === undefined) continue;
  lines.push(line.translateToString(true));  // trimRight=true
}
while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
```

`translateToString(true)` trims trailing whitespace on each line (xterm API — doesn't touch internal cells, only the string view). Trailing blank lines are popped so a precmd line between command output and next prompt doesn't paste a dangling `\n`.

## 31.4 Clipboard

`navigator.clipboard.writeText(text)` — the standard DOM API. Works in Tauri WKWebView without a Tauri-specific invoke (unlike `window.open`, the clipboard API is natively supported in the WebKit variant Tauri uses). Browser fallback is the same code path. Clipboard-write rejection (user denied permission, non-secure context, etc.) triggers the shake treatment.

## 31.5 Edge cases

- **Very long output.** No length cap — if the user runs `find /` and clicks copy, they get the full range. xterm's scrollback cap (`scrollback: 1000` by default in our config) is the backstop. Realistically the range is already bounded by the ring buffer's 500-record cap times the scrollback rows per record.
- **Output that wraps past scrollback.** If C's line has been trimmed out of the buffer, the marker fires `onDispose` and `isDisposed` flips true. The helper returns `null` and the button shakes — the user can still manually select-drag the rows they can see.
- **Running command with no output yet.** C has fired but the cursor is still on C's own line with nothing after it. After trimming trailing blanks, `lines` is empty → shake. The user clicks again once output is visible.
- **Bell or alt-screen app active.** OSC 133 escapes emitted inside the alt screen (e.g. a shell-integrated `less`) register markers that dispose when the alt screen tears down (§26.9 item 2). If the user clicks copy after exiting `less`, the range computation falls back to whichever record was alive in the primary buffer — the expected "last normal command" behaviour.
- **Shell that emits only A/D (no C).** The most recent completed record has `outputStart: null`, the helper returns null, the button shakes. A Phase 2 fallback could read from `commandEnd` of the prior record to A of the latest, but that's error-prone (prompt text would get included) and the better fix is to document "copy last output needs a shell that emits C" — which every mainstream shell integration already does.

## 31.6 Testing

### Unit tests (`src/client/terminalOsc133.test.ts`)

12 new cases in a `describe('computeLastOutputRange (HS-7268)')` block cover:

- Empty records → null.
- Record with no C → null.
- Disposed C marker → null.
- Alive C + D → `[C, D)`.
- Alive C + disposed D → `[C, cursorLine + 1)`.
- In-flight record preferred over completed record.
- In-flight with disposed C falls back to latest completed.
- In-flight with no C (B seen, C not yet) → null.
- Multiple completed records → only the latest is used.
- Empty range (D on same line as C) → null.
- Inverted range (D before C) → null.
- Running command on first output line → `[C, cursor + 1)`.

### E2E (HS-7327)

Playwright coverage shipped — `e2e/terminal-osc133-copy-output.spec.ts` runs against a real PTY emitting OSC 133 escapes via `e2e/fixtures/terminal-osc133.sh` in `MODE=output` and `MODE=none`. Two tests:

1. `MODE=none` — no OSC 133 ever fires. The toolbar copy-output button stays `display:none` for the lifetime of the terminal (verifies `applyShellIntegrationToolbarVisibility` keeps it offscreen for non-shell-integrated terminals).
2. `MODE=output` — fixture emits a complete prompt cycle (A → B → C → distinctive output → D;0). After `READY` lands in the xterm screen the button becomes visible; clicking it triggers `copyLastOutput`, which writes the C → D range via `navigator.clipboard.writeText`. The clipboard is stubbed in an `addInitScript` so the assertion is deterministic across browsers and doesn't need Playwright clipboard permissions; the stub pushes onto `window.__clipboardWrites` and the test asserts the array contains the expected output. The success path's `.copied` class is also asserted before its 900 ms auto-clear.

The fixture uses `lazy: true` and the configure helper deliberately skips `POST /api/terminal/restart` — restart would spawn the PTY before the websocket attaches, then the first attach with `cols/rows` would trigger the HS-6799 eager-spawn Ctrl-L redraw, which the one-shot fixture has no way to handle (the script doesn't repaint after Ctrl-L). Letting the websocket attach trigger the spawn means the PTY's output is generated *for* the client's pane and lands in the xterm cleanly.

## 31.7 Out of scope

- **Keyboard shortcut.** Deferred to Phase 2 (HS-7269). Simpler to land the click-only flow first and let users ask for a shortcut if they want one.
- **Copy with ANSI escape retention.** We always use `translateToString` (cells → plain string), stripping colour codes. A user who wants the raw bytes can re-run with `| cat -v`.
- **Copy older commands.** Phase 2 (HS-7269) adds a hover popover on each gutter glyph with per-command Copy Command / Copy Output / Rerun actions. Phase 1b only copies the latest.
- **Cross-terminal "copy output from that other tab".** Not happening — each terminal's scrollback is its own thing.
- **Configurable dedupe / reformat** (strip timestamps, merge wrapped lines, etc.). The paste is whatever xterm rendered; post-processing happens downstream.

## 31.8 Manual test plan (add to `docs/manual-test-plan.md` §26)

- In a drawer terminal, run `eval "$(starship init zsh)"` (or enable VS Code's published rc). Run `echo hello; echo world; false`.
- The copy-output button appears in the toolbar on the first OSC 133 A (right after starship sets up its prompt).
- Click the button — the glyph flashes green for ~1 s. Paste into another app — you get `hello\nworld` and no trailing prompt line.
- Run `for i in 1 2 3; do echo stage $i; sleep 1; done` and click copy mid-loop while output is still arriving — you get whatever has been printed so far. Click again after the loop completes — you get the full three lines.
- Run a command that emits no output (`true`) — clicking copy shakes the button (no range).
- Restart the PTY (power button → start). The copy-output button disappears. Run a shell-integrated command — it re-appears on the next OSC 133 A.
- Scroll past ~1000 rows of output (more than xterm's scrollback) to trim the C marker off the top. Click copy — button shakes because the marker is disposed.
- Use a shell WITHOUT OSC 133 integration (`/bin/sh` with no rc tricks) — the button never appears.

## 31.9 Cross-references

- [26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.6 Phase 1b — this doc is the implementation of that phase.
- `src/client/terminalOsc133.ts` — `computeLastOutputRange` pure helper.
- `src/client/terminal.tsx` — `copyLastOutput`, `applyShellIntegrationToolbarVisibility`, `flashCopyOutputBtnSuccess` / `shakeCopyOutputBtn`.
- `src/client/styles.scss` — `.terminal-copy-output-btn.copied` green flash + `.shake` keyframe.
- **Tickets:** HS-7268 (this doc), HS-7267 (Phase 1a foundation), HS-7269 (Phase 2), HS-7270 (Phase 3), HS-7327 (Playwright e2e — shipped, see §31.6 E2E).
