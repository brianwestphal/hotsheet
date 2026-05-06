# 58. Channel Auto-Approve (known-channel allow-list)

HS-8210 — extend the §52 terminal-prompt always-allow path so the Claude Code `--dangerously-load-development-channels` startup prompt auto-approves on every subsequent launch once the user has confirmed it once. Today the prompt re-fires every `claude` startup and the user has to click Allow → "Always allow this answer" → choice-1 every time, despite §52.4's existing always-allow rules being in place — the rules drift across Claude version bumps (§52.4's HS-8071 four-tier matcher is the residue of repeated "the popup is still leaking through" iterations).

> **Status:** Shipped (HS-8211 / HS-8212 / HS-8213 / HS-8214 all landed 2026-05-06).

## 58.1 Problem statement

The `--dangerously-load-development-channels` prompt has a structural feature the existing `(parser_id, question_hash)` / `(parser_id, choice_shape)` / `(parser_id, question_preview)` / `(parser_id, choice_label)` matchers don't exploit: the **channel name** is rendered verbatim inside the prompt body, in a stable line shape:

```
Channels: server:hotsheet-channel
```

That line carries the user's actual *intent* — "I trust this specific channel" — independent of the rest of the prompt's wording, the highlighted choice, the surrounding TUI noise, and the Claude version that emitted it. Pre-fix, every match attempt indexed the prompt by the prompt's prose, which Claude's TUI rewrites between releases (HS-8071's "Experimental: inbound messages…" → "WARNING: Loading development channels…" drift is the canonical example). A channel-name index is invariant against every text drift the user has reported in HS-8071 + HS-8208.

A second cost the user called out in HS-8208's title: "**didn't auto-approved claude channels on start up**". After the *first* manual approval, the user's mental model is "I told Hot Sheet this channel is fine — why is it still asking?" Even when the existing always-allow rule eventually does match (Tier 3/4 fallbacks in §52.4 catch most cases), the user-reported failure mode is a popup that surfaces, *then* auto-dismisses a frame later — visually noisy and surprising. The cleanest fix is to never surface the popup at all once a channel-keyed rule exists.

## 58.2 Scope

**In scope.**

- Extract the channel name from `claude-numbered` prompts whose question region matches `/^Channels:\s+(\S+)/m`. Add an optional `channel?: string` field on `NumberedMatch`.
- New allow-rule shape `match_channel: string` that fires regardless of `question_hash`, `choice_shape`, or `question_preview`. Stored alongside the existing rules in `<dataDir>/settings.json::terminal_prompt_allow_rules`.
- **Implicit rule creation** on first manual approval — when the user clicks a choice on a channel-bearing prompt, automatically append a `match_channel`-keyed rule (no checkbox required). This is the user-confirmed UX (2026-05-06).
- Subtle UI surfacing on the overlay so the user sees the auto-rule is being created and can opt out.
- Settings → Permissions UI shows channel-keyed rules with the same delete affordance as today.

**Out of scope.**

- Pre-seeding rules without a first manual approval (no Settings UI to hand-create channel rules in this doc — defer until a user asks).
- Auto-approving non-channel-bearing prompts (security risk — generic always-allow stays opt-in via the existing checkbox).
- Multi-channel rules (a single rule covers one channel). If the user uses two channels, they approve each one once.
- Cross-project channel rules (channel rules are per-project, mirroring the existing rule scope).

## 58.3 Detection — channel extraction

### 58.3.1 Where to extract

`claudeNumberedParser.match` in `src/shared/terminalPrompt/parsers.ts` already walks the question region and assembles `questionLines`. After the existing strip + trim passes (`stripClaudeStatusBar` + `stripClaudeInputBox` + `trimRows` + the question-region walker with the HS-8050 stopping conditions), apply a regex against the joined question region:

```ts
const CHANNEL_LINE_RX = /^Channels:\s+(\S+)\s*$/m;
const channelMatch = CHANNEL_LINE_RX.exec(questionLines.join('\n'));
const channel = channelMatch !== null ? channelMatch[1] : undefined;
```

The regex is intentionally narrow:

- **Anchored `^Channels:`** — must be the start of a line (m flag). Avoids matching a stray "Channels:" mid-paragraph.
- **One literal whitespace + `\S+`** — Claude renders exactly one space before the value; the value itself is whitespace-free (`server:hotsheet-channel` is the canonical shape). A multi-channel future variant would need a separate parser.
- **Trailing `\s*$`** — tolerates trailing whitespace; rejects junk after the channel name.

The `\S+` capture deliberately includes the `server:` prefix so two distinct prefixes (`server:foo` vs `client:foo`) produce distinct rules. The user's concrete case is `server:hotsheet-channel`, but Claude may add other prefixes in the future.

### 58.3.2 Exposing the channel

Extend the `NumberedMatch` type with an optional field:

```ts
interface NumberedMatch {
  // … existing fields …
  /** HS-8210 — when the question region contains a `Channels: <value>` line,
   *  the captured value (e.g. `server:hotsheet-channel`). Drives the channel-
   *  keyed allow-rule path in §58. Absent for non-channel prompts. */
  channel?: string;
}
```

The signature stays `parser_id + ":" + hash(question) + ":" + choice_index` so existing always-allow rules keep matching exactly as before. The `channel` field is metadata layered on top, not a replacement.

`yesno` and `generic` matches never carry `channel` — channel extraction is `claude-numbered` only. (In practice, only Claude's numbered prompts surface `Channels:` lines.)

## 58.4 Allow-rule extension

### 58.4.1 Schema

`TerminalPromptAllowRule` in `src/shared/terminalPrompt/allowRules.ts` gains an optional field:

```ts
export interface TerminalPromptAllowRule {
  // … existing fields …
  /** HS-8210 — when set, this rule matches any `claude-numbered` prompt whose
   *  `match.channel === match_channel`, regardless of question hash / preview /
   *  choice shape / choice label. Mutually-exclusive in practice with the
   *  hash-keyed Tiers 1–4: a rule either has match_channel set OR it doesn't.
   *  The auto-allow gate evaluates Tier 0 (channel) before any of the others. */
  match_channel?: string;
}
```

Tolerant parsing in `parseAllowRules`: accept `match_channel` when it's a non-empty string; drop it silently otherwise. The dedupe key (currently `parser_id + question_hash + choice_index`) extends to include `match_channel || ''` so two rules with different channels don't collapse and a hash-keyed rule and a channel-keyed rule for the same (parser, hash, choice) coexist correctly.

### 58.4.2 Tier 0 in `findMatchingAllowRule`

The matcher gains a new Tier 0 that runs **before** the existing Tiers 1–4:

```ts
// Tier 0 — channel-keyed lookup. Only fires for claude-numbered matches that
// have a `channel` field set. When a rule's `match_channel` equals the live
// channel value, that rule wins regardless of question hash / preview /
// choice shape / choice label drift.
if (match.shape === 'numbered' && match.channel !== undefined) {
  for (const rule of rules) {
    if (rule.parser_id !== parserId) continue;
    if (rule.match_channel === undefined) continue;
    if (rule.match_channel !== match.channel) continue;
    // Bounds-check choice_index against the current shape — a rule recorded
    // against a 3-option prompt mustn't auto-respond with index 2 on a now-
    // 2-option re-render.
    if (rule.choice_index < 0 || rule.choice_index >= match.choices.length) continue;
    return rule;
  }
}
```

**Why Tier 0 (highest priority):** the channel-keyed rule is the cleanest user-intent signal — the user said "I trust this channel" and that fact is invariant across Claude wording / TUI noise / version drift. If both a Tier 0 channel rule and a Tier 1 hash rule could match the same prompt, the channel rule wins so the user's most recent trust statement governs the answer.

`payloadForAutoAllow` is unchanged — it derives the keystroke payload from `match.choices[rule.choice_index]` and works the same for channel-keyed rules.

## 58.5 Implicit rule creation on first response

### 58.5.1 The trigger

When the user clicks a choice on a `claude-numbered` overlay AND `match.channel !== undefined` AND no existing rule (any tier) already matches the prompt AND the user did NOT tick "Don't remember" (see §58.6), the response handler appends a `match_channel`-keyed rule to the project's `terminal_prompt_allow_rules`.

The existing always-allow checkbox (`renderAllowRuleCheckbox`) stays for non-channel prompts. For channel-bearing prompts, the checkbox is replaced with the implicit-create flow + the opt-out checkbox in §58.6.

The check "no existing rule already matches" prevents duplicating rules — if a Tier 1–4 rule from a previous Hot Sheet version already auto-allows this prompt, the user is just clicking through it (auto-allow already fired BEFORE the overlay surfaced); the auto-allow path never reaches the response handler anyway. If the user is seeing the overlay despite a stale rule and clicks a choice, we still create a new channel-keyed rule because the user's act of clicking is a fresh trust statement.

### 58.5.2 Where the wiring lives

Two surfaces dispatch overlays today: `bellPoll.tsx::openCrossProjectOverlay` (server-side scanner path) and any direct `openTerminalPromptOverlay` callers (currently none post-HS-8035). The implicit-rule logic lives in `openCrossProjectOverlay`'s `onSend(payload)` callback alongside the existing `recentlyAnsweredPrompts` bookkeeping:

```ts
onSend(payload) {
  void apiWithSecret('/terminal/prompt-respond', secret, { … });

  // HS-8210 — implicit channel-rule creation. Only for claude-numbered
  // matches with a captured channel; only when "Don't remember" was NOT
  // ticked; only when no existing channel rule already covers this channel.
  if (
    match.shape === 'numbered'
    && match.channel !== undefined
    && opts.dontRememberChannel !== true
  ) {
    const choiceIndex = /* derived from payload — see existing buildAllowRule sites */;
    const choiceLabel = match.choices[choiceIndex]?.label ?? '';
    try {
      const rule = buildChannelAllowRule(match, choiceIndex, choiceLabel);
      void appendAllowRule(rule, secret);
    } catch { /* generic shape would throw; never reached for numbered */ }
  }

  recentlyAnsweredPrompts.set(/* … */);
  return true;
}
```

`buildChannelAllowRule(match, choiceIndex, choiceLabel)` is a new pure helper alongside `buildAllowRule` in `allowRules.ts`:

```ts
export function buildChannelAllowRule(
  match: NumberedMatch,
  choiceIndex: number,
  choiceLabel: string,
): TerminalPromptAllowRule {
  if (match.channel === undefined) {
    throw new Error('buildChannelAllowRule called without a channel — caller bug');
  }
  return {
    id: newRuleId(),
    parser_id: 'claude-numbered',
    question_hash: '',  // Empty — Tier 0 ignores the hash. Empty string is allowed
                        //         by parseAllowRules (HS-8210 — change the validator).
    question_preview: match.question.slice(0, 120),
    choice_index: choiceIndex,
    choice_label: choiceLabel,
    match_channel: match.channel,
    created_at: new Date().toISOString(),
  };
}
```

A subtle change: `parseAllowRules` currently rejects rules with empty `question_hash`. The new shape has empty `question_hash` because Tier 0 doesn't index on it. Update the validator: when `match_channel` is set, allow `question_hash === ''`; otherwise keep the existing rejection.

### 58.5.3 Idempotence

Multiple clicks on the SAME prompt (e.g. user accidentally clicks Allow then Cancel then Allow) must not create multiple rules. `parseAllowRules`' existing dedupe key (extended in §58.4.1 to include `match_channel`) collapses successive duplicates on read — but `appendAllowRule` should ALSO dedupe on write so the file doesn't bloat. Pre-write check: if a rule with the same `(parser_id, match_channel, choice_index)` already exists in the project's settings, skip the append.

## 58.6 UI surfacing

The overlay's footer link row (currently `Minimize · No response needed`) gets an extra inline element when the prompt has a captured channel:

```
This channel will be auto-approved next time. [ ] Don't remember
```

Visual treatment: muted text, smaller font. Sits BETWEEN the actions and the existing footer links, NOT replacing the always-allow checkbox row (which now hides for channel-bearing prompts since the channel rule fully subsumes it).

Click "Don't remember" → checkbox state stored in the overlay's local closure; passed to `onSend` via the new `dontRememberChannel: boolean` field on `OpenTerminalPromptOverlayOptions`. The overlay's `onMinimize` / `onNoResponseNeeded` paths do NOT honour the don't-remember state — they don't create a rule either way (no choice = no trust statement).

The "Don't remember" affordance is new client-side state. It does NOT persist across overlay dismissals: if the user closes without clicking and re-encounters the prompt, the checkbox is fresh-unticked. (Persisting the opt-out would require its own settings key and a Settings UI to manage it; out of scope.)

## 58.7 Settings → Permissions UI

The existing `terminalPromptAllowListUI.tsx` table (Phase 4 / HS-7988) lists every rule. Channel-keyed rules render slightly differently:

- **Parser column:** still `claude-numbered`.
- **Question column:** displays `Channel: <match_channel>` (e.g. `Channel: server:hotsheet-channel`) instead of the question preview, so the user sees what the rule actually keys off.
- **Choice column:** the recorded `choice_label` (unchanged).
- **Date column:** unchanged.
- **Delete:** unchanged.

The existing `[ ] Don't remember` opt-out only affects the IMPLICIT-create path; the table's delete affordance is the symmetric way to reverse a previously-remembered channel.

No new "+ Add rule" affordance — channel rules are still only created from the overlay's first-response flow, mirroring the existing pattern (§52.7.3 closing paragraph).

## 58.8 Audit trail

Every channel-keyed auto-allow lands in the command log via the existing `terminal_prompt_auto_allow` event type, with a slightly-different summary so the user can filter:

```
Terminal prompt: claude-numbered → I am using this for local development — Auto-allowed (channel server:hotsheet-channel)
```

`appendAutoAllowAuditEntry` in `registry.ts::handleScannerMatch` already builds a similar summary; extend it to include the channel name when `rule.match_channel !== undefined`.

The same audit entry fires for Tier 0 hits as for Tier 1–4 hits — the user sees a consistent log even if the underlying matcher differs.

## 58.9 Security model

Inherits §52.8's threat surface with one new concern:

- **Channel-name spoofing.** A malicious tool that runs inside the embedded terminal and emits `Channels: server:hotsheet-channel` (the literal text the user has trusted) could trigger Tier 0 to fire on a non-Claude prompt. *Mitigations:* (1) the parser still requires `claude-numbered`'s structural shape (footer row + ≥ 2 contiguous numbered choices + cursor marker), so a bare `Channels: …` line in shell output never matches; (2) Tier 0 still bounds-checks `choice_index` against `match.choices.length`, so a rule recorded against a 2-option prompt can't auto-respond with index 2 on a 3-option spoof; (3) `payloadForAutoAllow` writes ONLY the keystroke payload for a parsed numbered choice — the spoofing tool can't inject arbitrary bytes by manipulating the `Channels:` line. The residual risk class — a malicious tool that crafts a *fully-faked* `claude-numbered` prompt complete with channel name — is the same surface §52.8 already accepts (a malicious tool inside a trusted terminal can do anything its calling user could). Channel rules don't widen it.
- **Channel-name PII.** Channel names like `server:hotsheet-channel` are user-meaningful but not personally identifying. Logging them in the command log is consistent with §52.8's existing question-text logging. Keep.

## 58.10 Implementation sequencing

Phased to keep each ticket reviewable:

- **Phase A — parser + types (HS-8211).** Add the `CHANNEL_LINE_RX` extraction in `claudeNumberedParser`, extend `NumberedMatch` with `channel?: string`, update the parser tests to assert channel extraction for the production fixture + regress that non-channel-bearing prompts still produce `channel: undefined`. No allow-rule changes yet — just parsing + typing.
- **Phase B — allow-rule schema + Tier 0 (HS-8212).** Add `match_channel?: string` to `TerminalPromptAllowRule`. Extend `parseAllowRules` to accept `match_channel` rules (with empty `question_hash` allowed). Add Tier 0 to `findMatchingAllowRule`. New `buildChannelAllowRule` helper. Update the dedupe key. 8+ new unit tests covering Tier 0 hit / miss / precedence over Tier 1–4 / wrong-shape-skip / bounds-check skip.
- **Phase C — implicit rule creation (HS-8213).** Wire `bellPoll.tsx::openCrossProjectOverlay::onSend` to call `buildChannelAllowRule` + `appendAllowRule` when the conditions in §58.5.1 hold. Add the `dontRememberChannel` opt-out field to `OpenTerminalPromptOverlayOptions`. Update `terminalPromptOverlay.tsx::openNumberedOverlay` to render the new footer line when `match.channel !== undefined`. New e2e test driving the full flow: prompt with `Channels:` line → user clicks → rule is appended → second prompt of the same channel → no overlay surfaces (auto-allow fires).
- **Phase D — Settings UI label (HS-8214).** Update `terminalPromptAllowListUI.tsx` to render `Channel: <match_channel>` for channel-keyed rules. Update the audit-log summary in `registry.ts::appendAutoAllowAuditEntry` to include the channel name when `rule.match_channel !== undefined`.

Each implementation ticket should:

1. Update [docs/52-terminal-prompt-overlay.md §52.4](52-terminal-prompt-overlay.md#524-parser-registry) with a cross-reference to this doc when Tier 0 lands.
2. Update [docs/ai/code-summary.md](ai/code-summary.md) — new fields on `NumberedMatch` / `TerminalPromptAllowRule`, new helper, new dispatcher gate.
3. Update [docs/ai/requirements-summary.md](ai/requirements-summary.md) — flip the §58 entry from Design → Partial / Shipped as phases land.

## 58.11 Open questions

- **Should the implicit-create flow fire for ANY response — including Cancel / Esc?** Probably no: a cancel is the user saying "not this time", not "always do this". Phase C wires it to choice clicks only.
- **Multi-channel prompts.** If Claude ever surfaces `Channels: a, b, c` on a single line, the regex captures only the first token before whitespace. Phase A keeps `\S+` deliberately narrow so the design isn't over-fit. A multi-channel future would need either a separate parser branch OR an array shape on the rule (`match_channels: string[]`). Defer until concrete demand.
- **Cross-project trust.** Today rules are per-project. If a user trusts `server:hotsheet-channel` for project A, they'll re-approve it for project B. Justifiable in v1 (per-project isolation is the existing convention) but noisy in practice for users who run several Hot Sheet projects against the same channel. A future ticket could add a "trust this channel everywhere" affordance — explicitly opt-in, with a separate global allow-list. Defer.
- **Rule expiry.** No automatic expiry today. If the user sets a rule and never wants the prompt again, fine. If their threat model changes, they delete the rule manually. Aligns with §52's existing convention.

## 58.12 Parent / related

- **HS-8210** — parent ticket; user confirmed the UX (auto-extract channel name + remember-on-first-manual-approval) on 2026-05-06.
- **HS-8208** — sibling bug "no popup showed at all" — solved separately by adding regression coverage; the auto-approve feature in this doc is the second half of HS-8208's title.
- **[52-terminal-prompt-overlay.md](52-terminal-prompt-overlay.md)** — design this doc extends. §52.4's four-tier matcher gains Tier 0 from §58.4.2; §52.7's Settings UI gains the channel label from §58.7.
- **[47-richer-permission-overlay.md](47-richer-permission-overlay.md) §47.4** — sibling MCP-relayed allow-list; channel rules don't apply there (different transport, different prompts), but the design conventions (per-project, file-based, audit-logged, never auto-create from heuristic-only matches) line up with both.
