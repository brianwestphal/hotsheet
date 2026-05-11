# 33. OSC 133 Phase 3 — Ask Claude about this command (HS-7270)

## 33.1 Overview

Phase 3 closes the OSC 133 rollout with the action that makes Hot Sheet's terminal meaningfully different from VS Code's: **one click on a failing command's gutter glyph dispatches the command, its output, its exit code, and its working directory to the Claude Channel with a diagnose-and-fix prompt**. See [26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.6 item 5 and [26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.3 item 5 — this is the Hot-Sheet-specific wedge.

Phases 1a / 1b / 2 shipped the marker ring, the copy-output button, and the hover popover respectively. Phase 3 is a small addition on top of Phase 2: a fourth button in the popover labeled **Ask Claude**, gated on the Claude Channel being alive, that builds a canonical prompt via a pure helper and hands it to the existing `triggerChannelAndMarkBusy(message)` export from `channelUI.tsx`.

## 33.2 Popover entry

The Phase 2 popover (§32.3) renders three utility buttons: Copy command / Copy output / Rerun. Phase 3 adds a fourth, **Ask Claude**, at the end of the popover. Visibility is decided at popover open time:

- `isChannelAlive() === true` → the button renders, styled with the accent color and bold text so it reads as the headline action.
- `isChannelAlive() === false` → the button is omitted entirely. The popover keeps its three utility actions so users without the channel installed still get the Phase 2 affordances.

Rationale for opening-time check (vs. click-time): mirrors `channelUI.tsx`'s `checkAndTrigger` pattern. A user opening the popover with a dead channel shouldn't see a button that errors or warns when clicked — just hide it. A user whose channel dies between popover open and click (edge case — requires manually `kill`ing Claude Code mid-hover) hits the click-time `isChannelAlive()` guard and the action silently no-ops.

## 33.3 Prompt assembly (`buildAskClaudePrompt`)

Pure helper in `src/client/terminalOsc133.ts`:

```ts
function buildAskClaudePrompt(input: {
  command: string;
  exitCode: number | null;
  cwd: string | null;
  output: string;
  maxOutputChars?: number;  // default 8000
}): string;
```

Template:

```
The command `$CMD` exited with code $N in `$CWD`. Output:

$OUTPUT

Please diagnose and propose a fix.
```

Variations (covered by unit tests):

- **`cwd` null or empty** — drop the `in \`$CWD\`` clause. The command line already tells Claude which command ran; the cwd is enrichment that should fail gracefully when OSC 7 (§29) hasn't fired yet.
- **`exitCode` null** — render "exited (no exit code reported)" instead of "exited with code N". Happens when the shell emits D without a numeric payload (HS-7267 neutral-glyph path).
- **`output` empty** — replace the fenced block with `*(no output captured)*` so Claude knows the command genuinely had no output (not that we failed to read it).
- **`output` over `maxOutputChars`** — truncate to the LAST `maxOutputChars` characters and prepend `[output truncated to last N chars]`. The tail is more valuable than the head — failing commands typically fail at the end — and the cap keeps the channel payload bounded. Default `maxOutputChars = 8000` (about 2 000 tokens) picks a comfortable triage size.

## 33.4 Click action (`askClaudeAboutRecord`)

```ts
function askClaudeAboutRecord(inst: TerminalInstance, term: XTerm, record: CommandRecord): void {
  if (!isChannelAlive()) return;                  // 1. re-check gate
  const command = readRecordCommand(term, record); // 2. B→C text
  if (command === null) return;                    // silent no-op when unreadable
  const output = readRecordOutput(term, record) ?? ''; // 3. C→D text (empty if unreadable)
  const prompt = buildAskClaudePrompt({
    command,
    exitCode: record.exitCode,
    cwd: inst.runtimeCwd,                          // 4. OSC 7 cwd if known, else null
    output,
  });
  triggerChannelAndMarkBusy(prompt);               // 5. fire channel
}
```

Steps 2 and 3 use the Phase 2 helpers (§32.3). `inst.runtimeCwd` is the OSC 7 CWD from HS-7262 (§29) — non-null when the shell has emitted `\e]7;file://host/path\a` at least once, null otherwise.

`triggerChannelAndMarkBusy(message)` is the existing export from `channelUI.tsx` (line 232). It POSTs `/api/channel/trigger` with `{ message }` and flips the busy-indicator pulse; the channel server delivers the message to the sidecar MCP client the next time it polls (see [12-claude-channel.md](12-claude-channel.md)).

Silent no-op paths:

- Channel died between popover open and click → `isChannelAlive()` returns false, return.
- Shell skipped B, or B/C scrollback-trimmed → `readRecordCommand` returns null, return.
- Output unreadable but command readable → use empty-string output (`readRecordOutput(...) ?? ''`) and let `buildAskClaudePrompt` emit the `*(no output captured)*` placeholder. Claude can still help from just the command + exit code.

## 33.5 Out of scope

- **`shell_analysis` command-log entry.** The design doc (§26.6 Phase 3) mentioned "Optional: emit a `shell_analysis` entry in the command log (§14) so the analysis is revisitable." Deferred — the MCP channel's delivery path already logs the trigger + Claude's response in the existing command log; adding a separate `shell_analysis` event type requires a new `direction` / `event_type` enum value, server changes, and command-log renderer changes without obvious user-facing payoff (the channel log already shows what Claude said). Follow-up HS-7332 if users want a dedicated view.
- **Customizable prompt template.** Some users will want to swap the fix-it prompt for a learn-more / explain-this phrasing. Could ship as a per-project setting wrapping a template-with-placeholders. Not shipping with v1 — the single diagnose-and-fix prompt covers the 90% case and we don't want to design the template-variable syntax up-front.
- **Attach scrollback context beyond the single command.** Claude often wants to see the commands leading up to the failure. Out of scope — the user can run Copy command / Copy output on prior records and paste context manually. A future "Ask with context of previous N commands" popover option is possible but adds complexity.
- **Route the response into a ticket.** A user who wants a persistent record of Claude's fix proposal can open a ticket manually and paste. An `Ask Claude and file-as-ticket` action is a natural Phase 4 but we're closing the OSC 133 rollout at Phase 3.

## 33.6 Testing

### Unit tests (`src/client/terminalOsc133.test.ts`)

9 new cases in `describe('buildAskClaudePrompt (HS-7270)')` cover:

- Full template with cwd, exit code, and output.
- Null cwd drops the "in `...`" clause.
- Empty-string cwd also drops the clause.
- Null exit code renders "(no exit code reported)".
- Empty output → `*(no output captured)*` placeholder, no fenced block.
- Output over cap → tail-truncated with `[output truncated to last N chars]` header.
- Output at exact cap → not truncated.
- Default `maxOutputChars = 8000` applied when caller omits it.
- Successful (exit 0) commands still render "exited with code 0" (user asking "why did this succeed as expected" is valid).

### E2E (HS-7332)

Playwright coverage shipped in `e2e/terminal-osc133-ask-claude.spec.ts` against the shared `terminal-osc133.sh` fixture in `MODE=fail` (one OSC 133 prompt cycle whose D mark carries a non-zero exit code so the gutter renders a red-X glyph and the popover is the typical Ask Claude scenario). Two tests:

1. **Channel alive** — `page.route(/\/api\/channel\/status/)` returns `{enabled:true, alive:true}`; `page.route(/\/api\/channel\/trigger/)` short-circuits the POST and pushes the body onto `window.__channelTriggers`; `page.route(/\/api\/ensure-skills/)` no-ops the secondary endpoint the trigger flow hits. The fixture emits `false` with `EXIT_CODE=7` and `OUTPUT=phase3-ask-claude-marker`. Test waits for the marker + READY in `.xterm-screen`, asserts the gutter glyph is `.terminal-osc133-gutter-failure`, hovers it, asserts the popover surfaces the `[data-action="ask-claude"]` button, clicks it, and asserts `/api/channel/trigger` was called exactly once with a `message` body containing the failing command (`false`), the exit code (`exited with code 7`), and the output snippet (`phase3-ask-claude-marker`). Asserting the rendered template by piece (rather than exact-string match) keeps the test resilient to prompt template tweaks.
2. **Channel dead** — same fixture + setup but `page.route(/\/api\/channel\/status/)` returns `{enabled:true, alive:false}`. Hover the glyph, assert the popover surfaces with the three other buttons (Copy command / Copy output / Rerun) but `[data-action="ask-claude"]` count is `0` — the popover's open-time gate keeps the button out of the DOM entirely when `isChannelAlive()` returns false.

Route stubs use regex literals (e.g. `/\/api\/channel\/status/`) rather than glob patterns because the API URLs include a `?project=<secret>` query string and the glob `**` doesn't reliably match across `?` in Playwright route patterns; the regex is unambiguous.

The "channel alive" test waits 500 ms after page load before hovering — initChannel fires the `/api/channel/status` fetch asynchronously and `channelAliveLocal` only flips after the promise resolves, so the popover's `isChannelAlive()` gate would read `false` if hovered too soon.

## 33.7 Manual test plan (add to `docs/manual-test-plan.md` §26)

- Connect Claude Code to Hot Sheet (green channel dot visible). In a shell-integrated drawer terminal, run `false` (exits 1).
- Hover the red-X gutter glyph — popover shows Copy command / Copy output / Rerun / **Ask Claude** (accent-colored).
- Click **Ask Claude** — the channel dot pulses, and within a few seconds Claude responds in the Commands Log panel diagnosing the `false` exit.
- Run a long-output failing command (`for i in $(seq 1 1000); do echo line $i; done; false`). Ask Claude → the prompt truncates to the last 8 000 chars (visible in the Commands Log entry).
- Disconnect Claude Code (`Ctrl+C` the MCP client). Re-open the popover on any glyph — the Ask Claude button is now absent. Copy command / Copy output / Rerun still work.
- Reconnect Claude Code. Re-open the popover — Ask Claude reappears.

## 33.8 Cross-references

- [26-shell-integration-osc133.md](26-shell-integration-osc133.md) §26.6 Phase 3 — design reference.
- [31-osc133-copy-last-output.md](31-osc133-copy-last-output.md) — Phase 1b sibling.
- [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md) — Phase 2 sibling (popover infrastructure).
- [12-claude-channel.md](12-claude-channel.md) — channel delivery path.
- [29-osc7-cwd-tracking.md](29-osc7-cwd-tracking.md) — source of `inst.runtimeCwd`.
- `src/client/terminalOsc133.ts` — `buildAskClaudePrompt` pure helper.
- `src/client/terminal.tsx` — `askClaudeAboutRecord`, popover Ask-Claude button wiring.
- `src/client/channelUI.tsx` — `isChannelAlive`, `triggerChannelAndMarkBusy`.
- `src/client/styles.scss` — `.terminal-osc133-popover-ask` accent styling.
- **Tickets:** HS-7270 (this doc), HS-7267 / HS-7268 / HS-7269 (prior phases), HS-7332 (Playwright e2e — shipped, see §33.6 E2E; the optional `shell_analysis` command-log entry remains deferred per §33.5 — no user-facing value over the channel log already capturing the trigger).
