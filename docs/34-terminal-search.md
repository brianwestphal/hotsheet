# 34. Terminal find / search (HS-7331)

Every xterm surface in Hot Sheet gets a collapsible find widget wrapping xterm's `SearchAddon`. It matches the familiar Terminal.app / iTerm2 / VS Code "find in buffer" experience: a magnifier icon expands to an input with prev/next controls and a result count, `Enter` jumps to the next match, `Shift+Enter` to the previous, `Esc` blurs the input (HS-7393) without clearing the query — the close (×) button is the explicit close/clear path.

Depends on [22-terminal.md](22-terminal.md) (embedded drawer terminal) and [25-terminal-dashboard.md](25-terminal-dashboard.md) (dashboard dedicated view). See also [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md) for the structured jump-to-prompt shortcuts, which are orthogonal — search is free-text, jumps are shell-integration-marker-driven.

## 34.1 Scope

Search is available in:

1. **Drawer terminals.** Every drawer terminal toolbar gets a `.terminal-search-slot` between the `.terminal-header-spacer` and the `.terminal-copy-output-btn` / power / clear trio. Collapsed, the slot renders only a magnifier-icon toggle.
2. **Dashboard dedicated view.** The search widget mounts into `#terminal-dashboard-search-slot`, a sibling of the tile-size slider in the app header. Grid view shows the slider and hides the search slot; dedicated view hides the slider (HS-7195) and shows the search slot — mutually exclusive.

Search is **not** available in the grid tiles themselves. Grid tiles are preview-scale, non-interactive by default (`pointer-events: none` on `.terminal-dashboard-tile-xterm`), and typing into a search input inside a tile while another tile is focused would be confusing. The dedicated view is the "full-screen" mode this spec calls out and is where find is appropriate.

## 34.2 UI behaviour

**Collapsed state.** A 28 px circular magnifier button. Clicking it toggles the box open; `Cmd+F` / `Ctrl+F` while a terminal is focused also opens it (§34.4).

**Expanded state (`.is-open`).** 240 px flex row, `background: var(--bg)`, `border: 1px solid var(--border)` (accent on focus-within). Contents left-to-right:

| Control | Behaviour |
| --- | --- |
| Magnifier toggle | Clicking toggles the box closed. |
| Text input | Placeholder: `Search` (drawer) or `Search <terminal label>` (dedicated view). Typing runs an *incremental* findNext so the highlight moves as you type. |
| Result count | `N/M` (1-based), `0/0` when the query has no matches. Empty when the input is empty. |
| Prev (chevron-up) | Runs `findPrevious` with `incremental: false`. Returns focus to the input. |
| Next (chevron-down) | Runs `findNext` with `incremental: false`. Returns focus to the input. |
| Close (×) | Clears the input, clears the search decorations, refocuses the terminal. |

**Keyboard inside the input:**

| Key | Action |
| --- | --- |
| `Enter` | `findNext` |
| `Shift+Enter` | `findPrevious` |
| `Esc` | Blur the input (HS-7393). Does NOT close the widget or clear the query — the widget stays expanded with its query intact and focus returns to the document. The global `Escape` handler in `shortcuts.tsx` handles the blur; this widget no longer binds `Escape` itself. Use the close (×) button for the explicit close/clear. In the dashboard dedicated view, the capture-phase Esc handler in `terminalDashboard.tsx` detects focus on the search input specifically and re-focuses the dedicated xterm instead of exiting back to the grid (HS-7526); a second Esc (now that focus is on the xterm and not the input) exits the dedicated view as before. |

**Width transition.** The `.terminal-search-box` animates `width` / `background` / `border-color` over 200 ms when `.is-open` toggles. Matches the `.search-box` pattern on the app header (§4) so the terminal find widget feels like the same family of input.

**Highlight palette.** The `SearchAddon.decorations` option is wired to amber/orange (`#f59e0b66` match fill with `#f59e0b` border, `#f97316cc` active-match fill with `#ea580c` border) rather than the app accent blue. This avoids collision with HS-7330's accent-tinted selection highlight — a user can have both a live selection AND an ongoing search and still distinguish the two.

## 34.3 Lifecycle

**Drawer terminal.**

- `mountXterm(inst, secret)` in `src/client/terminal.tsx` loads `SearchAddon`, calls `mountTerminalSearch(term, addon)` from the shared widget module, and replaces the header's `.terminal-search-slot` placeholder with the returned `handle.root`. The handle is kept on `TerminalInstance.searchHandle` and the addon on `TerminalInstance.search`.
- `teardown(inst)` disposes the search handle (clears `onDidChangeResults` + `clearDecorations`) before disposing the xterm.
- PTY restart (Stop/Start) runs teardown + re-attach, so the search state (query, open/closed) resets cleanly.

**Dashboard dedicated view.**

- `enterDedicatedView(tile, ...)` in `src/client/terminalDashboard.tsx` loads a `SearchAddon` for the dedicated xterm, mounts the widget into `#terminal-dashboard-search-slot` (the slot's inline `display: none` is replaced with `display: ''`), and records the handle on `DedicatedView.searchHandle`.
- `exitDedicatedView()` disposes the handle, clears + hides the slot, and then tears down the xterm/WebSocket in order (dispose BEFORE term.dispose so the `onDidChangeResults` subscription doesn't race with xterm disposal).
- `teardownAllTiles()` (called from `exitDashboard` via the project-tab / toggle-click / Esc paths) runs the same dedicated-view cleanup as a belt-and-suspenders.

## 34.4 Cmd/Ctrl+F routing

The existing global `Cmd/Ctrl+F` handler in `src/client/shortcuts.tsx` focuses the app-header ticket search (`#search-input`). HS-7331 extends it:

1. `isTerminalFocused()` (already exported from `shortcuts.tsx` for HS-6472 — walks `document.activeElement` up to `.drawer-terminal-pane` or `.xterm`) gates the terminal route.
2. When in a terminal, `focusActiveTerminalSearch()` (from `terminalSearch.tsx`) opens the most recently mounted search handle whose root is still in the DOM. The widget's `.focus()` adds `.is-open` and focuses the input.
3. If `focusActiveTerminalSearch()` returns `false` (no handles mounted, or the active handle's root has been removed) the shortcut falls through to the ticket search.

The xterm `attachCustomKeyEventHandler` for drawer + dedicated instances also returns `false` on `Cmd/Ctrl+F` so xterm does not forward the `f` to the shell. Returning `false` from xterm's custom handler stops xterm's internal processing but does NOT stop the event from bubbling to `document`, so the shortcuts-level handler still runs.

**HS-7460 — platform-specific routing.** Both the xterm-level swallow and the global handler now go through `isFindShortcut(e)` from `src/client/terminalKeybindings.ts` (see [22-terminal.md §22.18](22-terminal.md)). On macOS only `Cmd+F` matches; on Linux/Windows only `Ctrl+F` matches. When a terminal is focused and the user presses the wrong-platform variant (e.g. `Ctrl+F` on macOS, where readline expects `forward-char`):

- The xterm `attachCustomKeyEventHandler` returns `true`, so xterm forwards `\x06` to the shell as usual.
- The global `shortcuts.tsx` handler enters the `(metaKey || ctrlKey) && key === 'f'` branch but, after `isTerminalFocused()` returns `true`, also calls `isFindShortcut(e)` — that returns `false` for the wrong-platform variant, so the handler returns *without* `preventDefault()` and without focusing any search input. The keystroke effectively passes straight through to the shell.

Outside a terminal, both modifiers continue to focus the ticket search — the ticket-list has no conflicting use of `Ctrl+F`.

## 34.5 Shared widget module

All of the above is driven by `src/client/terminalSearch.tsx`:

- `mountTerminalSearch(term, addon, opts?)` builds the DOM, attaches every event handler, and returns `TerminalSearchHandle`.
- `TerminalSearchHandle` exposes `root`, `focus()`, `close()`, `isOpen()`, `dispose()`.
- Module-level `lastActiveHandle` is updated on mount and on input focus, consulted by `focusActiveTerminalSearch()` so Cmd/Ctrl+F routes to whichever terminal search the user was most recently touching — drawer or dedicated.
- `_resetTerminalSearchForTests()` is the test seam.

14 unit tests cover the widget's lifecycle (mount / focus / close / toggle / Enter / Shift+Enter / incremental input / empty-input clears / Esc / count updates / zero-results / dispose) and the `focusActiveTerminalSearch` dispatch (no-handle / active handle / handle removed from DOM).

## 34.6 Out of scope

- **Regex / case-sensitivity / whole-word toggles.** xterm's `SearchAddon` supports these via `ISearchOptions`, but v1 keeps the UI minimal. Design in §34.8 below (HS-7361); implementation pending under HS-7426.
- **Multi-terminal search.** Each xterm is searched independently. "Find across every terminal in the project" is deferred.
- **Search history.** Input state is cleared on close; no most-recent-query recall. Design in §34.9 below (HS-7362); implementation pending under HS-7427.
- **Grid tile search.** Intentional per §34.1 rationale — dedicated view is the full-screen mode where find is useful.

## 34.7 Testing

**Automated.** 14 unit tests in `src/client/terminalSearch.test.ts` cover the DOM-free shell of the widget under `@vitest-environment happy-dom`. Stubs the `XTerm` + `SearchAddon` surface so the tests assert the widget's calls to `addon.findNext` / `findPrevious` / `clearDecorations` and the `onDidChangeResults`-driven count chip without needing a real terminal buffer.

**Automated (e2e).** `e2e/terminal-search.spec.ts` ships Playwright tests (HS-7363 / HS-7427 / HS-7426 / HS-7526) against a real PTY that runs `e2e/fixtures/terminal-search-fruits.sh` (prints `apple\nbanana\napple\napple\n` then `exec sleep 3600`): (1) drawer flow — open the widget, type `apple`, assert the count chip walks `1/3 → 2/3 → 3/3 → 2/3` across Enter / Shift+Enter, confirm HS-7393 Esc-blurs-only (input loses focus but widget + query + count stay intact), then assert the × close button clears the query and collapses the widget; (2) Cmd+F routing — focus the xterm helper textarea, press Meta+f, assert the terminal-search input is focused and `#search-input` is not; (3) dashboard dedicated view — enter the dashboard (sizer visible, header search slot hidden), double-click the tile, assert the slot is visible and the sizer is hidden, run a search (same `apple` → `1/3` assertion), click Back and assert the sizer is restored + the slot is hidden again; (4) grid-view regression — assert `#terminal-dashboard-search-slot` stays hidden while no dedicated view is up; (5) HS-7427 recent-query history; (6) HS-7426 regex toggle; (7) HS-7526 dedicated-view Esc routing — focus the search input in the dedicated view, press Esc, assert the overlay is still visible, the input is blurred but the query is preserved, the widget stays `.is-open`, and the xterm helper textarea has focus; press Esc a second time and assert the overlay is removed (exit-to-grid parity preserved for the non-focused case).

**Manual.** See `docs/manual-test-plan.md` §13 for what's left: visual amber/orange highlight colour, Cmd+F fall-through when focus is outside a terminal, Stop → Start clears search state, re-entering dedicated view for a DIFFERENT tile, and Esc-exits-dedicated-view parity with the Back button.

## 34.8 Regex / case / whole-word toggles (HS-7426)

**Status:** Shipped.

Three checkbox-style icon toggles live inside the expanded `.terminal-search-box` in a `.terminal-search-toggles` `role="group"` cluster between the input and the count chip:

| Toggle | Lucide icon | `ISearchOptions` field | Default |
| --- | --- | --- | --- |
| Match case | `case-sensitive` | `caseSensitive: true` | off |
| Whole word | `whole-word` | `wholeWord: true` | off |
| Regex | `regex` | `regex: true` | off |

**Visual.** Same 20 px square size as the chevron buttons (the existing `.terminal-search-btn` rule). Active state uses `background: var(--accent)` + `color: white` via `.is-active`, inactive state inherits the default toolbar-button palette. `aria-pressed="true"` / `false` reflects active state.

**Click behaviour.** Each toggle flips its boolean in a per-mount `activeSearchOptions` object, calls `syncToggleButtons()` to mirror the new state into `aria-pressed` + `.is-active`, and immediately re-runs the current query through `addon.findNext(query, sOpts)` with `incremental: false` (a fresh non-incremental search) so highlights + count refresh from scratch — incremental finds can skip re-evaluation when the query string itself hasn't changed, which leaves stale highlights after a toggle flip. Empty input still no-ops the find.

**Regex-specific.** When `regex` is on, `doFind` validates the pattern up-front via `new RegExp(q)`. On `SyntaxError` it adds `.is-invalid` to the input + sets the count chip to `err` and skips the addon call. The `onDidChangeResults` callback also early-returns when `.is-invalid` is set so the addon can't overwrite `err` with `0/0`. The validation happens before the addon call rather than relying on xterm's behaviour because both versions (silent no-op vs. thrown `SyntaxError`) have shipped across xterm releases. The addon-side `try/catch` remains as a fallback for flag combinations xterm parses differently from V8.

**Scope.** Per-terminal. Each `mountTerminalSearch` call owns its own `activeSearchOptions` closure-local object so one drawer tab's regex mode doesn't leak into another. Sharing across widgets was considered and rejected: a user running `grep` output in one terminal and tailing a structured log in another has different expectations for case/regex defaults, and per-terminal matches the per-`TerminalInstance` model used elsewhere (runtime title / runtime cwd / shell-integration markers).

**Persistence.** Toggle state resets when the widget `closeBox`es (× click or magnifier toggle) via a shared `resetToggles()` helper that also clears `.is-invalid`. Across PTY restart + drawer-tab activation cycles the state is reset by the existing teardown → re-mount path (a fresh `mountTerminalSearch` runs and creates a new `activeSearchOptions` object). No persistence across app launches — matches v1's session-only posture for the whole search feature.

**Keyboard.** No dedicated shortcut keys; the toggles are click-only. This keeps the widget's input-focused keyboard surface simple (Enter / Shift+Enter / ArrowUp / ArrowDown only — see §34.9) and avoids competing with xterm's own key bindings.

**Testing.** 9 DOM-level integration tests in `terminalSearch.test.ts` cover: rendering (group + 3 buttons + initial aria-pressed=false), case toggle aria-pressed flip + re-run with `caseSensitive: true`, word toggle re-run with `wholeWord: true`, regex toggle on a valid pattern re-runs with `regex: true` and clears `.is-invalid`, regex toggle on invalid pattern (`[abc`) sets `.is-invalid` + `err` + skips the addon call, typing a valid pattern after an invalid-regex state clears `.is-invalid` + restores the count chip, two toggles combined (case + word) both reach the addon, × close resets all three toggles + clears `.is-invalid` for the next session, Enter submission honours active toggles with `incremental: false`. E2E in `e2e/terminal-search.spec.ts` "drawer: regex toggle on `app.e` matches three lines (HS-7426)" enables regex via the toggle button, fills `appl.` (`.` matches any char), asserts the count chip reads `1/3`, switches to `[abc` and asserts `.is-invalid` + `err`, then disables regex and asserts the literal-search path returns `0/0`.

**Non-goals.** Multi-line regex flag, regex groups / capture / replace (search-only), fuzzy-match, cross-app-launch persistence.

## 34.9 Recent-query history (HS-7427)

**Status:** Shipped.

**UI.** When the input has focus and the cursor is at the start (for `ArrowUp`) or end (for `ArrowDown`) of the query — or any position if the input is empty — `ArrowUp` replaces the input with the previous history entry and `ArrowDown` with the next, matching readline / browser Find-bar / shell `HISTORY` convention. The current draft (what the user has typed but not yet submitted) is preserved at history position `history.length`, so pressing Down past the newest entry restores it.

After the first `ArrowUp` away from draft mode the cursor convention is "in-history": every subsequent `ArrowUp` / `ArrowDown` walks the history regardless of caret position (the readline-style edge check only gates the *first* navigation away from a mid-edit draft). The newly displayed value's caret lands at the end so re-pressing the same arrow keeps walking.

**Data model.** Module-local `historyByTerm: WeakMap<XTerm, string[]>` in `terminalSearch.tsx` with MRU-at-tail order (newest entry is `history[history.length - 1]`). Cap at **N = 10** entries per terminal. Duplicates within the cap are de-duped (if the user runs the same query again, the older entry is removed before the new one is pushed) so the 10-slot window is always 10 distinct queries.

The push / cursor logic is two pure helpers in `src/client/terminalSearchHistory.ts`:

- `pushHistory(history, query, cap=10) → string[]` — returns a new ring with `query` appended (MRU-at-tail), de-duped, capped. Empty / whitespace queries are no-ops. Does not mutate the input array.
- `navigateHistory(history, cursor, direction, currentDraft) → {value, cursor}` — `cursor === history.length` means draft mode (returns `currentDraft`); `0` is the oldest entry; `history.length - 1` is MRU. `'up'` decrements (clamped at 0), `'down'` increments (clamped at `history.length`).

**What gets recorded.** Only queries that are `findNext`/`findPrevious`-submitted via Enter / Shift+Enter (the explicit-advance path in §34.2) — not every incremental `input` keystroke. Empty queries are never recorded. Verified by a unit test that simulates typing `apples → app` via `input` events and asserts a subsequent `ArrowUp` is a no-op (history empty).

**Scope.** Per-terminal (per xterm instance, matching the `WeakMap` above). Considered: shared across every mounted widget (single global ring). Rejected for the same reasons as the §34.8 toggles — per-terminal matches the existing per-instance state model, and cross-terminal history would require answering "whose history takes precedence when Cmd+F opens the dedicated-view search right after closing the drawer search?" in a way that would surprise users. If cross-instance sharing is ever wanted, it's a plus-one on top of this design, not a replacement.

**Persistence.** Session-only. History lives in the module-level `WeakMap` and is wiped when the terminal's xterm is garbage-collected (PTY restart or drawer-tab destroy). Not persisted to `.hotsheet/settings.json` or any other file. Matches the "input state cleared on close" posture of §34.6.

**Interaction with the active session's draft.** If the user opens the widget, types `fo`, presses `ArrowUp` (which pulls the most recent history entry, say `foo`), then presses `ArrowDown`, the input restores to `fo` — NOT empty. The mount-time integration in `terminalSearch.tsx` keeps a `currentDraft` closure variable that's snapshotted from `input.value` the first time the user navigates away from draft mode (`cursor === history.length`) and cleared on Enter / × close / typing.

**Reset triggers.** The history-navigation cursor + `currentDraft` are reset whenever:

- The user presses Enter / Shift+Enter (submission also pushes to history).
- The user types into the input (the `input` event listener resets back to draft mode so a subsequent `ArrowUp` snapshots the new draft).
- The × close button fires (`closeBox` → `resetHistoryNav`).

The history ring itself is NOT cleared by any of these — it persists for the lifetime of the xterm instance.

**Testing.** Pure-helper unit tests in `terminalSearchHistory.test.ts` (14 tests covering push MRU / cap / custom cap / cap-of-zero / dedup-bumps-tail / dedup-before-cap / empty-query-noop / no-mutation, plus navigateHistory empty / first-up / walk-up / oldest-stays / walk-down / draft-restore / out-of-range-clamp / no-mutation / round-trip-draft). DOM-level integration tests in `terminalSearch.test.ts` (7 tests covering ArrowUp 3-query MRU walk / ArrowDown draft restoration with caret-at-start edge guard / incremental typing not recorded / Shift+Enter submissions also recorded / dedup-bump-after-three-submissions / mid-edit caret-not-at-edge suppression / × close resets cursor for next session). E2E in `e2e/terminal-search.spec.ts` "drawer: ArrowUp walks back through three submitted queries (HS-7427)" runs three Enter-submitted queries against the real fruits PTY then asserts both `ArrowUp` (MRU walk) and `ArrowDown` (draft restoration) work end-to-end.

**Non-goals.** Cross-app-launch persistence, per-project history merge, fuzzy-match on history, ArrowUp from a non-empty mid-position input (follows readline's "only-from-edges" rule to stay compatible with mid-word editing).

## 34.10 Cross-references

- [22-terminal.md](22-terminal.md) — drawer terminal toolbar hosts the search slot.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) §25.4 — tile-size slider which the dedicated-view search slot is mutually exclusive with.
- [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md) — structured jump-to-prompt shortcut, orthogonal to free-text search.
- [4-user-interface.md](4-user-interface.md) — the `.search-box` pattern on the app header that the terminal search widget echoes.
- **Tickets:** HS-7331 (this doc, widget shipped), HS-7361 (toggles design — shipped as §34.8), HS-7362 (history design — shipped as §34.9), HS-7363 (Playwright e2e — shipped, in `e2e/terminal-search.spec.ts`), HS-7393 (Esc-blurs-only — shipped), HS-7426 (toggles implementation — shipped, see §34.8), HS-7427 (history implementation — shipped, see §34.9), HS-7460 (platform-specific Cmd/Ctrl+F routing — shipped, see §34.4), HS-7525 (widen the input so the toggle cluster and count chip fit alongside a realistic query — shipped), HS-7526 (dedicated-view Esc: blur search input + focus xterm before exiting — shipped, see §34.2 + [25-terminal-dashboard.md](25-terminal-dashboard.md) §25.8).
