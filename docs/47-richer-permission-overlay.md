# 47. Richer Permission Overlay (Edit Diff Preview + Per-Project Allow-List)

HS-6703 follow-up to HS-6602. Two scoped enhancements to the existing Claude permission popup ([12-claude-channel.md §12.10](12-claude-channel.md#1210-permission-relay)) so that the user can:

1. **See what an `Edit` would actually change** — render a diff of `old_string` vs `new_string` inside the popup so the decision is no longer "trust the description and click Allow."
2. **Stop being asked the same question every time** — register a per-project allow rule so future requests matching `{tool, pattern}` are auto-approved without surfacing a popup.

> **Status:** Shipped (HS-7951 + HS-7952 + HS-7953). HS-7951 (Edit-tool diff preview): `formatEditDiff` + `editDiffPreview.tsx` (Myers-LCS, contextLines = 2, ⋯ hunk separators, scroll-bounded 240 px body) replaces the flat-JSON `<pre>` for Edit / Write. HS-7952 (server gate): new `src/permissionAllowRules.ts` exports `findMatchingAllowRule(toolName, primary, rules)` + `extractPrimaryValue` + `parseAllowRules` (auto-anchors `^…$` at match time, skips Edit / Write per §47.4.2, malformed-regex skipped, `MAX_PATTERN_LENGTH = 500` catastrophic-backtracking guard). `routes/channel.ts::fetchPermission` checks rules before logging the `permission_request`; on match, POSTs `behavior:'allow'` to the channel server, writes a `Permission: <tool> — Auto-allowed (rule <id>)` audit entry to `command_log`, and returns `{pending: null}` so the popup never renders. HS-7953 (UI): new `src/client/permissionAllowListUI.tsx` — Settings → Permissions tab with rule table + per-row delete + inline +Add form (tool dropdown + pattern input + validation against the same `^…$` anchoring the matcher uses); overlay shortcut via `buildAlwaysAllowAffordance` mounted below the popup's links row, pre-fills `^<regex-escaped-primary-value>$`, on confirm writes the rule + immediately allows the current request. `permission_allow_rules` added to `JSON_VALUE_KEYS` in `src/file-settings.ts` so settings stores it natively. 59 unit tests across `permissionPreview.test.ts` (12) + `editDiffPreview.test.ts` (16) + `permissionAllowRules.test.ts` (22) + `permissionAllowListUI.test.ts` (15). Settings → Permissions does NOT currently include the dry-run-pattern affordance from §47.4.5; deferred to a small follow-up — the +Add form's regex-validate + the overlay's pre-fill cover the common case.

## 47.1 Problem statement

Today's permission popup ([`src/client/permissionOverlay.tsx`](../src/client/permissionOverlay.tsx)) renders three lines: tool name, description, and a normalised input preview ([`src/client/permissionPreview.ts`](../src/client/permissionPreview.ts)). For most tools that's enough to make a decision. For two cases it isn't:

- **Edit / Write requests** show a JSON-flattened `old_string`/`new_string` blob. Telling at-a-glance "is this the diff I want to land?" requires mentally reconstructing the diff. The user has been clicking Allow on Edit popups by tool reputation more than by content review — exactly the failure mode the popup is supposed to prevent.
- **Repetitive Bash requests** (`git status`, `git diff`, `npm test`, `npx tsc --noEmit`) each pop a permission overlay. The user clicks Allow every time. The popup is doing zero risk-management work in those cases — it's pure noise — but disabling permissions wholesale (e.g. via Claude Code's per-tool allowlist) loses the benefit for the *interesting* requests.

The two features are independent: the diff preview ships value with no settings-schema or security implications; the allow-list is the larger, riskier piece that needs a dedicated security model.

## 47.2 Scope

**In scope.**
- Edit-tool diff preview (47.3) inside the existing popup, for any MCP-connected Claude Code session that goes through the Hot Sheet permission relay.
- Per-project allow-list (47.4) gated server-side, with an overlay-button shortcut to add a rule and a settings-page management UI.
- Both features reuse the existing channel-server / overlay codepaths — no new transport, no new long-poll endpoint.

**Out of scope.**
- **Scraping terminal output for non-MCP Claude prompts.** Rejected in HS-6602 as too brittle (terminal markup, prompt-format variance, race conditions). Permissions only flow through the popup for MCP-relayed sessions.
- **Cross-project / global allow rules.** Rules are per-project so a `bash ^git$` rule in a sandbox repo cannot leak into a production repo. A future ticket can add user-level rules if the per-project list grows tedious in practice.
- **Allow-rules in the channel server.** Rules live in the main server (which owns project settings); the channel server stays a thin transport. This keeps the trust boundary inside the dataDir.
- **Auto-deny rules.** A user who wants to block a tool can already configure that in Claude Code; replicating it here is duplicate UX with no extra value.
- **Pattern-language extensions** beyond `tool + regex on the primary input field`. Glob shells, AST-aware matchers, etc. are deferred until the regex form proves insufficient in practice.

## 47.3 Edit-tool diff preview (HS-7951)

### 47.3.1 Detection
The popup detects an Edit/Write request by `perm.tool_name === 'Edit'` (or `'Write'` — covered separately, see 47.3.4). When detected, the existing flat-JSON preview is replaced with a rendered diff.

### 47.3.2 Input shape
[`permissionPreview.ts`](../src/client/permissionPreview.ts) already normalises the raw `input_preview` JSON. Extend `formatInputPreview` (or add a sibling `formatEditDiff`) that:

1. JSON-parses the raw `input_preview`.
2. Pulls `old_string` and `new_string` (the two fields the Edit tool always sends).
3. Returns a structured `{ kind: 'diff', oldStr, newStr, filePath, replaceAll }` object instead of a string.

The popup branches on the return shape — `kind: 'string'` keeps today's `<pre>` rendering; `kind: 'diff'` mounts the new component.

If `old_string` or `new_string` is missing or non-string (truncated, malformed), fall back to the existing flat-JSON preview rather than failing loudly. The popup must always render something useful.

### 47.3.3 Rendering
Inline unified diff is the right default. Reasons over side-by-side:

- The popup is anchored under a project tab — narrow horizontal space, often constrained by neighbouring tabs.
- Most Edit calls touch ≤ 20 lines; unified is a denser fit.
- Shared rendering with future ticket-history diffs (a follow-up area) is easier to align on one format.

Layout:

- File path on top (small, monospace).
- The diff body in a scroll-bounded `<div>` (max-height ≈ 240px) with `overflow-y: auto`. Long diffs scroll inside the popup; the popup itself stays at a fixed size.
- Lines:
  - Removed lines: red-tinted background, `-` gutter
  - Added lines: green-tinted background, `+` gutter
  - Context lines: neutral background, ` ` gutter
- 2 lines of context before/after each change hunk (configurable later if needed).

### 47.3.4 `Write` handling
`Write` (whole-file replacement, no `old_string`) is functionally a "diff against an empty file." Render it as all-added lines so the visual treatment is consistent with Edit. If the target file already exists on disk and the Hot Sheet server can read it (same project root), optionally fetch the current contents server-side to render a *real* diff — but this adds an FS read on a permission request, so it's a Phase-2 enhancement after the basic Edit case ships.

### 47.3.5 Truncation
Claude's `input_preview` is capped at ~2000 characters server-side. If `old_string`/`new_string` is truncated mid-content, the diff renderer marks the truncation visually (`… (truncated)` line at the bottom) but does not fall back to flat JSON — a partial diff is still more useful than a JSON dump.

### 47.3.6 Tests
- `permissionPreview.test.ts` — add cases for Edit-shaped inputs (full diff, no-context diff, single-line change, multi-hunk).
- New `editDiffPreview.test.ts` — pure unit tests for the diff-line builder (input → list of `{kind: 'add' | 'del' | 'ctx', text: string}` rows).
- E2E (Playwright) — render a permission popup with a fixture Edit request and assert the diff lines are present.

## 47.4 Per-project allow-list (HS-7952 server / HS-7953 UI)

### 47.4.1 Settings schema
New project-settings key (file-based, lives in `<dataDir>/settings.json` per [`src/db/settings.ts`](../src/db/settings.ts)):

```json
{
  "permission_allow_rules": [
    { "id": "01J...", "tool": "Bash", "pattern": "^git status$", "added_at": "2026-04-28T12:00:00Z", "added_by": "overlay" },
    { "id": "01J...", "tool": "Read", "pattern": ".*", "added_at": "..." }
  ]
}
```

- `tool` — exact match on `perm.tool_name` (e.g. `Bash`, `Edit`, `Read`, `Glob`). Case-sensitive — Claude's tool names are stable proper nouns.
- `pattern` — JavaScript regex source, anchored implicitly (we wrap with `^...$` at match time so a user-entered `git status` matches `git status` and not `do git status now`).
- `id` — ULID, used by the UI to delete a single rule.
- `added_at` — ISO timestamp, surfaced in the management UI.
- `added_by` — `'overlay'` if the rule was created from the popup shortcut, `'settings'` if added via the management page. Lets future telemetry distinguish quick-shortcut rules from deliberate ones.

The settings file is the source of truth — no DB mirror — so a user with multiple Hot Sheet projects gets per-project isolation for free (different `dataDir`, different `settings.json`).

### 47.4.2 Auto-allow gating

The auto-allow check belongs in the **main server**, not the channel server. The channel server stays a thin permission transport; the main server has dataDir + settings access already.

Today's flow ([12-channel-md §12.10](12-claude-channel.md#1210-permission-relay)):

1. Channel server receives `notifications/claude/channel/permission_request`, stores `pendingPermission`, notifies main server via `POST /api/channel/permission/notify`.
2. Main server's `notifyPermission()` wakes long-pollers; clients fetch pending via `GET /api/channel/permission`.
3. Client renders popup, user clicks Allow/Deny → `POST /api/channel/permission/respond` → forwarded to channel server's `/permission/respond` → channel sends `notifications/claude/channel/permission` to Claude.

New gating step inserted between (1) and (2):

1a. On `notifyPermission()`, the main server fetches the pending permission via the channel's `GET /permission`, then checks `permission_allow_rules` for the current project.
1b. If a rule matches `(perm.tool_name, primaryFieldValue)`, the main server immediately POSTs `/permission/respond` with `{behavior: 'allow', request_id, …}` to the channel server, the same way the popup would. Bypasses the long-poll wake entirely.
1c. The auto-allow event is logged in `command_log` as `permission_request` with summary `Permission: <tool> — Auto-allowed (rule <id>)` so the user can audit in the Commands Log view.

If no rule matches, the existing flow runs unchanged.

The matched field for pattern-comparison is the *primary input field* per `primaryFieldKey` in `permissionPreview.ts`:
- `Bash` → `command`
- `Read` / `NotebookRead` → `file_path`
- `Glob` → `pattern`
- `WebFetch` → `url`
- `WebSearch` → `query`
- All other tools (including `Edit` / `Write`) — pattern matches the JSON-stringified entire input. We deliberately do NOT auto-allow `Edit` / `Write` matching by file path alone, because the same path can carry arbitrarily different diffs. Allow-rules for write-side tools are out of scope until a clearer pattern-language emerges.

### 47.4.3 Overlay shortcut
When the popup renders, it includes a "**Always allow this**" link + a small gear button below the existing Minimize / No-response-needed row, conditional on:

- `perm.tool_name` has a primary input field (i.e. is in `primaryFieldKey`'s switch).
- The primary value is non-empty.

**HS-7976 — one-click commit.** Clicking the link commits immediately:

1. Saves a rule with the auto-generated `^<regex-escaped-primary-value>$` (regex-escaped exact match) to `permission_allow_rules` via `PATCH /api/settings`.
2. Calls the same Allow handler the green check would, so the current request goes through.

Users who want to broaden the pattern click the **gear button** to the right of the link — that reveals the inline editor (input + Save & Allow / Cancel) so they can tweak the pattern before saving. The pre-HS-7976 flow always showed this editor and required two clicks; HS-7976 made the common case (commit as-is) one click.

The allow-list rules live ENTIRELY inside Hot Sheet — they aren't passed to Claude. When Claude requests permission, the server-side `routes/channel.ts::fetchPermission` checks `permission_allow_rules` BEFORE rendering the popup; on match it auto-replies `{behavior: 'allow'}` to the channel and writes a `Permission: <tool> — Auto-allowed (rule <id>)` audit entry to `command_log` so the user can see what Hot Sheet accepted on their behalf.

A small pill near the link displays existing matching-rule count if any: "2 rules apply" — clicking opens the management page filtered to this tool.

### 47.4.4 Management UI (Settings page)
New section in **Settings → Permissions** (parallel to existing Settings tabs):

- One row per rule: **Tool** (mono, bold) + **Pattern** (mono code chip, ellipsis-truncated with `title` tooltip showing the full text) + **pencil-edit button** + **trash-delete button**. Row layout matches the custom-command + terminal settings rows (`cmd-outline-row` shell) so the surfaces read as siblings.
- Sort: most-recently-added first.
- Empty state: "No allow rules yet. Click '+ Add rule' below or 'Always allow' on a permission popup to create one."
- **Click the row** OR press **Enter** / **Space** while the row is focused (the row is `role="button" tabIndex="0"`) OR **click the pencil button** to open the modal rule editor (`openRuleEditor` in `permissionAllowListUI.tsx`). Reuses the `.cmd-editor-overlay` / `.cmd-editor-dialog` shell. Fields: tool select + pattern textarea (3 rows so long regexes wrap visibly) + inline validation against the same `^…$` anchoring the matcher uses. Cmd/Ctrl+Enter submits; Esc cancels; backdrop click cancels.
- **+ Add rule** button at the bottom of the list opens the same editor in `add` mode (header reads "Add allow rule", Save button reads "Add rule"). Pre-HS-8026 the page had an inline form (select + input + button) directly under the list; replaced by a single button so the add + edit flows share one validation path and the page stays uncluttered.
- Trash delete confirms (rule body shown) before PATCHing.

**HS-8026 cleanups (2026-04-29):** dropped the `Date Added` column (noise for the typical user) and the `Source (overlay / settings)` column (the "overlay" / "settings" wording confused users — the value is preserved on the rule for audit but no longer surfaced). Long patterns are no longer irrecoverably truncated — the `title` tooltip + the editor dialog both expose the full text.

**Class-name note (HS-8186, 2026-05-06):** The post-HS-8026 §47.4 row uses `.permission-allow-rule-row` (combined with `cmd-outline-row` for the shared visual scale + hover + border + click-to-edit cursor). The §52 terminal-prompt allow-rule UI deliberately stays on the **legacy** `.permission-allow-row` grid layout — HS-8021 / HS-8026 only restyled this surface; the §52 surface gets the same treatment in a future follow-up. The two class names are NOT a typo — `_row` is the legacy grid layout, `_rule_row` is the post-HS-8026 cmd-outline-shell variant.

### 47.4.5 Test/dry-run mode
A "Test pattern" affordance in the management UI:
- Input: `pattern` + sample `command` (or `file_path` / `url`).
- Output: green "Would auto-allow" or red "Would NOT match," highlighting the regex anchor behaviour.
- Especially helpful given the implicit `^...$` wrap — users who type `git status` and expect substring behaviour will see it not match `cd /tmp && git status`.

### 47.4.6 Tests
- Server: `permissionAllowRules.test.ts` — unit tests for `findMatchingAllowRule(tool, primary, rules)` against representative rule sets, including invalid regex rejection (a malformed `pattern` stored in settings must NOT crash the gate; it logs + skips that rule).
- Server integration: `routes/channel.test.ts` — POST a permission request via `/api/channel/permission/notify`, configure a matching rule, assert that `/permission/respond` was invoked synchronously and no long-poller was woken with `pending !== null`.
- E2E (Playwright): full flow — fire a fixture permission request, click "Always allow", confirm rule appears in settings, fire a second matching request, assert no popup appears AND the command log shows `Auto-allowed (rule <id>)`.

## 47.5 Security model

The allow-list is **a user-authored decision to bypass case-by-case approval for a class of operation in this project.** Threats to weigh:

- **Compromised dataDir** — an attacker with write access to `<dataDir>/settings.json` can plant `{tool: 'Bash', pattern: '.*'}` and silently auto-approve every future Bash request. *Mitigation:* the dataDir is already a trust root for Hot Sheet (it holds the `secret` that authorises every API mutation); a compromised dataDir is fully compromised today, with or without this feature. No new threat surface.
- **Pattern over-match** — a user types `git` expecting to match `git status` but accidentally matches `git push --force origin main`. *Mitigation:* implicit `^...$` anchoring; the settings UI surfaces the wrap explicitly with a "(matches the entire command, not a substring)" hint; the test/dry-run affordance lets the user verify before saving.
- **Auto-allow audit gap** — a rule fires silently with no record. *Mitigation:* every auto-allow writes a `permission_request` log entry tagged with the matching rule ID. The Commands Log view ([14-commands-log.md](14-commands-log.md)) surfaces these alongside manual approvals so the audit trail is complete.
- **Pattern injection** — settings-file contents shape regex evaluation. *Mitigation:* `new RegExp(pattern)` runs in a normal-priority context with no `g`/global side-effects; pattern is stringly-typed source, no `eval`. Catastrophic backtracking is the realistic worst case (CPU pin) — the gate enforces a 50ms timeout-by-substring-length heuristic and skips the rule if exceeded.
- **Cross-project contamination** — a rule in project A applies to project B. *Mitigation:* settings live in per-project `<dataDir>/settings.json`; the gate reads only the current project's rules.

## 47.6 Open questions

- **Should `Edit` / `Write` ever be allow-listable?** Currently scoped out (47.4.2) because file-path alone doesn't capture diff intent. Could add later with a `path-glob + diff-size-limit` rule shape, but no demand evidence yet.
- **Should the popup's "Always allow" pre-fill auto-broaden multi-arg commands?** E.g. `git status -s` → propose `^git status( -[a-z]+)?$` as a generalisation. This is convenience-only but a meaningful onboarding accelerant. Defer to user feedback after HS-7953 ships.
- **Telemetry on rule effectiveness?** Track per-rule fire counts in `command_log` (each auto-allow already logs); aggregate into the management UI as "fired N times". Useful but cuts into the "settings is just JSON" simplicity. Defer.

## 47.7 Implementation sequencing

The diff preview (HS-7951) ships first — it's a pure UI change, no settings, no security model, and immediately useful. The allow-list pieces (HS-7952 server + HS-7953 UI) ship together because the server gate without UI is invisible and the UI without the gate is decorative.

Each implementation ticket should:

1. Update [12-claude-channel.md §12.10](12-claude-channel.md#1210-permission-relay) with a note pointing to this doc + the specific feature it added.
2. Add an entry under the Permission Relay section of [9-api.md](9-api.md) for any new endpoint or settings key.
3. Update [docs/ai/code-summary.md](ai/code-summary.md) (new client modules, new server route, new settings key).
4. Update [docs/ai/requirements-summary.md](ai/requirements-summary.md) — flip this doc's entry from Design → Shipped (or Partial if only one of the two features lands).

## 47.8 Parent / related

- HS-6602 — investigation that produced this scope and rejected terminal scraping.
- HS-6477, HS-6536, HS-6536, HS-6637, HS-7266, HS-6634 — historical permission-popup work.
- HS-7999 — terminal-buffer snapshot for truncated previews (§47.9 below).
- [12-claude-channel.md §12.10](12-claude-channel.md#1210-permission-relay) — current permission relay design.

## 47.9 Terminal-buffer snapshot for truncated previews (HS-7999)

Claude's MCP channel truncates `input_preview` at ~2000 chars before sending. For long prompts (multi-file diffs, large Bash command-line previews, framed Ink TUI prompts) the popup's flat-string preview shows just `…` because `permissionPreview.ts::extractStringField` couldn't parse a primary-field value past the cut. The snapshot path closes that gap by reaching back into the live terminal buffer:

1. **Detect non-trivial preview.** `permissionOverlay.tsx::shouldUseLiveCheckout(editDiff, previewText)` — pure helper, exported for unit-test isolation — returns true on any of: (a) flat-string preview ending in `…` (legacy HS-7999 truncation path — `extractStringField` appends `…` when the JSON body was cut mid-stream); (b) parsed Edit/Write diff carrying `truncated: true` (HS-8139 — pre-fix the snapshot path was skipped for any popup that successfully rendered the inline diff DOM, so a long Write payload truncated to a few `+` lines + a `… (truncated)` footer never triggered the buffer snapshot. Now either truncation indicator fires the live-borrow.); **(c) any parseable Edit/Write diff regardless of size** (HS-8217 — the actual claude TUI's coloured rendering is significantly richer than the static `renderEditDiffPreview` HTML diff, so we always prefer it for Edit/Write); **(d) multi-line flat preview** (HS-8217 — `previewText.includes('\n')`); **(e) long single-line flat preview** (HS-8217 — `previewText.length > LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD = 80`). Short single-line bash / `git status` / one-line `Read` previews stay on the tight static `<pre>` path.
2. **Live-terminal checkout into the popup body (HS-8171 v2, supersedes the snapshot-based v1).** When a truncation indicator fires, `showPermissionPopup` builds a `.permission-popup-live-terminal` container and uses it as the popup body slot. After `openPermissionDialogShell(...)` returns (which `appendChild`s the overlay synchronously), the popup calls `checkout({projectSecret, terminalId: 'default', cols: 100, rows: 30, mountInto: container, readOnly: true})` from `terminalCheckout.tsx` (§54). The §54 LIFO stack reparents the LIVE project xterm element into the popup container — the user can scroll the real PTY scrollback, select / copy text from it, but **HS-8301: typed keystrokes are NOT delivered to the PTY while the popup is open** (the §54 module sets `term.options.disableStdin = true` while a `readOnly` consumer is on top, then resets to false on release so the drawer pane / dashboard tile underneath gets typing back). Pre-HS-8301 the user could accidentally inject keystrokes into Claude's prompt while answering the popup — the read-only gate closes that footgun. A deferred `requestAnimationFrame` call to `handle.fit.proposeDimensions()` + `handle.resize(...)` adapts the cols/rows to the popup container's measured layout. On every popup-close path (Allow / Deny → `respondToPermission`; X / Esc → `cleanupAndDismiss`; Minimize → `cleanupAndMinimize`; "No response needed" → `cleanupAndDismiss`) `releaseCheckoutIfAny()` calls `handle.release()` so the previous owner (drawer pane, dashboard tile, drawer-grid tile) re-takes the top of the stack and gets its own dims back.

   Pre-v2 (HS-7999 / HS-8139 / HS-8158 / HS-8171 v1) the popup body was a one-shot serialized snapshot of the live xterm — but the user reported that even the synchronous serialize path could sample stale or empty content depending on when Claude's TUI had repainted. A real checkout sidesteps the sampling problem entirely: there's no snapshot, just a live reparented xterm. The trade-off the user explicitly approved is that the previous owner of the same project's terminal (e.g. an open drawer tab on the same project) sees the §54 placeholder for the duration of the popup ("slightly weird when its for the project you're already looking at, but i think thats ok").
3. **Lifecycle plumbing** — `permissionOverlay.tsx` tracks the checkout in a closure `let checkoutHandle: CheckoutHandle | null = null`. `releaseCheckoutIfAny()` is idempotent (`try { handle.release() } catch {…}` then null the var) and is called from every popup-close path BEFORE `handle.tearDownDom()` in the respond-permission flow so the live xterm element reparents into the previous owner's `mountInto` rather than being momentarily orphaned in the removed-from-document subtree. For dismiss / minimize / no-response-needed the release happens inside the matching cleanup helper before the shell tears the overlay DOM down.
4. **Container sizing.** SCSS gives the wrapper `width: 100%; height: min(420px, 60vh); overflow: hidden` so `FitAddon.proposeDimensions` has stable dimensions to compute cols/rows from. The inner `.xterm` is `height: 100%; padding: 4px`. Capped at 60vh so the popup still fits inside the dialog shell's `max-height: 80vh` on short laptop screens. Resizing happens once on mount (the rAF tick after `checkout()`); we don't wire a `ResizeObserver` because the popup's outer dims don't change while it's open.

#### Snapshot-based fallback (legacy HS-7999, deleted in HS-8177)

`src/client/terminalSnapshot.ts` and its 23-test suite were deleted in HS-8177 (2026-05-04). The pause/drain plumbing the snapshot module relied on (`pauseEntryWrites`, `takePausedBytes`, `resumeEntryWritesAndDrain`, `sendPtyResize` exports + the `paused` / `pausedBytes` fields on `StackEntry`) was removed from `src/client/terminalCheckout.tsx` in the same change. A future surface that needs a one-shot mirror without taking the live xterm away from its current owner would need to reintroduce a similar capture path — the §54 history-replay primitives plus a fresh offscreen `XTerm` would be the natural starting points.

### Bail conditions (HS-8171 v2)

`checkout()` always returns a handle: when no entry exists for `(secret, 'default')` it creates one (opens a fresh xterm + WebSocket, the server-side scrollback-replay-on-attach paints whatever the PTY has already produced). So unlike the legacy snapshot path, the v2 checkout never silently degrades — there is always a live xterm in the popup body.

If the project has no terminal-backed Claude AT ALL (the PTY isn't running), the WebSocket attach succeeds against an empty session and the user sees a blank xterm — same outcome they would get from opening that project's drawer with no Claude running.

### Iteration history

- **HS-7999** (initial) — introduced the snapshot path. Resize PTY up → wait → serialize → resize back → unfreeze. Closed the channel-truncated `…` gap.
- **HS-8139** — extended the truncation trigger to cover the parsed Edit/Write diff's own `truncated: true` flag, not just flat-string previews ending in `…`.
- **HS-8158** — guarded the snapshot with `streamHasVisibleContent` so a redraw of pure ANSI control sequences didn't mount a fully black mirror xterm.
- **HS-8159 / HS-8139 v3** — made `serializeLiveTerm` the primary path: serialize the live xterm's existing buffer + scrollback rather than relying on Claude redrawing on SIGWINCH. Resize-based capture survived as a blank-live-term fallback.
- **HS-8171 v1** — restructured `showPermissionPopup` so `serializeLiveTerm` was called BEFORE `openPermissionDialogShell` so the popup mounted directly with the mirror body, avoiding the ~1 ms async-replace flash.
- **HS-8171 v2** — replaced the snapshot-based mirror with a real §54 `checkout()` of the live terminal into the popup body. Sidesteps every sampling-correctness issue the snapshot iterations had to chase (stale buffer, blank capture, structural-only redraw, async swap), and gives the user a real interactive terminal inside the popup. The trade-off: any other consumer of the same project's `'default'` terminal sees the §54 placeholder until the popup releases.
- **HS-8183** — two reliability fixes for the polling lifecycle. (1) The auto-dismiss path in `processPermissionPollResponse` (extracted from the `startPermissionPolling` poll loop in the same change for testability) now requires `AUTO_DISMISS_MISS_THRESHOLD = 2` consecutive polls of "request missing from `data.permissions`" before tearing the popup down. Pre-fix a single transient channel-server fetch failure (the per-project `fetch` in `routes/projects.ts::checkAll` returns `null` on any throw — network blip, brief restart, slow response getting cancelled) ripped the popup out from under the user. (2) `showPermissionPopup` now wraps the entire mount path in try/catch that resets `activePopupRequestId`, releases any stale checkout, and removes any partial-mount DOM before rethrowing. Pre-fix a throw partway through the mount (xterm constructor failure, malformed truncation payload reaching `formatEditDiff`, etc.) left `activePopupRequestId` set with no popup in the DOM, so every subsequent show-loop call early-returned at the `if (activePopupRequestId !== null) return;` gate — exactly the "no popups ever after" tail of the user's repro. Tests in `src/client/permissionOverlay.test.ts` (15 cases for HS-8183 + 3 cases for HS-8206) lock both behaviours.
- **HS-8206 v1** — replaced the single-rAF `proposeDimensions` + `resize` of the borrowed live terminal with a `ResizeObserver` mirroring `quitConfirm.tsx::HS-8055`. Pre-fix the single rAF fired before xterm's renderer had measured cell dims for the new layout (the term was just reparented out of the offscreen 1×1 parking sink), so `proposeDimensions()` returned undefined and the resize was skipped. v1 covered the case where the popup was ever resized (e.g. window resize) but did NOT cover a fixed-CSS-size popup container that never fires a follow-up size-change event after the initial observe, leaving the term stuck at the initial 100×30.
- **HS-8206 v2** — for a fixed-CSS-size popup container the v1 observer fires once on initial observe + bails when `proposeDimensions()` returns undefined; with no follow-up size-change events, the term stayed at 100×30 even after xterm's renderer measured cell dims a frame or two later. Fix in `permissionOverlay.tsx`: replaced the inline observer callback with a module-level `runLiveTermFitWithRetry(handle)` that polls `proposeDimensions()` up to `LIVE_TERM_FIT_RETRY_MAX_ATTEMPTS = 30` times at `LIVE_TERM_FIT_RETRY_INTERVAL_MS = 16` ms intervals (~480 ms total budget) until cell dims are measured. Bails immediately if `activeCheckoutHandle` no longer matches the captured handle (popup closed / replaced) so retries don't outlive the popup. `clearLiveTermFitRetryTimer()` runs from every popup-close path via `releaseActiveCheckoutIfAny()` + `_resetStateForTesting()`. The ResizeObserver still installs in case a window resize changes the popup dims mid-popup; its callback now also routes through `runLiveTermFitWithRetry` so a real size change benefits from the same retry semantics. Companion fix in `terminal.tsx::mountInstanceViaCheckout`: added `onRestoredToTop: () => requestAnimationFrame(() => doFit(inst))` so when the popup releases and the live xterm reparents back into the drawer pane's `canvasHost`, the drawer refits to its actual container width — pre-fix `applyResizeIfChanged` inside `releaseInternal` resized the term to the drawer's ORIGINAL checkout cols/rows (80×24), not the drawer pane's current geometry (typically 178×42), leaving the user looking at a narrow terminal with content wrapping at ~80 cols even though the drawer was full-width.
- **HS-8218** — follow-up to HS-8216 (the §52 parser fix that surfaced the *Read* permission popup). User reported that the *Edit* popup still went through phases: "briefly shows a blank terminal in the popup → claude channels permission check briefly → new empty claude prompt → permissions check disappears" — and that "the LingoGist project DOES have an MCP connection, but this new claude window that pops up disrupts that". **Root cause:** the popup's live-terminal checkout hardcoded `terminalId: 'default'`. When the project's claude was running under a *different* terminal id (and `'default'` had never been started), the WebSocket attach hit the `attach()` branch in `src/terminals/registry.ts` that calls `createSession` + `spawnIntoSession` for an unknown `(secret, terminalId)` — so a **brand-new** `claude --dangerously-load-development-channels` PTY was spawned into the popup body. That fresh claude tried to connect to the same per-project channel server, stealing the MCP connection from the user's actual claude session and orphaning the original Edit-permission request (which then auto-dismissed). **Fix:** added a `noSpawn` opt-in across the attach pipeline. `attach()` returns `{ alive: false, noSession: true, history: empty }` without creating a session when `noSpawn === true` and no session exists. The WS handler reads `?noSpawn=1`, passes through to `attach`, and on `noSession: true` sends an empty history frame + closes the socket with code 1000. Client-side `terminalCheckout.tsx` accepts `noSpawn` in `CheckoutOptions`, plumbs it onto a per-entry flag (so reconnects keep the contract), and adds an `onNoLiveSession` callback that fires on the `noSession: true` history frame. The popup passes `noSpawn: true` + an `onNoLiveSession` handler that calls a new `fallbackToNonLivePreview()` — releases the checkout (which cleanly tears the entry down via `disposeEntry`) and swaps the popup body from the live-terminal container to the same flat / diff preview the non-truncation code path renders. Tests: 4 in `registry.test.ts` (noSession returned + no spawn / live-session pass-through / exited-session not noSession / default-still-spawns), 5 in `websocket.test.ts` (3 authenticate parsing + 2 roundtrip — noSession+close-1000 / noSpawn-on-live-session-finds-existing-PTY), 4 in `permissionOverlay.test.ts` under `noSpawn fallback (HS-8218)` (popup checkout carries noSpawn / fallback swaps body to flat preview / chrome and Allow-Deny intact across the swap / non-noSpawn entry leaves the simulator a no-op so the popup body stays live). Net effect: the popup never inadvertently spawns a fresh claude, so the user's MCP-connected claude is no longer disrupted; if no live session exists for `terminalId: 'default'`, the popup gracefully falls back to the flat / diff preview the user always had pre-HS-8171 v2.

- **HS-8219** — user reported "it's sometimes showing multiple permissions popups at once -- it should only show one at a time -- using a stack data structure". Pre-fix the `showPermissionPopup` gate (`if (activePopupRequestId !== null) return;`) ostensibly enforced single-popup, but new permissions arriving while one was active were silently dropped — the polling loop's next 100 ms iteration re-introduced them via the for-each, leaving a window during which a partial-mount glitch could leak a second `.permission-popup` into the DOM. Fix: introduced a literal stack data structure `pendingPermissionStack: { secret, perm }[]` in `permissionOverlay.tsx`. (1) When `showPermissionPopup` is called while another popup is already active, the new permission is **pushed onto the stack** (with a duplicate-id guard so the polling loop's repeated for-each doesn't grow the stack). (2) Every popup-close path (`respondToPermission`, `cleanupAndDismiss`, `cleanupAndMinimize`, the auto-dismiss branch in `processPermissionPollResponse`, AND the partial-mount throw catch) calls a new `mountNextFromPendingStack()` that pops the top of the stack — skipping any entries that became responded / dismissed / minimized while waiting — and mounts the next valid one. (3) End-of-poll GC: `processPermissionPollResponse` walks the stack and drops entries whose `request_id` is no longer in `data.permissions` (the channel server resolved them elsewhere, e.g. user typed a response in the terminal). (4) Defensive cleanup: every `document.querySelector('.permission-popup')?.remove()` call site flipped to `document.querySelectorAll('.permission-popup').forEach(el => el.remove())` so even a stray duplicate (somehow leaked from a previous cycle) is cleaned up before the new mount. New exported pure helper `shouldSkipPermission(requestId)` centralises the responded / dismissed / minimized lookup. New exported `getQueuedPermissionRequestIds()` returns the stack's request-id list for debugging / status-dot wiring. `_inspectStateForTesting` extended with `pendingPermissionStackIds`. Tests: 9 new unit tests in `src/client/permissionOverlay.test.ts` under `pendingPermissionStack — single-popup contract (HS-8219)` — first-popup-active+others-on-stack, repeated-polls-don't-re-push, stack-GCs-on-server-resolve, mount-next-on-Allow, mount-next-on-X, **LIFO ordering**, skip-stale-queued-entries-on-pop, querySelectorAll-defensive-cleans-up-stray, `shouldSkipPermission` lookup. Net effect: only one `.permission-popup` ever exists in the DOM, the next queued permission surfaces immediately on dismiss without waiting on a poll round-trip, and the stack is robust against the partial-mount race the user observed.

- **HS-8217** — the user reported that the static colour-coded HTML diff path for non-truncated Edit / Write previews was still hard to follow vs the actual claude TUI's coloured output (file-name header, dim-faded unchanged context, bright green added rows, bright red removed rows, plus the numbered choices list directly below). User quote: "the text is hard to follow. in the terminal, the edits are color coded so it's easier to see what's being added / removed... when possible, we should use the terminal borrowing method for the longer cases". Fix: extracted the live-checkout gate from the inline `flatTruncated || diffTruncated` calculation into a new exported pure helper `shouldUseLiveCheckout(editDiff, previewText)` in `permissionOverlay.tsx`. The helper now triggers live-borrow on **any** of: `editDiff !== null` (any parseable Edit / Write — single-line included, since the TUI rendering is always richer than the static HTML diff), `previewText.endsWith('…')` (legacy HS-7999 truncation), `previewText.includes('\n')` (multi-line flat preview), `previewText.length > LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD = 80` (long single-line bash pipelines). Short single-line bash one-liners (`ls -la`, `git status`, single-file `Read`) stay on the static `<pre>` path — tight UI + avoids the noSpawn-fallback round-trip. Pre-fix only truncation triggered live-borrow, so the user's HS-8217 example (a single-line function-signature change in `ascii-art.py` — well under the 2000-char `input_preview` cap, no truncation) rendered as the static `renderEditDiffPreview` HTML diff. The HS-8218 noSpawn fallback ensures aggressive expansion of the live-borrow gate stays safe — when no live `'default'` PTY exists, the popup still gracefully falls back to the static preview via `onNoLiveSession`. Tests: 9 new unit tests in `src/client/permissionOverlay.test.ts` under `shouldUseLiveCheckout — pure heuristic (HS-8217)` (any Edit/Write triggers / multi-line Edit triggers / truncated Edit triggers / flat truncation triggers / multi-line flat triggers / long single-line flat triggers / short bash stays static / empty preview stays static / boundary at exactly 80 chars stays static, 81 flips). 2 new integration tests under `showPermissionPopup — non-truncated Edit triggers live checkout (HS-8217)` lock the popup-mount behaviour: a non-truncated Edit popup mounts the `.permission-popup-live-terminal` container (not `.edit-diff-preview`); when `_simulateNoSessionForTesting` fires the noSession signal, the body falls back to the static diff preview. 1 negative-regression test under `showPermissionPopup — short bash stays static (HS-8217)`: a short bash one-liner mounts the static `<pre>`, no checkout entry created.

- **HS-8207** — the user reported the popup STILL going through phases ("starts blank → shows some content → shows completely different content → disappears entirely") despite the HS-8183 / HS-8206 fixes, and asked for full e2e coverage. Two reliability fixes: (1) **Eliminate the back-to-back resize-induced redraws on popup mount.** Pre-fix the popup hardcoded `cols: 100, rows: 30` in its `checkout(...)` call. When an existing consumer (drawer pane / dashboard tile) was already mounted with non-default dims (e.g. 90×28), `applyResizeIfChanged` resized the term to (100, 30) on checkout — first SIGWINCH, claude TUI redraw — then HS-8206 v2's fit-retry resized to popup-fit dims (~67×24) — second SIGWINCH, second redraw. The user perceived the two back-to-back claude redraws as the "shows some content → shows completely different content" multi-phase symptom. New `peekEntryDims(secret, terminalId)` export from `terminalCheckout.tsx` reads the current entry's dims; `permissionOverlay.tsx` uses it to pass through the existing dims (or 80×24 when no entry exists) so the swap-time `applyResizeIfChanged` is a no-op. Only the fit-retry's resize remains visible to claude — single redraw. (2) **Distinguish channel-unreachable from no-permission-pending.** `routes/projects.ts::checkAll` previously returned `null` for ANY error — the per-project `fetch` to the channel server's `/permission` endpoint throwing was indistinguishable from the channel server replying `{ pending: null }`. The client treated both as confirmed-not-pending and ticked the auto-dismiss counter; HS-8183's `AUTO_DISMISS_MISS_THRESHOLD = 2` softened but didn't eliminate the failure mode (two consecutive transients still tore the popup down). Post-fix `checkAll` OMITS the project entirely when fetch throws (channel-port-file-missing case still returns null deliberately, since that's a definitive "channel never connected for this project"). New module-level `activePopupOwnerSecret` in `permissionOverlay.tsx` tracks which project owns the active popup; `processPermissionPollResponse`'s auto-dismiss check now distinguishes "owner missing from response" (don't tick — stay where you are) from "owner present-with-null" (confirmed not pending — tick). Even five missed polls in a row keep the popup mounted when the channel is genuinely unreachable. The counter is preserved (not reset) on unreachable polls so a "null then unreachable then null" sequence still eventually dismisses on the second confirmed null. **E2E coverage**: `e2e/permission-popup-live.spec.ts` (8 tests) drives the actual client polling loop via `page.route()` mocks — popup-shows-on-pending, no-churn-on-same-id, no-dismiss-on-single-null, dismiss-on-double-null, **no-dismiss-on-channel-unreachable**, allow-respond, deny-respond, truncated-input-uses-live-checkout-body. New unit tests in `permissionOverlay.test.ts` (6 cases): owner-missing-doesn't-tick, present-null-ticks, counter-preserved-across-unreachable-mid-streak, owner-secret-cleared-on-auto-dismiss, dim-passthrough uses existing entry dims (no SIGWINCH on checkout), and 80×24 default for first-consumer. New unit test in `routes/projects.test.ts`: OMITS-on-fetch-throw + still-null-on-no-channel-port. Net effect with HS-8207: only the popup-fit resize is visible to claude (one redraw, not two), and a flapping channel server can no longer make the popup disappear from under the user.

### Cost + risks (HS-8171 v2)

- **PTY redraw on resize.** The initial `checkout()` passes 100×30; the rAF-deferred fit then resizes to the popup's measured geometry. Claude's TUI redraws on each resize. When the popup releases, the previous owner's checkout reapplies its own dims and Claude redraws again. Two visible redraws per popup. Acceptable per the user's design call.
- **Bumped consumer.** If the user has the same project's drawer open with the `'default'` terminal mounted, that surface shows the §54 "Terminal in use elsewhere" placeholder for the duration of the popup. Documented design decision.
- **Interactive terminal inside the popup.** Clicking the xterm steals focus from the Allow / Deny buttons. The user explicitly approved this trade in the HS-8171 note.
- **Single in-flight popup.** `permissionOverlay.tsx` already serialises permission popups via `activePopupRequestId`, so two popups can't simultaneously try to check out the same `(secret, 'default')` and fight over its top-of-stack position.

### Tests

`src/client/terminalCheckout.test.ts` (25 tests) covers the §54 LIFO-swap behaviour the v2 flow relies on. The previously-extant `src/client/terminalSnapshot.test.ts` (23 tests) was deleted alongside `terminalSnapshot.ts` in HS-8177. `src/client/permissionOverlay.test.ts` (HS-8183 / 8206 / 8207) covers the polling-lifecycle state machine: show / no-show gates, two-consecutive-miss auto-dismiss threshold, jitter-recovery, fresh-request-id-after-dismiss regression contract, dismissedRequestIds GC, partial-mount safety, the HS-8206 ResizeObserver install / disconnect lifecycle, the HS-8207 channel-unreachable signaling (owner-missing-doesn't-tick / present-null-ticks / counter-preserved-on-unreachable-mid-streak), and the HS-8207 dim-passthrough (existing-entry dims used at checkout to avoid double SIGWINCH). `e2e/permission-popup-live.spec.ts` (HS-8207, 8 tests) drives the real client polling loop via `page.route()` mocks: chrome rendering, no-churn-on-same-id, single-null-doesn't-dismiss, double-null-dismisses, **owner-missing-from-response-doesn't-dismiss** (channel-server-unreachable contract), Allow / Deny click → respond payload, truncated-input → live-terminal-checkout body slot. Manual coverage lives in `docs/manual-test-plan.md` §12 — see "Permission popup — live-terminal checkout (HS-8171 v2)".

## 47.10 Bash-tool custom layout (HS-8299)

User reported (2026-05-08) that the §47 popup was rendering a wall of unhelpful information for Bash tool calls — the live-borrowed terminal showed Claude's full TUI (banner + scrollback + prompt + choice list) inside the popup body, and the choice buttons rendered as ASCII-only `1.` / `2.` / `3.` rows the user couldn't click. The user's verdict: replace the live-borrow body with a clean tool-specific UI, replace the green-check / red-X icon buttons with a vertical column of clickable buttons, drop the `Bash` tool chip from the dialog header (the title carries the verb already).

### 47.10.1 Layout

- **Title**: "Allow Claude to run" (replaces the existing `description` text for Bash tool calls)
- **Tool chip**: suppressed for Bash so the dialog header reads as just the title
- **Body**: `<pre class="permission-bash-command">` rendering the verbatim command string (extracted via `extractPrimaryValue('Bash', input_preview)`). SCSS gives the `<pre>` `overflow-y: auto`, `max-height: 60vh`, `white-space: pre-wrap`, `word-break: break-all` so a long pipeline scrolls inside the box and unbroken tokens (paths, base64 args) wrap rather than overflow horizontally.
- **Actions**: three vertically-stacked `<button>`s replace the icon-button row — `Yes` (primary, accent-coloured), `Yes, and allow this command and similar in the future`, `No`. Stack lives inside `.permission-popup-actions.permission-popup-actions-stacked` with `flex-direction: column; gap: 8px; align-items: stretch; width: 100%` so the buttons span the dialog width edge-to-edge.

### 47.10.2 Live-checkout suppression

The HS-8217 heuristic (`shouldUseLiveCheckout`) is bypassed entirely when `tool_name === 'Bash'` and the primary value extracts cleanly. Long Bash pipelines that pre-fix would have triggered the live-terminal borrow now render in the dedicated body instead. Per the user's feedback (HS-8299 Q1, answer "a"): replace § 47 popup body for ALL Bash tool calls — Bash always renders the new command-only layout, no live-terminal borrow.

### 47.10.3 "Yes, and allow this command and similar in the future" button

Re-uses the §47.4 always-allow-rule mechanism (auto-anchored `^${regexEscape(command)}$` pattern, `tool: 'Bash'`, `added_by: 'overlay'`) — the same rule the existing checkbox-style affordance creates, just promoted to a primary button. Implementation lives in `src/client/bashPermissionPreview.tsx::persistBashAlwaysAllowRule`; mirrors `permissionAllowListUI.tsx::saveRuleAndCommit` minus the form-error UI (the new button owns its own error display below the actions block). On success the button calls the caller's `onAllowAlways` (which routes to `respondToPermission('allow')`); on failure the button re-enables and an inline error chip appears so the user can retry or pick a different choice.

The existing `buildAlwaysAllowAffordance` checkbox-style affordance is suppressed for Bash (folded into the middle button); other allow-listable tools (Read / Glob / WebFetch / WebSearch) keep the existing affordance unchanged.

### 47.10.4 Allow-rule match semantics

Per the user's feedback (HS-8299 Q3): when an existing `permission_allow_rules` entry matches a new Bash prompt, the auto-allow fires as a plain `Yes` (one-shot allow) — NOT as a re-affirmation of the "Yes, and allow more broadly" rule. This is already the existing §47.4 behaviour: matching auto-allow runs the same code path as the user clicking "Yes", which doesn't create a new rule. The HS-8299 button-row design preserves this: the middle button is the rule-creation path; matching is the no-rule-change path.

### 47.10.5 Tests

`src/client/permissionOverlay.test.ts` gained a new `describe('Bash custom layout (HS-8299)', ...)` block with 5 tests: title + scrollable command + 3-button shape; long-command-still-uses-Bash-layout (no live-checkout fallback); deny-button-tears-down-popup; allow-button-tears-down-popup; non-Bash tools keep the legacy two-icon-button + always-allow-affordance (defence-in-depth so the Bash branch doesn't leak across to Read / Glob / etc.). The pre-existing `'renders the flat <pre> preview for a short single-line bash command'` HS-8217 test was updated to assert the new `.permission-bash-command` body shape (HS-8299 supersedes HS-8217 for Bash).

## 47.11 Write-tool custom layout (HS-8296)

Parallel to HS-8299's Bash redesign. User reported (2026-05-08) that the §47 popup for Write tool calls was showing a lot of irrelevant chrome around an opaque flat-JSON / live-borrowed-terminal preview, with green-check / red-X icon buttons that didn't reflect Claude's actual three-choice TUI prompt. Per the user's feedback (Q1 = "yes" / Q2 + Q3 = "just mirror what claude says" / Q4 = "replace"): replace §47 entirely for Write with a tool-specific layout.

### 47.11.1 Layout

- **Title**: `Allow write to <path>?` (computed inside `writePermissionPreview.tsx` from `input_preview.file_path`; the dialog header carries the verb so `toolChip` is suppressed for Write).
- **Body — text content**: `<pre class="permission-write-content">` rendering the verbatim file content (`input_preview.content`). Same SCSS shape as the HS-8299 Bash command box — `overflow-y: auto`, `max-height: 60vh`, `white-space: pre-wrap`, `word-break: break-all`. Empty content renders as a blank but still-bordered `<pre>` (legitimate Write target — `touch foo.txt` equivalent).
- **Body — binary content**: when the content fails the binary-detection heuristic (`looksLikeBinaryContent`), the body becomes a centered, italic, muted `Binary Data (NNN bytes)` chip instead of the verbatim string. Threshold: \> 1 % of the first 4 KB of content is NUL or non-printable C0 control chars (excluding TAB / LF / CR which are common in plain text).
- **Actions**: three vertically-stacked `<button>`s reusing `.permission-popup-actions-stacked` from HS-8299 — `Yes` (primary, accent-coloured), `Yes, and don't ask again for edits in <dir> during this session` (mirrors Claude's TUI copy verbatim per Q2 / Q3), `No`.

### 47.11.2 Live-checkout suppression

The HS-8217 heuristic (`shouldUseLiveCheckout`) is bypassed entirely when `tool_name === 'Write'` and `extractWriteFields(input_preview)` returns a non-null `{file_path, content}` shape. Per the user's Q4 = "replace" answer.

The fallback to the legacy two-icon-button + always-allow-affordance layout fires when `extractWriteFields` returns null (malformed JSON, missing `file_path` / `content`, wrong types) — defence-in-depth so a malformed payload still surfaces the popup with SOMETHING actionable rather than throwing.

### 47.11.3 "Yes, and don't ask again..." button

V1 ships the UI without persisting a session-scoped rule — clicking the middle button just responds `allow` (same as the primary "Yes"). The label mirrors Claude's TUI copy verbatim per Q2 / Q3 ("just mirror what claude says"); the technical scope is Write-only and one-shot for now. Filed as a follow-up: a real session-bound directory allow-list that auto-allows future Write requests for files under the same directory until the session ends. The §47.4 rule schema is path-tool-only and skips Edit / Write deliberately because file-path alone doesn't capture write intent — a separate session-scoped store (cleared on app boot) would sit alongside `permission_allow_rules` rather than reusing it.

### 47.11.4 Tests

`src/client/permissionOverlay.test.ts` gained a new `describe('Write custom layout (HS-8296)', ...)` block with 5 tests: title + scrollable content + 3-button shape for text writes; binary-data-marker fires for non-text content (100 NUL bytes in 200-char string is well above 1 % threshold); allow-button-tears-down-popup; deny-button-tears-down-popup; **falls back to the legacy layout when input_preview is malformed** (defence-in-depth — confirms the popup still surfaces SOMETHING actionable for a malformed Write payload, doesn't throw).

`src/client/writePermissionPreview.test.ts` (new file) gained a `describe('looksLikeBinaryContent (HS-8296)', ...)` block with 8 tests pinning the binary-classifier heuristic: pure ASCII text / multi-line UTF-8 / empty string / one-stray-bell / NUL-heavy content / control-char-heavy content / TAB/LF/CR whitelisted as text / 4 KB probe cap (binary garbage past the boundary doesn't flip the classification — perf guard so a 100 MB upload doesn't trigger a full scan).
