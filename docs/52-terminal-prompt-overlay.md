# 52. Terminal Permission-Prompt Overlay

HS-7971. Surface interactive prompts emitted by tools running inside the embedded terminal ([22-terminal.md](22-terminal.md)) — chiefly Claude Code's startup safety prompts, MCP-relay-bypassed permission asks, and similar `1/2`-style choice screens — through a Hot Sheet overlay so the user can answer with the mouse + keyboard without having to type back into the raw PTY.

> **Status:** Shipped — Phase 1 + 1.5 + 2 + 3 + 4 (HS-7971 + HS-7980 + HS-7985 + HS-7986 + HS-7987 + HS-7988). All design sections of §52 are implemented.
>
> Phase 1 covers detection + claude-numbered parser + Allow / Cancel + multi-line diff context (HS-7980). Phase 1.5 (HS-7985) extends the overlay to the dashboard / drawer-grid dedicated views with a per-view detector. Phase 2 (HS-7986) adds the yes/no parser, the generic-fallback overlay (verbatim monospaced reproduction + free-form textarea), and a terminal-header "Detection paused — Resume" chip. Phase 3 (HS-7987) adds the per-project `terminal_prompt_allow_rules` settings key, the auto-allow gate that bypasses the overlay when a matching rule exists, the always-allow checkbox in numbered + yesno overlays (NEVER generic), and the `POST /api/terminal-prompt/audit` endpoint that records auto-allowed responses to the command log as `terminal_prompt_auto_allow` events. Phase 4 (HS-7988) adds the Settings → Permissions sub-section listing every rule (read-only, with delete affordance) plus the `terminal_prompt_detection_enabled` master toggle that short-circuits the detector entirely when off (rules render greyed-out for review).
>
> **HS-8050 (2026-05-01) — questionLines context cap.** Pre-fix the parser walked from the question region all the way back to row 0 of the visible scan window, capturing every line above the prompt as framed-context content. With claude code's TUI rendering its own decorations (status bars, "Listening for channel messages..." pre-amble, the `?` for shortcuts help line, etc.) in the same buffer that contains the prompt, the framed `<pre>` block in the overlay ended up showing the legitimate prompt body **plus** a chunk of post-prompt TUI noise (user's own description: "everything after 'Experimental ...' is just the claude code prompt decorations and input"). The fix adds two stopping conditions to the upward walk in `claudeNumberedParser.match`: (a) stop at any run of 2+ consecutive blank rows (visual section break — inline diffs use a single blank as a separator, so the HS-7980 diff fixture still works), and (b) hard-cap at `MAX_QUESTION_CONTEXT_ROWS = 15`. 4 new unit tests in `parsers.test.ts` cover the section-break stop, single-blank diff preservation, the 15-row cap, and a regression guard that the canonical dev-channels fixture still parses identically.
>
> **HS-8037 (2026-04-30) — title / context redundancy fix.** Pre-fix the overlay's title bar joined every line of `questionLines` with spaces (so the `--dangerously-load-development-channels` warning surfaced as `"WARNING: Loading development channels --dangerously-load-development-channels … server:hotsheet-channel"`), and the framed `<pre>` context block right below repeated the same content verbatim — the same paragraph appeared twice. The parser's `claudeNumberedParser` now picks a single useful title line via the new `pickTitleLine()` helper: the trailing `?` line if any (HS-7980 diff prompts where the question lives below the diff), otherwise the first non-blank, non-decorative line (warning prompts where the heading lives above the body). The overlay's `openNumberedOverlay` runs `stripContextLines(questionLines, title)` (also new — uses `isDecorativeLine()` to drop pure box-drawing / horizontal-rule rows) before joining for the framed block, and only renders the block when content remains after the strip. Net effect for the dev-channels prompt: title shows `"WARNING: Loading development channels"`, framed block shows the explanatory paragraph + channels line, and the heading isn't duplicated.

## 52.1 Problem statement

Today, when Claude Code (or any other interactive CLI run from a Hot Sheet terminal) renders a numbered-choice or yes/no prompt directly inside the PTY, the user has to:

1. Click into the embedded terminal to focus it.
2. Read the rendered Ink/blessed UI.
3. Press the right keys (arrow + Enter, or `1`+Enter, or `y`+Enter).

The §12.10 / §47 permission overlay only covers prompts that flow through the **MCP permission relay** — i.e. tools Claude calls from inside an active session that has an MCP-connected `hotsheet-channel`. Prompts emitted **before** the MCP channel is up — e.g. the `--dangerously-load-development-channels` warning the screenshot in HS-7971 captures — never reach the relay; the user has to interact with them inside the terminal pane directly.

Two costs:

- **UX inconsistency.** Some Claude prompts surface as a tab-anchored popup (MCP-relayed), others surface as Ink renders inside the PTY (pre-MCP, plus any terminal-side `claude` interaction without a live MCP session). The user has to know which is which.
- **No always-allow shortcut.** The MCP popup has the §47.4 allow-list. Terminal prompts are clicked-through every time, every project, by hand.

HS-6602 considered "scrape terminal output for non-MCP prompts" and **rejected** it as too brittle (terminal-markup variance, prompt-format drift, races during Ink redraws). HS-7971 reverses that decision after the user observed the dev-channels warning in real use and asked for parity. This design accepts the brittleness and builds in mitigations rather than ducking the surface area.

## 52.2 Scope

**In scope.**
- Detect interactive prompts in the embedded terminal's output buffer and surface a Hot Sheet overlay anchored to the terminal pane.
- Bundled parsers for two well-known shapes — Claude-Ink **numbered choice list** (`> 1. Foo / 2. Bar / Enter to confirm · Esc to cancel`) and **yes/no** prompts (`(y/n)`, `(Y/n)`, `[y/N]`).
- **Generic fallback** when detection fires but no parser matches: render a monospaced reproduction of the prompt's last visible lines and let the user type any string + send.
- Per-project **always-allow** (rule keyed on `parser_id + canonical-signature`) modeled on §47.4 and reusing `<dataDir>/settings.json`.
- Settings → Permissions tab gains a "Terminal prompts" sub-section listing terminal-prompt allow rules + a global enable/disable toggle.

**Out of scope.**
- Pager prompts (`less`, `more`, `(--More--)`, `:`). They aren't permission asks; surfacing an overlay would be obnoxious.
- Shell-builtin prompts (`read -p`, bash `select`, fish's `read`). Same reason.
- Generic "press Enter to continue" sentinel detection — too broad, high false-positive risk, low value.
- Sending the user's overlay response **anywhere except the PTY that currently has focus**. We deliberately do NOT forward responses cross-terminal.
- Auto-deny rules. Same reasoning as §47.2 — Claude Code already supports per-tool deny lists.

## 52.3 Detection layer

### 52.3.1 Where to hook

The hook attaches to the WebSocket message handler in [`src/client/terminal.tsx`](../src/client/terminal.tsx) (the `ws.addEventListener('message', …)` path that calls `inst.term.write(...)`). After `term.write()` lands a chunk into xterm's in-memory buffer, schedule a **debounced** scan (≈ 100 ms idle) of the last 10 visible buffer rows via `term.buffer.active.getLine(i).translateToString()`.

Scanning the rendered buffer (rather than the raw PTY byte stream) means the detector sees text **after** xterm has resolved cursor moves, partial redraws, and ANSI styling. That's the only sane substrate for heuristic parsing — the raw stream is full of `\x1b[2K\x1b[1G\x1b[?25l` noise that wraps Ink's redraws.

A `serializeAddon` is already wired to xterm for replay; the detector reuses the buffer-row API rather than re-serialising on every tick.

### 52.3.2 Trigger conditions

A scan fires when:

- 100 ms have passed since the last `ws.message` write event for the instance, AND
- The terminal is the **active** drawer / dashboard pane (we don't surface overlays for background terminals — too noisy and the user can't see what they're answering).

The parser registry runs against the buffer slice. The first parser whose `match()` returns non-null wins. If no parser matches but the detector's heuristic-only signal fires (see §52.3.3), the **generic fallback** parser is used.

### 52.3.3 Heuristic-only signal

When no specific parser matches but one of these strong fingerprints is present in the last visible rows, the generic fallback fires:

- Trailing line equals one of: `Enter to confirm · Esc to cancel`, `Enter to confirm`, `Press Enter to continue`, `[y/n]`, `(y/n)`, `(Y/n)`, `[Y/n]`, `[y/N]`.
- Cursor at end of a line ending in `?`.

False-positive mitigation:

- **Footer must be on the very last non-empty row** of the visible buffer slice — not anywhere else. Reading docs that quote `Enter to confirm` mid-screen won't fire.
- **Project-level kill switch** in Settings (`terminal_prompt_overlay_enabled`, default `true`). Power users who hit false positives can flip it off.
- **Per-instance suppression**. After the user dismisses an overlay via "Not a prompt — let me handle it", we suppress further detector firings for that terminal until the next user keystroke into it.
- **Never auto-respond from the heuristic signal.** Always-allow is gated to *parsed* matches (signature is well-defined). Generic-fallback overlays always require a click.

## 52.4 Parser registry

> **HS-8029 Phase 1 (2026-04-30):** the parser registry **moved** from `src/client/terminalPrompt/parsers.ts` to `src/shared/terminalPrompt/parsers.ts` so the new server-side scanner (`src/terminals/promptScanner.ts`) can import it. The shape, the 32 unit tests, and every `parsers.*` import site are unchanged — only the path moved.
>
> **HS-8034 Phase 2 (2026-04-30):** allow-rule helpers also moved to shared (`src/shared/terminalPrompt/allowRules.ts`) so the server-side auto-allow gate can call `findMatchingAllowRule` + `payloadForAutoAllow` directly. Bell-state long-poll (`GET /api/projects/bell-state`) extended with a per-project `pendingPrompts: { [terminalId]: MatchResult }` map so the client surfaces matches without per-project websockets. The auto-allow gate runs server-side in `registry.ts::handleScannerMatch` — when a rule matches, the response payload is written directly to the PTY, an audit-log entry is appended, and `pendingPrompt` stays null so no overlay surfaces (works even when no client is connected). New endpoints `POST /api/terminal/prompt-respond` (apply user response + clear pendingPrompt + wake waiters), `POST /api/terminal/prompt-dismiss` (clear pendingPrompt, optionally `suppress: true` to flip the scanner's "Not a prompt" state), `POST /api/terminal/prompt-resume` (clear suppression). Client-side `bellPoll.tsx::dispatchPendingPrompts` watches every long-poll tick for fresh `(secret, terminalId, signature)` triples and opens the existing `terminalPromptOverlay.tsx` anchored to the affected project tab cross-project (HS-8012 anchor mechanic). Generic-shape matches deliberately skip the cross-project overlay (low confidence; would interrupt other-project work) — they stay in `pendingPrompts` and a future per-project surfacing pass can decide what to do.
>
> **HS-8047 follow-up (2026-05-01):** `dispatchPendingPrompts` now serializes overlays through a single `activeOverlayKey` slot. Pre-fix, when several projects each had a pending prompt on the same long-poll tick (the common shape on app launch when multiple `claude` instances were parked at the WARNING-loading-development-channels prompt), the dispatcher iterated the bell-state map and called `openTerminalPromptOverlay` once per project. That helper does `document.querySelectorAll('.terminal-prompt-overlay').forEach(el => el.remove())` before mounting — so each subsequent project's overlay obliterated the previous project's overlay without going through `onClose`. The user reported "popups flash by one after another and only the last one stays — and after I approve it none of the others ever come back, I have to switch terminals and press 1+enter manually." The earlier projects' signatures had been written to `lastDispatchedPromptSignatures` during the brief flash, so subsequent ticks treated them as "already dispatched" and the overlays never re-surfaced. Fix mirrors the `permission-popup` (`activePopupRequestId`) pattern: `dispatchPendingPrompts` now collects candidates, sorts by `secret::terminalId` for deterministic ordering, and opens at most one overlay; subsequent ticks pick up the next candidate after the active overlay closes (`onClose` clears `activeOverlayKey`). Also tears down a stale active overlay if its underlying server-side prompt cleared (user responded via terminal directly), and re-fires when the same key gets a new signature (program re-asked with different content). 7 new happy-dom unit tests in `src/client/bellPoll.test.ts`; the existing 4-test `e2e/terminal-prompt-cross-project.spec.ts` Playwright spec continues to cover the live cross-project response wiring.
>
> **HS-8057 (2026-05-01):** "Always choose this" wasn't being remembered for cross-project prompts. Pre-fix `appendAllowRule(rule)` in `src/client/terminalPrompt/allowRulesStore.ts` always called `api('/file-settings', ...)` which uses the active project's secret from the global store. But cross-project prompts (HS-8047) come from projects OTHER than the active one — the user's screenshot showed a Hot Sheet project parked at the dev-channels WARNING while the user was active on a different tab. The server-side scanner gate at `src/terminals/registry.ts::findMatchingRuleForProject` reads each project's `terminal_prompt_allow_rules` via its own `dataDir`, so a rule written into the wrong project never matched the originating project's prompt and the WARNING re-surfaced on every restart. Fix: `appendAllowRule(rule, secret?)` accepts an optional originating-project secret and routes through `apiWithSecret('/file-settings', secret, ...)` when provided, skipping the global in-memory cache update (the cache only tracks the active project's rules so the Settings UI for the originating project re-hydrates on next open). `bellPoll.tsx::openCrossProjectOverlay::onAddAllowRule` now forwards the per-prompt `secret` so the rule lands in the originating project's `<dataDir>/settings.json`. `removeAllowRule(id, secret?)` got the same secret parameter for symmetry (no current call site uses it). 4 new unit tests cover the cross-project secret routing in `allowRulesStore.test.ts` (3 cases: cross-project routes through apiWithSecret, cache is NOT updated for cross-project writes, omitted secret keeps active-project back-compat) + 1 in `bellPoll.test.ts` (integration: clicking "Always choose this" + a choice on a cross-project overlay produces fetch calls to `/api/file-settings` carrying the originating project's `X-Hotsheet-Secret` header).
>
> **HS-8067 (2026-05-01):** the §52 overlay's footer gained Minimize / "No response needed" links, bringing it up to feature parity with §47's `permission-popup`. Pre-fix the only dismissal paths were the Cancel button (sends `\x1b` to the PTY) and the X close button (calls `onClose` which posts `/terminal/prompt-dismiss`); there was no way to defer a prompt for later or to silence one without sending input. Implementation: `OpenTerminalPromptOverlayOptions` gained optional `onMinimize` and `onNoResponseNeeded` callbacks; `wireSharedOverlay` refactored to expose `tearDownDom()` separately from `close()` so the new paths can dismantle the DOM without firing `onClose`'s server-dismiss POST. `bellPoll.tsx::openCrossProjectOverlay` provides both callbacks: Minimize stores `(secret, terminalId, match, sig, timeoutId)` in the new `minimizedTerminalPrompts` map (2-min auto-dismiss timeout matching §47's `MINIMIZED_TIMEOUT_MS`); No-response-needed adds the key to `dismissedTerminalPromptKeys` AND posts `/terminal/prompt-dismiss` so the server stops bell-ing. The dispatcher's three new gates: skip when `minimizedTerminalPrompts.has(key)`, skip when `dismissedTerminalPromptKeys.has(key)`, prune both maps when the server clears the pending entry (so a fresh prompt re-fires). New `reopenMinimizedTerminalPromptForSecret(secret)` exported function mirrors §47's `reopenMinimizedForSecret`; `projectTabs.tsx`'s tab-click handler calls both so a click on a project tab with either a minimized permission popup OR a minimized terminal prompt brings it back. SCSS adds `.terminal-prompt-overlay-links` / `-links-sep` / `-minimize-link` / `-dismiss-link` mirroring `.permission-popup-links`. 5 new unit tests in `terminalPromptOverlay.test.ts` (link rendering + click-fires-callback + DOM-tear-down + onClose-NOT-called); 5 new dispatcher tests in `bellPoll.test.ts` (Minimize → bookkeeping + skip-on-next-tick, reopen restores, no-response → dismissed-set + skip-on-fresh-sig, both maps prune on server-clears).
>
> **HS-8068 (2026-05-01):** §52 overlay's header gained a tool-name chip (`Claude` / `Shell` / hidden for generic) mirroring §47's `permission-popup-tool` chip. Helper `sourceLabelForMatch(match)` derives the chip text from `match.parserId`: `claude-numbered` → `Claude`, `yesno` → `Shell`, `generic` → `null` (chip suppressed; generic prompts are heuristic-fired fallbacks with no meaningful source name). Unknown parser ids fall back to the raw id rather than hiding the chip so a future misconfiguration is visible in QA. SCSS: new `.terminal-prompt-overlay-tool` selector with the same treatment as `.permission-popup-tool`; header switched from `justify-content: space-between` → `flex-wrap: wrap`; `.terminal-prompt-overlay-title` lost its `font-weight: 600` and gained `color: var(--text-muted)` so the chip carries the bold weight (matches §47's pattern where the tool name is bold and the description is muted). 4 new unit tests pin the mapping + DOM presence per shape.
>
> **HS-8035 (2026-04-30):** the parallel client-side detector path is now **deleted**. `src/client/terminalPrompt/detector.ts` + `detector.test.ts` + `src/client/terminalPrompt/autoAllow.ts` are gone; `src/client/terminal.tsx` and `src/client/terminalTileGrid.tsx` lost their `kickPromptDetector` / `notifyChunk` / `notifyUserKeystroke` / `disposeDetector` wiring + the `inst.promptDetector` field on `TerminalInstance`. The terminal-toolbar `.terminal-prompt-resume-chip` now POSTs `/api/terminal/prompt-resume` instead of clearing in-process detector suppression. The 6 deleted client-side detector tests are subsumed by the 15 server-side `src/terminals/promptScanner.test.ts` tests already shipped in HS-8029. Cross-project regression coverage lives in the new `e2e/terminal-prompt-cross-project.spec.ts` Playwright spec (numbered prompt from a non-active project surfaces + responds via `apiWithSecret('/terminal/prompt-respond')`; generic-shape pendingPrompts deliberately do NOT auto-surface).

A new module `src/shared/terminalPrompt/parsers.ts` (subdirectory because parsers + types + matcher form a small family of files):

```ts
interface PromptParser {
  id: string;                                  // 'claude-numbered' | 'yesno' | 'generic'
  match(rows: readonly string[]): MatchResult | null;
}

interface MatchResult {
  question: string;       // human-readable lead-in (e.g. "Loading development channels — confirm action")
  signature: string;      // canonical id for always-allow keying (parser_id + question hash)
  shape: 'numbered' | 'yesno' | 'generic';
  choices?: ChoiceOption[];
  rawText?: string;       // generic shape only — exact monospaced last-N rows
  /** Compute the keystroke payload to send to the PTY for the given choice. */
  payloadFor(choice: ChoiceOption | { kind: 'free'; text: string }): Uint8Array;
}

interface ChoiceOption {
  index: number;                // 0-based position in the rendered list
  label: string;                // "I am using this for local development"
  highlighted: boolean;         // true if this option currently has the `>` cursor
}
```

Bundled v1 parsers, in registry order:

1. **`claude-numbered`** — last 10 rows contain
   - `Enter to confirm · Esc to cancel` on the trailing non-empty row
   - One or more `^(\s*[>❯▶►]?\s*)\d+\.\s+(.+)$` rows above it
   - The leading cursor (any of `>`, `❯`, `▶`, `►`) marks the highlighted option. Modern Claude Code builds render the cursor as `❯` (U+276F); pre-HS-7995 the parser only recognised the legacy ASCII `>` and silently dropped the highlighted row, so prompts with two options never met the ≥ 2 contiguous-choice threshold and the overlay never surfaced.
   `payloadFor({index})` emits `(\x1b[B){index − highlightedIndex}\r` for forward / `(\x1b[A){...}\r` for backward, then `\r`. The Esc fallback writes `\x1b`.

2. **`yesno`** — last visible row matches `/[\(\[][YyNn]\/[YyNn][\)\]]\s*$/`. Emits `y\r` or `n\r` matching the surface case (preserves `Y` vs `y`).

3. **`generic`** — fallback when the heuristic signal fires (§52.3.3) but neither specific parser matches. Returns `shape: 'generic'`, `rawText` = last 10 visible rows verbatim. `payloadFor({kind: 'free', text})` emits `${text}\r`.

The registry is pluggable so a future ticket can add parsers (apt's `[Y/n/?]`, npm's `Ok to proceed?`, fzf-style menus, etc.) without rewriting detection.

## 52.5 Overlay UI

A new component `src/client/terminalPromptOverlay.tsx`. The overlay is mounted on `document.body` with `position: fixed` and **anchored below the active project tab** matching the terminal's project secret — same spatial convention as the channel-permission popup (`.permission-popup`). When the project tab isn't visible (dashboard mode hides project tabs) the overlay falls back to a top-center position. It is **non-modal** (matches §47 popup convention) so the user can keep working in other tabs.

(Phase 1's original layout anchored the overlay inside the terminal pane via `position: absolute; bottom: 12px; left: 12px;` — the user found the in-drawer position visually confusing and wanted all "Hot Sheet wants you to answer something" popups to share one location. HS-8012 moved it to the project-tab anchor so this overlay and `.permission-popup` open in the same place.)

Layout per shape:

- **Numbered.** Question (one line, monospace). Vertical list of clickable rows — the highlighted option carries a tinted background to mirror the `❯` / `>` cursor. Pressing the row sends the payload + closes the overlay. Footer: "Always allow this answer" checkbox + "Cancel" link (writes `\x1b` to the PTY).
- **Yes/no.** Question. Two big buttons (Yes = green, No = red, accent-checked colours from existing `permission-popup-allow` / `-deny`). Same footer.
- **Generic.** Monospaced `<pre>` reproducing `rawText` (max-height 240 px, scrollable). Single-line `<input type="text">` with placeholder "Type your response, then press Enter". Submit button. **Always-allow checkbox is hidden** — generic responses don't have a stable signature.

Shared elements: dismiss link "Not a prompt — let me handle it" (suppresses further detector firings for this terminal until the user types into it), close X (writes nothing, just hides — re-fires next scan).

Styling: SCSS in `_terminal_prompt_overlay.scss` partial. Reuse `--accent`, `permission-popup` colour tokens for visual consistency.

## 52.6 Write-back path

`inst.ws.send(payload)` reuses the same code path as `term.onData` (terminal.tsx:984). The detector hands the overlay a callback bound to the originating instance — the response always lands in the PTY that emitted the prompt, never anywhere else.

If the WebSocket dropped between detection and response, the overlay shows an inline error ("Terminal disconnected — couldn't send response") and re-arms detection on reconnect.

## 52.7 Always-allow integration

### 52.7.1 Settings schema

Per-project, in `<dataDir>/settings.json`:

```jsonc
{
  "terminal_prompt_allow_rules": [
    {
      "id": "01J...",
      "parser_id": "claude-numbered",
      "signature": "claude-numbered:dev-channels-warning:choice-1",
      "response_payload_b64": "DQ==",            // base64-encoded "\r"
      "human_label": "Confirm 'I am using this for local development' on dev-channels warning",
      "added_at": "2026-04-28T...",
      "added_by": "overlay"
    }
  ]
}
```

`signature` is `parser_id + ":" + hash(canonical-question-text) + ":" + chosen-option-index` so a rule auto-allows the **same answer to the same question** but never silently auto-answers a *different* numbered prompt that happens to share a parser id.

`response_payload_b64` stores the literal byte sequence to write — base64 because it can include `\x1b`, control bytes, etc. `human_label` is the display string in the management UI.

Adds `terminal_prompt_allow_rules` to `JSON_VALUE_KEYS` in `src/file-settings.ts` (matches §47.4.1 precedent).

### 52.7.2 Auto-allow gating

When the detector matches a parsed prompt (numbered or yesno only — never generic), it checks `terminal_prompt_allow_rules` for a signature match **before** rendering the overlay. On match, the response payload is written to the PTY immediately; the overlay never appears; an entry is appended to `command_log` with summary `Terminal prompt: <human_label> — Auto-allowed (rule <id>)`. Mirrors §47.4.2's audit trail.

If the rule's payload would be invalid for the current parsed shape (e.g. stored `(\x1b[B)\r` but the prompt now has only one option), skip the auto-allow and surface the overlay normally.

### 52.7.3 Settings UI

Settings → Permissions gains a sibling sub-section beside the §47.4 MCP allow-list:

- **Terminal prompt overlay** master toggle (`terminal_prompt_overlay_enabled`, default `true`). When off, the detector is fully disabled.
- **Terminal-prompt allow rules** table. Columns: `human_label`, `parser_id`, `added_at`, `added_by`, Delete.
- No "+ Add" affordance from settings — terminal-prompt rules are **only created from the overlay's "Always allow" checkbox**. There's no usable way to hand-author a `signature` + `response_payload` pair.

## 52.8 Security model

Inherits §47.5's threat surface (compromised dataDir, audit trail via `command_log`, per-project isolation) with two delta concerns specific to terminal prompts:

- **PTY response injection.** The auto-allow path writes literal bytes to the PTY without user confirmation. *Mitigation:* response payload comes from a base64-encoded value the user explicitly chose at rule-creation time — no pattern templating, no variable interpolation. The rule's `signature` must match exactly (full hash collision required) before the payload is replayed.
- **Heuristic false-positives writing into shells.** A docs file containing the text `Enter to confirm · Esc to cancel` mid-paragraph could trick the detector. *Mitigation:* footer-must-be-trailing constraint (§52.3.3) + master toggle + the always-allow path is gated to *parsed* matches only — generic-fallback overlays never auto-respond, so a false-positive scan never writes anything to the PTY automatically.

## 52.9 Open questions

- **Should we surface overlays for background terminals?** Currently scoped out (§52.3.2). The user might want a tab-dot indicator like the bell-state, but rendering an answerable overlay in a non-visible terminal feels worse than waiting until they switch back.
- **Should generic-fallback responses be allow-listable too?** The signature would have to be the heuristic-trigger-text hash. Workable but risks the false-positive class above. Defer until there's a concrete generic prompt the user wants to auto-respond to.
- **Does the dashboard's dedicated view need its own overlay anchor or can it reuse the drawer's?** Both render the same xterm instance. Same overlay, but anchor coordinates differ — rendering helper takes the visible canvas as input.
- **Do we need a `?signature=` debug surface in the UI** (hover the rule in Settings, see the captured prompt text the rule was created against)? Cheap; useful for debugging false hits. Probably yes for v1.

## 52.10 Implementation sequencing

The four phases are:

- **Phase 1 — Detection skeleton + Claude numbered parser + Allow/Cancel only (no always-allow).** Lands the parser-registry abstraction, the debounced buffer scan, the Claude-numbered parser, and the overlay's Allow/Cancel codepath for numbered prompts. Big enough to verify the detection layer end-to-end on the screenshot prompt.
- **Phase 1.5 — Dashboard + drawer-grid dedicated-view anchor (HS-7985).** Each dedicated view (created via `terminalTileGrid.tsx::enterDedicatedView`) lazy-creates its own per-view `Detector` keyed off the dedicated view's xterm + WebSocket; the overlay anchors to `.terminal-dashboard-dedicated-body` (or `.drawer-terminal-grid-dedicated-body`). The drawer's detector reads `hasOpenDedicatedTerminalView()` from `src/client/terminalDedicatedState.ts` so it stays silent while a dedicated view is open — guarantees one overlay per prompt across the multi-surface case. Grid tiles remain detector-free (too small for an overlay, and 50 tiles × 50 detectors would be wasteful).
- **Phase 2 — Yes/no parser + generic fallback + dismissible "Not a prompt" link (HS-7986).** Adds `yesNoParser` (matches `[y/n]`/`[Y/n]`/`(y/N)`/`[yes/no]` markers on the trailing line, false-positive-rejecting markdown / numbered-list / shell-comment lines), `genericParser` (trailing-`?` heuristic on the last visible line, last in registry priority), and the corresponding overlay shapes — `terminal-prompt-overlay-yesno` (two side-by-side green/red buttons, payload `y\r`/`n\r`) and `terminal-prompt-overlay-generic` (monospaced verbatim reproduction in a `<pre>` + free-form `<textarea>` + Submit/Cancel/"Not a prompt", Enter submits, Shift+Enter newline). Per-instance suppression UX: `clearDetectorSuppression` + `isDetectorSuppressed` exported from `detector.ts`; terminal header gains a `.terminal-prompt-resume-chip` shown when the user clicks "Not a prompt", click resumes detection without typing into the PTY.
- **Phase 3 — Always-allow rule storage + auto-allow gate + audit-log entry (HS-7987).** Adds `terminal_prompt_allow_rules` to `JSON_VALUE_KEYS` in `src/file-settings.ts`. Pure helpers in `src/client/terminalPrompt/allowRules.ts` (`parseAllowRules`, `findMatchingAllowRule`, `buildAllowRule` — generic-shape match throws). Async cache in `src/client/terminalPrompt/allowRulesStore.ts` (hydrated from `/file-settings` on app boot + every project switch via `reloadAppState`'s new `loadAllowRules()` call). Auto-allow gate `tryAutoAllow({match, send})` in `src/client/terminalPrompt/autoAllow.ts` runs BEFORE both detector callsites mount the overlay; on match it builds the payload via the existing `buildNumberedPayload` / `buildYesNoPayload` helpers, sends, and POSTs `/api/terminal-prompt/audit` (server route appends a `terminal_prompt_auto_allow` row to `command_log`). Always-allow checkbox lives between the choices and the footer in numbered + yesno overlays via `renderAllowRuleCheckbox(opts)` — never rendered for generic. Click → `onAddAllowRule(choiceIndex, choiceLabel)` → `appendAllowRule(buildAllowRule(...))` runs fire-and-forget alongside the response send.
- **Phase 4 — Settings → Permissions: Terminal Prompt sub-section + master toggle + delete affordance (HS-7988).** New "Terminal prompts" sub-section under Settings → Permissions, sibling to the existing §47 auto-allow rules section. Lists every rule from `terminal_prompt_allow_rules` with parser id + question preview + chosen-choice label + created date + delete button. New file-setting `terminal_prompt_detection_enabled: boolean` (default true) — flipping false short-circuits both detector callsites' `isActive()` so no parser runs; configured rules remain visible (greyed-out) for review. New client module `src/client/terminalPromptAllowListUI.tsx` (lazy-imported by `settingsDialog.tsx` when the Permissions tab is first opened, mirrors `permissionAllowListUI.tsx`). Subscribes to the store via `subscribeToAllowRules` so Phase 3's append-from-overlay path re-renders the list automatically.
- **HS-8106 — Settings rule-row layout: 2 visual lines per rule.** Pre-fix the rule row was a single grid with parser / question / choice / date / trash on one row; long question previews collapsed to "W A..." under the line-clamp because the question column couldn't hold the multi-line preamble. New layout — line 1 `[parser] [question single-line ellipsis]`, line 2 `[→ auto-response] · [created]`, with the trash button spanning both rows and `align-self: center` so it stays vertically centered regardless of how the question wraps. The wider question column lets the most useful field (the auto-response label) read at-a-glance instead of being hidden behind a tooltip.
- **HS-8071 — drift-resistant `choice_shape` fallback in `findMatchingAllowRule`.** Pre-fix the auto-allow gate matched only on `(parser_id, question_hash)`. When Claude TUI status-bar lines (`▶▶ accept edits on (shift+tab to cycle)`, `● high · /effort`, etc.) bled into the captured question region the hash drifted on a fraction of launches and the popup leaked through despite a saved rule. Fix: every new rule records a `choice_shape` field (pipe-joined lowercase-trimmed numbered labels, or the literal `yes|no` for yesno) in `buildAllowRule`. `findMatchingAllowRule` does a two-tier lookup — primary `(parser_id, question_hash)`, then fallback `(parser_id, choice_shape)` — so a hash-drifted match still recognises the prompt and auto-allows. Old rules without `choice_shape` keep their pre-fix behaviour (single-tier hash match); users can re-tick "Always allow this answer" to upgrade. Also: removed the always-redundant Cancel button from numbered / yesno / generic overlays per user feedback — Esc still cancels via the capture-phase keyboard handler in `mountShellWithEsc` and the X-close button on the shell header dismisses without sending.

Each implementation ticket should:

1. Update [22-terminal.md](22-terminal.md) and the §12 / §47 cross-references to point to this doc.
2. Update [docs/ai/code-summary.md](ai/code-summary.md) (new client modules, new settings keys).
3. Update [docs/ai/requirements-summary.md](ai/requirements-summary.md) — flip the §52 entry from Design → Partial / Shipped as phases land.

## 52.11 Parent / related

- HS-7971 — parent ticket; user feedback chose Option B (broad detection, parsing secondary, generic fallback for unparseable).
- HS-6602 — earlier investigation that **rejected** terminal scraping. This design overrides that decision; the rationale is in §52.1.
- [22-terminal.md](22-terminal.md) — embedded terminal architecture the detector hooks into.
- [12-claude-channel.md §12.10](12-claude-channel.md#1210-permission-relay) — sibling MCP-relayed permission popup (different transport, same overlay shape conventions).
- [47-richer-permission-overlay.md](47-richer-permission-overlay.md) — sibling allow-list design; §52.7 mirrors its settings shape and audit trail.
