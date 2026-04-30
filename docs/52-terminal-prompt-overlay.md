# 52. Terminal Permission-Prompt Overlay

HS-7971. Surface interactive prompts emitted by tools running inside the embedded terminal ([22-terminal.md](22-terminal.md)) — chiefly Claude Code's startup safety prompts, MCP-relay-bypassed permission asks, and similar `1/2`-style choice screens — through a Hot Sheet overlay so the user can answer with the mouse + keyboard without having to type back into the raw PTY.

> **Status:** Shipped — Phase 1 + 1.5 + 2 + 3 + 4 (HS-7971 + HS-7980 + HS-7985 + HS-7986 + HS-7987 + HS-7988). All design sections of §52 are implemented.
>
> Phase 1 covers detection + claude-numbered parser + Allow / Cancel + multi-line diff context (HS-7980). Phase 1.5 (HS-7985) extends the overlay to the dashboard / drawer-grid dedicated views with a per-view detector. Phase 2 (HS-7986) adds the yes/no parser, the generic-fallback overlay (verbatim monospaced reproduction + free-form textarea), and a terminal-header "Detection paused — Resume" chip. Phase 3 (HS-7987) adds the per-project `terminal_prompt_allow_rules` settings key, the auto-allow gate that bypasses the overlay when a matching rule exists, the always-allow checkbox in numbered + yesno overlays (NEVER generic), and the `POST /api/terminal-prompt/audit` endpoint that records auto-allowed responses to the command log as `terminal_prompt_auto_allow` events. Phase 4 (HS-7988) adds the Settings → Permissions sub-section listing every rule (read-only, with delete affordance) plus the `terminal_prompt_detection_enabled` master toggle that short-circuits the detector entirely when off (rules render greyed-out for review).

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
> **HS-8034 Phase 2 (2026-04-30):** allow-rule helpers also moved to shared (`src/shared/terminalPrompt/allowRules.ts`) so the server-side auto-allow gate can call `findMatchingAllowRule` + `payloadForAutoAllow` directly. Bell-state long-poll (`GET /api/projects/bell-state`) extended with a per-project `pendingPrompts: { [terminalId]: MatchResult }` map so the client surfaces matches without per-project websockets. The auto-allow gate runs server-side in `registry.ts::handleScannerMatch` — when a rule matches, the response payload is written directly to the PTY, an audit-log entry is appended, and `pendingPrompt` stays null so no overlay surfaces (works even when no client is connected). New endpoints `POST /api/terminal/prompt-respond` (apply user response + clear pendingPrompt + wake waiters), `POST /api/terminal/prompt-dismiss` (clear pendingPrompt, optionally `suppress: true` to flip the scanner's "Not a prompt" state), `POST /api/terminal/prompt-resume` (clear suppression). Client-side `bellPoll.tsx::dispatchPendingPrompts` watches every long-poll tick for fresh `(secret, terminalId, signature)` triples and opens the existing `terminalPromptOverlay.tsx` anchored to the affected project tab cross-project (HS-8012 anchor mechanic). Generic-shape matches deliberately skip the cross-project overlay (low confidence; would interrupt other-project work) — they stay in `pendingPrompts` and a future per-project surfacing pass can decide what to do. **The client-side detector (`src/client/terminalPrompt/detector.ts`) continues to drive the overlay UI in parallel for safety; HS-8035 follow-up deletes it once the server-side path proves out.**

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
