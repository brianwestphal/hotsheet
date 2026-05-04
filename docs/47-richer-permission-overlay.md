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
- **Click the row** OR **click the pencil button** to open the modal rule editor (`openRuleEditor` in `permissionAllowListUI.tsx`). Reuses the `.cmd-editor-overlay` / `.cmd-editor-dialog` shell. Fields: tool select + pattern textarea (3 rows so long regexes wrap visibly) + inline validation against the same `^…$` anchoring the matcher uses. Cmd/Ctrl+Enter submits; Esc cancels; backdrop click cancels.
- **+ Add rule** button at the bottom of the list opens the same editor in `add` mode (header reads "Add allow rule", Save button reads "Add rule"). Pre-HS-8026 the page had an inline form (select + input + button) directly under the list; replaced by a single button so the add + edit flows share one validation path and the page stays uncluttered.
- Trash delete confirms (rule body shown) before PATCHing.

**HS-8026 cleanups (2026-04-29):** dropped the `Date Added` column (noise for the typical user) and the `Source (overlay / settings)` column (the "overlay" / "settings" wording confused users — the value is preserved on the rule for audit but no longer surfaced). Long patterns are no longer irrecoverably truncated — the `title` tooltip + the editor dialog both expose the full text.

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

1. **Detect truncation.** `permissionOverlay.tsx::showPermissionPopup` checks two truncation shapes: (a) the flat-string preview ending in `…` (legacy HS-7999 path — `extractStringField` appends `…` when the JSON body was cut mid-stream), and (b) **the parsed Edit/Write diff carrying `truncated: true`** (HS-8139 — pre-fix the snapshot path was skipped for any popup that successfully rendered the inline diff DOM, so a long Write payload truncated to a few `+` lines + a `… (truncated)` footer never triggered the buffer snapshot. Now either truncation indicator fires the snapshot.) Short prompts never trigger.
2. **Live-terminal checkout into the popup body (HS-8171 v2, supersedes the snapshot-based v1).** When a truncation indicator fires, `showPermissionPopup` builds a `.permission-popup-live-terminal` container and uses it as the popup body slot. After `openPermissionDialogShell(...)` returns (which `appendChild`s the overlay synchronously), the popup calls `checkout({projectSecret, terminalId: 'default', cols: 100, rows: 30, mountInto: container})` from `terminalCheckout.tsx` (§54). The §54 LIFO stack reparents the LIVE project xterm element into the popup container — the user can now scroll the real PTY scrollback AND type into the running `claude` directly from inside the popup. A deferred `requestAnimationFrame` call to `handle.fit.proposeDimensions()` + `handle.resize(...)` adapts the cols/rows to the popup container's measured layout. On every popup-close path (Allow / Deny → `respondToPermission`; X / Esc → `cleanupAndDismiss`; Minimize → `cleanupAndMinimize`; "No response needed" → `cleanupAndDismiss`) `releaseCheckoutIfAny()` calls `handle.release()` so the previous owner (drawer pane, dashboard tile, drawer-grid tile) re-takes the top of the stack and gets its own dims back.

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
- **HS-8206** (current) — replaced the single-rAF `proposeDimensions` + `resize` of the borrowed live terminal with a `ResizeObserver` mirroring `quitConfirm.tsx::HS-8055`. Pre-fix the single rAF fired before xterm's renderer had measured cell dims for the new layout (the term was just reparented out of the offscreen 1×1 parking sink), so `proposeDimensions()` returned undefined, the resize was skipped, and the term stayed at the initial 100×30 forever — `claude`'s TUI overflowed the 620×420 popup container, only the top-left ~67×24 cells were visible (the rest clipped by `overflow: hidden`). The new observer fires on initial layout completion AND on every subsequent layout change, with the same `pendingFit` rAF guard + skip-on-same-size short-circuit `quitConfirm` uses to avoid the well-known fit/observe feedback loop. The observer is disconnected from every popup-close path via `releaseActiveCheckoutIfAny()` (which now also calls `disconnectActiveLiveTermResizeObserver()`).

### Cost + risks (HS-8171 v2)

- **PTY redraw on resize.** The initial `checkout()` passes 100×30; the rAF-deferred fit then resizes to the popup's measured geometry. Claude's TUI redraws on each resize. When the popup releases, the previous owner's checkout reapplies its own dims and Claude redraws again. Two visible redraws per popup. Acceptable per the user's design call.
- **Bumped consumer.** If the user has the same project's drawer open with the `'default'` terminal mounted, that surface shows the §54 "Terminal in use elsewhere" placeholder for the duration of the popup. Documented design decision.
- **Interactive terminal inside the popup.** Clicking the xterm steals focus from the Allow / Deny buttons. The user explicitly approved this trade in the HS-8171 note.
- **Single in-flight popup.** `permissionOverlay.tsx` already serialises permission popups via `activePopupRequestId`, so two popups can't simultaneously try to check out the same `(secret, 'default')` and fight over its top-of-stack position.

### Tests

`src/client/terminalCheckout.test.ts` (25 tests) covers the §54 LIFO-swap behaviour the v2 flow relies on. The previously-extant `src/client/terminalSnapshot.test.ts` (23 tests) was deleted alongside `terminalSnapshot.ts` in HS-8177. `src/client/permissionOverlay.test.ts` (HS-8183) added 18 tests covering the polling-lifecycle state machine: show / no-show gates, two-consecutive-miss auto-dismiss threshold, jitter-recovery (miss counter resets when the request reappears mid-streak), the regression contract that fresh request_ids surface a popup after a clean auto-dismiss, dismissedRequestIds GC, partial-mount safety, and the HS-8206 ResizeObserver install / disconnect lifecycle for the live-term checkout body. Manual coverage lives in `docs/manual-test-plan.md` §12 — see "Permission popup — live-terminal checkout (HS-8171 v2)".
