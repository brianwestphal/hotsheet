# 34. Terminal find / search (HS-7331)

Every xterm surface in Hot Sheet gets a collapsible find widget wrapping xterm's `SearchAddon`. It matches the familiar Terminal.app / iTerm2 / VS Code "find in buffer" experience: a magnifier icon expands to an input with prev/next controls and a result count, `Enter` jumps to the next match, `Shift+Enter` to the previous, `Esc` closes.

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
| `Esc` | Close (same as ×) |

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

- **Regex / case-sensitivity / whole-word toggles.** xterm's `SearchAddon` supports these via `ISearchOptions`, but v1 keeps the UI minimal. Follow-up ticket HS-7361 tracks adding option toggles.
- **Multi-terminal search.** Each xterm is searched independently. "Find across every terminal in the project" is deferred.
- **Search history.** Input state is cleared on close; no most-recent-query recall. Follow-up HS-7362 if users request it.
- **Grid tile search.** Intentional per §34.1 rationale — dedicated view is the full-screen mode where find is useful.

## 34.7 Testing

**Automated.** 14 unit tests in `src/client/terminalSearch.test.ts` cover the DOM-free shell of the widget under `@vitest-environment happy-dom`. Stubs the `XTerm` + `SearchAddon` surface so the tests assert the widget's calls to `addon.findNext` / `findPrevious` / `clearDecorations` and the `onDidChangeResults`-driven count chip without needing a real terminal buffer.

**Deferred.** Playwright e2e tests covering the full round-trip (mount drawer + dedicated xterms against a real PTY, type a query, assert match-count chip + highlight decorations + Enter-advances-active-match) are tracked in follow-up ticket HS-7363. The fixture would emit a known multi-line output (e.g., `printf 'apple\nbanana\napple\ncherry\napple\n'`), open the search widget, type `apple`, and assert `3/3` + navigation.

**Manual.** See `docs/manual-test-plan.md` §12 for the full find checklist covering drawer open/close, dedicated-view mount point, Cmd+F focus routing, Esc close, live-input incremental search, count chip, and PTY-restart reset.

## 34.8 Cross-references

- [22-terminal.md](22-terminal.md) — drawer terminal toolbar hosts the search slot.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) §25.4 — tile-size slider which the dedicated-view search slot is mutually exclusive with.
- [32-osc133-jump-and-popover.md](32-osc133-jump-and-popover.md) — structured jump-to-prompt shortcut, orthogonal to free-text search.
- [4-user-interface.md](4-user-interface.md) — the `.search-box` pattern on the app header that the terminal search widget echoes.
- **Tickets:** HS-7331 (this doc), HS-7361 (regex/case-sensitivity/whole-word toggles — deferred), HS-7362 (search history — deferred), HS-7363 (Playwright e2e — deferred).
