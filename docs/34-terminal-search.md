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
| `Esc` | Blur the input (HS-7393). Does NOT close the widget or clear the query — the widget stays expanded with its query intact and focus returns to the document. The global `Escape` handler in `shortcuts.tsx` handles the blur; this widget no longer binds `Escape` itself. Use the close (×) button for the explicit close/clear. |

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

**Automated (e2e).** `e2e/terminal-search.spec.ts` ships four Playwright tests (HS-7363) against a real PTY that runs `e2e/fixtures/terminal-search-fruits.sh` (prints `apple\nbanana\napple\napple\n` then `exec sleep 3600`): (1) drawer flow — open the widget, type `apple`, assert the count chip walks `1/3 → 2/3 → 3/3 → 2/3` across Enter / Shift+Enter, confirm HS-7393 Esc-blurs-only (input loses focus but widget + query + count stay intact), then assert the × close button clears the query and collapses the widget; (2) Cmd+F routing — focus the xterm helper textarea, press Meta+f, assert the terminal-search input is focused and `#search-input` is not; (3) dashboard dedicated view — enter the dashboard (sizer visible, header search slot hidden), double-click the tile, assert the slot is visible and the sizer is hidden, run a search (same `apple` → `1/3` assertion), click Back and assert the sizer is restored + the slot is hidden again; (4) grid-view regression — assert `#terminal-dashboard-search-slot` stays hidden while no dedicated view is up.

**Manual.** See `docs/manual-test-plan.md` §13 for what's left: visual amber/orange highlight colour, Cmd+F fall-through when focus is outside a terminal, Stop → Start clears search state, re-entering dedicated view for a DIFFERENT tile, and Esc-exits-dedicated-view parity with the Back button.

## 34.8 Regex / case / whole-word toggles (design only)

**Status:** Design complete (HS-7361), implementation pending under HS-7426.

Three checkbox-style icon toggles live inside the expanded `.terminal-search-box`, left of the prev/next chevrons, in `.terminal-search-toggles` grouping:

| Toggle | Lucide icon | `ISearchOptions` field | Default |
| --- | --- | --- | --- |
| Match case | `case-sensitive` | `caseSensitive: true` | off |
| Whole word | `whole-word` | `wholeWord: true` | off |
| Regex | `regex` | `regex: true` | off |

**Visual.** Same 28 px square size as the chevron buttons so the expanded width grows by ~84 px. Active state uses `background: var(--accent)` + `color: white`, inactive state uses the default toolbar-button palette. `aria-pressed="true"` / `false` reflects active state.

**Click behaviour.** Each toggle flips its boolean in a module-local `activeSearchOptions` object and immediately re-runs the current query through `addon.findNext(query, activeSearchOptions)` so the highlights + count update without requiring the user to re-press Enter. Empty input → no-op.

**Regex-specific.** When `regex` flips on and the current input does not parse as a valid `RegExp`, the input gets a `.is-invalid` class (red border via CSS) and the count chip shows `err` rather than `0/0`. `addon.findNext` silently no-ops on bad regex, so the widget swallows the thrown error in a `try/catch` and renders the `.is-invalid` state from the catch branch.

**Scope.** Per-terminal. Each `mountTerminalSearch` call owns its own `activeSearchOptions` instance so one drawer tab's regex mode doesn't leak into another. Sharing across widgets was considered and rejected: a user running `grep` output in one terminal and tailing a structured log in another has different expectations for case/regex defaults, and per-terminal matches the per-`TerminalInstance` model used elsewhere (runtime title / runtime cwd / shell-integration markers).

**Persistence.** Toggle state resets when the widget `closeBox`es (× click or magnifier toggle). Across PTY restart + drawer-tab activation cycles, state is reset by the existing teardown → re-mount path. No persistence across app launches — matches v1's session-only posture for the whole search feature.

**Keyboard.** No dedicated shortcut keys; the toggles are click-only. This keeps the widget's input-focused keyboard surface simple (Enter / Shift+Enter only) and avoids competing with xterm's own key bindings.

**Testing.** New unit tests covering (a) each toggle's aria-pressed / activeSearchOptions flip, (b) invalid-regex `.is-invalid` + `err` count path, (c) incremental re-run after each toggle. E2E spec extends `terminal-search.spec.ts` with one test that enables regex + types `app.e` + asserts 3 matches (dot matches any char in `apple`).

**Non-goals.** Multi-line regex flag, regex groups / capture / replace (search-only), fuzzy-match, persistence.

## 34.9 Recent-query history (design only)

**Status:** Design complete (HS-7362), implementation pending under HS-7427.

**UI.** When the input has focus and the cursor is at the start (for `ArrowUp`) or end (for `ArrowDown`) of the query — or any position if the input is empty — `ArrowUp` replaces the input with the previous history entry and `ArrowDown` with the next, matching readline / browser Find-bar / shell `HISTORY` convention. The current draft (what the user has typed but not yet submitted) is preserved at history position `-1`, so pressing Down past the newest entry restores it.

**Data model.** Module-local `historyByTerm: WeakMap<XTerm, string[]>` with an MRU-at-tail order (newest entry is `history[history.length - 1]`). Cap at **N = 10** entries per terminal. Duplicates within the cap are de-duped (if the user runs the same query again, the older entry is removed before the new one is pushed) so the 10-slot window is always 10 distinct queries.

**What gets recorded.** Only queries that are `findNext`/`findPrevious`-submitted via Enter / Shift+Enter (the explicit-advance path in §34.2) — not every incremental `input` keystroke. Empty queries are never recorded. Tested by running an incremental search that types `apples` then backspacing to `app` without Enter → no history entry.

**Scope.** Per-terminal (per xterm instance, matching the `WeakMap` above). Considered: shared across every mounted widget (single global ring). Rejected for the same reasons as §34.9 toggles — per-terminal matches the existing per-instance state model, and cross-terminal history would require answering "whose history takes precedence when Cmd+F opens the dedicated-view search right after closing the drawer search?" in a way that would surprise users. If cross-instance sharing is ever wanted, it's a plus-one on top of this design, not a replacement.

**Persistence.** Session-only. History lives in the module-level `WeakMap` and is wiped when the terminal's xterm is garbage-collected (PTY restart or drawer-tab destroy). Not persisted to `.hotsheet/settings.json` or any other file. Matches the "input state cleared on close" posture of §34.6.

**Interaction with the active session's draft.** If the user opens the widget, types `fo`, presses ArrowUp (which pulls the most recent history entry, say `foo`), then presses ArrowDown, the input should restore to `fo` — NOT empty. The history-navigation helper keeps a `currentDraft` ref that's seeded from `input.value` on the first ArrowUp and cleared on Enter / × close.

**Testing.** Unit tests for: push/MRU behaviour, N=10 cap with oldest-eviction, dup-handling, incremental-keystroke-not-recorded, ArrowUp-then-ArrowDown draft restoration. E2E spec extends `terminal-search.spec.ts` with one test that runs three distinct Enter-submitted queries then asserts ArrowUp walks back through them in MRU order.

**Non-goals.** Cross-app-launch persistence, per-project history merge, fuzzy-match on history, ArrowUp from a non-empty mid-position input (follows readline's "only-from-edges" rule to stay compatible with mid-word editing).

## 34.10 Cross-references

- [22-terminal.md](22-terminal.md) — drawer terminal toolbar hosts the search slot.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) §25.4 — tile-size slider which the dedicated-view search slot is mutually exclusive with.
- [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md) — structured jump-to-prompt shortcut, orthogonal to free-text search.
- [4-user-interface.md](4-user-interface.md) — the `.search-box` pattern on the app header that the terminal search widget echoes.
- **Tickets:** HS-7331 (this doc, widget shipped), HS-7361 (toggles design — shipped as §34.8), HS-7362 (history design — shipped as §34.9), HS-7363 (Playwright e2e — shipped, 4 tests in `e2e/terminal-search.spec.ts`), HS-7393 (Esc-blurs-only — shipped), HS-7426 (toggles implementation — pending), HS-7427 (history implementation — pending).
