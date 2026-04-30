# Manual Test Plan

This document lists features that require manual verification before each release. These are things that can't be reliably automated in headless Playwright due to drag-and-drop limitations, platform-specific behavior, real-time timing, or visual appearance requirements.

**When to run:** Before every release or after significant changes to the areas listed below.

**How to use:** Walk through each section, check the items, note any failures. File tickets for anything broken.

---

## 1. Drag-and-Drop

### Column/Kanban View
- [ ] Drag a ticket card from "Not Started" column to "Started" — status updates
- [ ] Drag a card to "Completed" — issue closes, strikethrough appears
- [ ] Drop zone highlights visually on dragover
- [ ] Per-column scroll position preserved during drag

### Sidebar Drag Targets
- [ ] Drag a ticket onto a sidebar status item (e.g., "Completed") — status changes
- [ ] Drag a ticket onto a sidebar category item — category changes

### File Attachments
- [ ] Drag a file over the detail panel — dashed accent outline appears
- [ ] Drag over nested child elements — outline stays stable (no flicker)
- [ ] Drop one or more files — uploads sequentially, attachments list refreshes
- [ ] Outline disappears on drag leave

### Project Tabs
- [ ] Drag a tab to reorder — drop indicator shows insertion point
- [ ] Release — tab order persists across reload

### Command Groups (Settings)
- [ ] Drag a command to reorder within a group
- [ ] Drag a command into a different group — membership changes
- [ ] Drag a command out of a group to the top level
- [ ] Drag a group header to reorder groups

---

## 2. Platform-Specific (Run on Each Target OS)

### Reveal in Finder / File Manager
- [ ] macOS: "Show in Finder" on an attachment opens Finder with file selected
- [ ] Windows: opens Explorer with file selected
- [ ] Linux: opens the containing directory with xdg-open

### Tauri Desktop App
- [ ] Native window title displays correctly (custom appName or "Hot Sheet")
- [ ] Sidecar Node server starts and stops with the app
- [ ] CLI installer works: `hotsheet` command available after install
- [ ] "Check for Updates" button finds updates from GitHub releases
- [ ] "Install Update" downloads and prompts for restart
- [ ] Download links in notes open in system browser (not webview)

### App Icon (Tauri Only)
- [ ] Icon variant dropdown in Settings → General shows thumbnail grid
- [ ] Clicking a variant updates the dock icon immediately (no relaunch)
- [ ] Selected variant persists across restarts

---

## 3. Claude Channel

### Play Button
- [ ] Green play button appears in sidebar when channel is enabled
- [ ] Single-click: triggers Claude to process Up Next (pulse animation)
- [ ] Single-click with no Up Next: yellow warning banner appears, auto-dismisses after 4 seconds
- [ ] Double-click: toggles automatic mode (icon changes to fast-forward)
- [ ] Double-click again: returns to play icon (auto mode off)

### Automatic Mode
- [ ] When Up Next items are added, Claude is triggered after 5-second debounce
- [ ] Backoff works: subsequent auto-triggers use increasing intervals (5s → 10s → 20s → ...)
- [ ] "Claude working" spinner shows during processing
- [ ] "✓ Claude idle" status appears on completion, auto-hides after 5 seconds

### Permission Popup
- [ ] Popup appears anchored to the owning project's tab when Claude requests tool permission (HS-6536 — same popup for active and background tabs; the old full-screen overlay is gone)
- [ ] "Allow" grants the permission; "Deny" rejects it
- [ ] Clicking outside the popup **minimizes** it (not dismisses) — the popup disappears and the owning tab's blue dot starts pulsating (HS-6637)
- [ ] Clicking the owning project tab while the popup is open also minimizes it (the tab's click does not bounce the popup back open)
- [ ] Clicking the pulsating tab re-shows the exact same popup (and switches project if needed)
- [ ] If the popup is minimized, the tab dot keeps pulsating until the user clicks the tab, responds, clicks "No response needed", or 2 minutes elapse (auto-dismiss)
- [ ] Bottom-left **"No response needed"** link dismisses the popup without minimizing; attention dot stays blue (non-pulsating), and the popup does not re-appear until a new request_id arrives (HS-6637)
- [ ] After dismissing via "No response needed" once, the next poll cycle (~100 ms later) does **not** immediately re-show the same popup (HS-6436)
- [ ] When a different request_id arrives later (the channel server gets a new permission), the popup does show — dismissed-tracking is per-request, not per-project
- [ ] Popup shows the full description (no 100-char truncation) and the input_preview block if Claude provided one (HS-6476)
- [ ] For Bash permissions, the preview shows just the command (no `{"command":"…"}` JSON wrapper). Long/truncated commands show the recovered prefix with a trailing `…` (HS-6634)
- [ ] Command log entry for the response includes the tool name, description, and input_preview — not just `{request_id, behavior}` (HS-6477)

### Visibility
- [ ] Channel UI hidden if Claude CLI version < 2.1.80
- [ ] Channel toggle in Settings → Experimental registers `.mcp.json`

---

## 4. Shell Commands

- [ ] Shell command button in sidebar executes the configured command
- [ ] "Shell running" busy indicator shows while process executes
- [ ] Command log entry shows stdout/stderr with `---SHELL_OUTPUT---` separator
- [ ] Stop button (square icon) appears for running processes
- [ ] Stop sends SIGTERM; if process doesn't exit in 3 seconds, SIGKILL follows
- [ ] Working directory is the project root (parent of `.hotsheet/`)

---

## 5. Command Groups (Sidebar)

- [ ] Ungrouped commands appear at top level above group headers
- [ ] Group header click toggles collapse/expand
- [ ] Collapse state persists across page reload
- [ ] Groups with no visible commands are hidden from sidebar
- [ ] Inline group name editing: click name → edit → blur saves

---

## 6. Share Prompt

- [ ] Footer link reads "Know someone who'd love this? Share Hot Sheet"
- [ ] Clicking share link triggers Web Share API (or clipboard fallback)
- [ ] Share banner appears after 5 minutes total usage + 1 minute current session
- [ ] "Share" button sets shareAccepted: true (banner never shows again)
- [ ] "Not now" records timestamp; banner reappears after 30 days
- [ ] Banner does NOT appear if shareAccepted is already true

---

## 7. CLI / Server Startup

- [ ] `hotsheet --port 5000` starts on port 5000
- [ ] `hotsheet --data-dir /custom/path` stores data there
- [ ] `hotsheet --no-open` starts without opening browser
- [ ] Second `hotsheet` launch in a different directory reuses the running instance
- [ ] `hotsheet --list` shows registered projects with ticket counts
- [ ] `hotsheet --close` unregisters the current project
- [ ] Stale lock files from crashed processes are cleaned up on startup
- [ ] Port fallback: if 4174 is in use, tries 4175–4193

---

## 8. Demo Mode

- [ ] `hotsheet --demo:1` loads sample tickets in list view
- [ ] `hotsheet --demo:7` loads in column/kanban view
- [ ] `hotsheet --demo:10` shows multiple project tabs
- [ ] Browser title shows "Hot Sheet Demo"
- [ ] Demo data is ephemeral (gone after closing)

---

## 9. Backup / Restore

- [ ] Preview mode: clicking "Preview" on a backup shows a banner with backup date
- [ ] Detail panel is read-only during preview (inputs disabled)
- [ ] "Cancel Preview" returns to live data
- [ ] Restore: safety backup is created before restoring
- [ ] Restored state matches the backup (post-backup tickets are gone)
- [ ] Custom backupDir setting stores backups in the configured location

---

## 10. Visual / Styling

- [ ] Completed/verified tickets show strikethrough + muted text
- [ ] Detail panel resize handle works (drag to resize, size persists)
- [ ] Search input animates wider on focus, shrinks on blur
- [ ] Dropdown menus position correctly (clamped to viewport)
- [ ] Plugin toolbar buttons: icon-only in toolbar, icon+label elsewhere
- [ ] Toast notifications slide up from bottom, auto-dismiss after 3 seconds
- [ ] Combo box dropdown in plugin settings shows filtered options, selects on click
- [ ] **HS-7360 search state per project.** With two projects (A and B), type `foo` into the app-header search on A. Switch to B — the input clears and the pill shrinks back. Switch back to A — the input re-shows `foo` and the pill stays expanded. Repeat with a different query in B to confirm independence.
- [ ] **HS-7360 clear button.** Type into the search input — a Lucide circle-x button appears on the right. Click it — the input clears, tickets reload, focus returns to the input, and the pill shrinks back.
- [ ] **HS-7360 session-only state.** Type a query, close and relaunch the app — the query is gone on restart (per-project search map is in-memory only).
- [ ] **HS-7360 project removal.** Type into search on project A, close project A's tab. Re-add the same folder as a project. Its search field is empty (stale state cleared on removal).
- [ ] **HS-7393 Esc in the app-level search.** Select a ticket so it shows `.selected`. Focus the search input and type a query. Press Esc — the input should lose focus but its value should remain, and the selected ticket should stay selected. Previously Esc cleared the field AND deselected tickets.
- [ ] **HS-7393 Esc in a terminal search widget.** Open a terminal's search widget, type a query that matches, press Esc. Focus should leave the input but the widget stays expanded with its query + highlights intact. The close (×) button and the magnifier toggle remain the only paths that close + clear the widget.
- [ ] **HS-7364 search matches notes.** Add a note to a ticket with a distinctive word that does NOT appear in its title or details (e.g. `pineapple`). Type that word into the app-header search. The ticket should appear in the filtered list.

---

## 11. Keychain / Secure Storage

- [ ] On macOS: plugin secret (e.g., GitHub PAT) is stored in Keychain after first read
- [ ] Verify via `security find-generic-password -s com.hotsheet.plugin.github-issues -a token -w`
- [ ] If Keychain is locked/unavailable, falls back to file storage silently
- [ ] On Linux: `secret-tool lookup service com.hotsheet.plugin.github-issues account token` returns the value

## 12. Embedded Terminal

See [22-terminal.md](22-terminal.md). Requires `terminal_enabled: true` in `.hotsheet/settings.json` or via Settings → Experimental → Embedded Terminal.

### Default command resolution (§22.5)
- [ ] With `claude` on PATH + Claude Channel enabled: Terminal launches `claude --dangerously-load-development-channels server:hotsheet-channel` (verify from `ps` or from xterm header)
- [ ] With `claude` on PATH + Channel disabled: Terminal launches plain `claude`
- [ ] Without `claude` on PATH: Terminal launches `$SHELL` (Unix) / `%COMSPEC%` (Windows)
- [ ] Custom `terminal_command` with no `{{claudeCommand}}` token is passed verbatim

### Quit confirmation when terminals are running (HS-7591 / HS-7596, §37)
- [ ] **Idle shell only** — open the drawer with a configured `zsh` terminal that's been at a prompt for a while. ⌘Q. App quits silently with no prompt (the shell IS the login shell, so there's nothing the user might be losing).
- [ ] **Shell running `claude`** — start `claude` inside a drawer terminal. ⌘Q. Prompt fires listing `claude (claude)` under the project name. Cancel: app stays open, claude continues. Quit Anyway: claude is killed and app exits.
- [ ] **Shell running `htop`** — start `htop` (or `tmux`, `less`, etc. — anything in the default exempt list) inside a drawer terminal. ⌘Q. Prompt does NOT fire — quit silently. (`htop` is in the exempt list because it's trivially exited via `q`.)
- [ ] **Multiple projects with mixed running terminals** — open two projects, one with `claude` running, one idle. ⌘Q. Prompt fires listing only the project with `claude` running. After Quit Anyway, both projects' terminals are killed.
- [ ] **Setting set to `'never'`** — Settings → Terminal → "Quit confirmation" → select "Never". Run anything in a terminal. ⌘Q. No prompt, silent quit.
- [ ] **Setting set to `'always'`** — select "Always" in the same Settings panel. Even with no terminals running, ⌘Q fires the prompt with an empty terminal list. Cancel keeps the app open, Quit Anyway proceeds.
- [ ] **Custom exempt list** — add `node` to the exempt textarea. Run `node` directly in a drawer terminal. ⌘Q. No prompt fires (node is now exempt).
- [ ] **Reset exempt list to defaults** — click "Reset exempt list to defaults" in the Settings panel. Confirm the textarea repopulates with the macOS Terminal.app default `{screen, tmux, less, more, view, mandoc, tail, log, top, htop}`.
- [ ] **All quit paths gate.** ⌘Q on macOS, Alt+F4 on Windows/Linux, the red traffic-light close button, and `hotsheet --close` (run with a non-exempt terminal alive in the project) all show the prompt.
- [ ] **`hotsheet --close --force`** — run from a project with a non-exempt running terminal. The prompt is skipped + the project is unregistered immediately.
- [ ] **Don't ask again checkbox** — fire the prompt, check "Don't ask again for any project", click Quit Anyway. Restart Hot Sheet. Confirm every project's `confirm_quit_with_running_terminals` is now `'never'` (open Settings → Terminal → "Quit confirmation" for each project).
- [ ] **One-level-deeper rule (shell-rooted)** — terminal command is `zsh`, run `vim`, then ⌘Q. Prompt fires listing `vim (vim)` (vim isn't in the default exempt list). Edit Settings → Terminal → exempt list to add `vim`, ⌘Q again — prompt does NOT fire.
- [ ] **Non-shell base command** — terminal command is `claude` directly (not `zsh -c claude`). PTY root is claude. ⌘Q. Prompt fires listing `claude (claude)`.
- [ ] **Stale-instance cleanup bypasses** — start Hot Sheet, then start a SECOND Hot Sheet with `--replace`. The first one is killed by the stale-instance flow. NO prompt is shown (the user is already quitting through the new window).

### PTY size resync after Terminal Dashboard exit (HS-7592, §22 / §25)
- [ ] Open the drawer with a configured terminal active (e.g. `claude` or a shell) — confirm the prompt fits the drawer width.
- [ ] Run something that writes to the full screen width (e.g. `printf '%s\n' "$(printf '%-200s' '=')"` to print a 200-char banner, or `htop`).
- [ ] Open the Terminal Dashboard (`#terminal-dashboard-toggle`). Double-click that terminal's tile to enter the dedicated full-viewport view. The PTY resizes to dashboard-pane dims (much wider/taller than the drawer).
- [ ] Click Back, then click the toggle again to exit the dashboard and return to the drawer. The drawer terminal should immediately show output formatted for the **drawer's** dims again — long lines wrap at the drawer's width, not the dashboard's. Hit Enter at the prompt; new shell output should not run off the right edge of the drawer.
- [ ] Regression check: before HS-7592 the PTY stayed at dashboard-pane cols/rows after exit until the user happened to drag the drawer enough to trigger a fit() resize. The fix exports `resyncActiveTerminalPtySize()` from terminal.tsx and calls it from `exitDashboard()` so the PTY snaps back unconditionally.

### Persistence and reattach (§22.4, §22.7)
- [ ] Open Terminal tab, type a long-running command (`watch date` or similar), close drawer → reopen → still running, scrollback replayed
- [ ] Switch to Commands Log tab and back → Terminal state preserved (process still alive, cursor position intact)
- [ ] Reload the browser with terminal running → reattaches and replays scrollback (process keeps running on server)
- [ ] Stop button (power toggle) while running: clicking once sends SIGTERM and the button enters stop-pending state
- [ ] Stop-pending second click while still alive: confirm dialog appears; OK issues SIGKILL and the process dies
- [ ] Once the process has exited, the button flips to Start and clicking it spawns a fresh PTY (scrollback cleared)
- [ ] Running process exits on its own (`exit` in shell) → Terminal tab shows exit code, Start button spawns a new PTY

### Multi-window sharing (§22.8)
- [ ] Open the same project in a second browser window → both windows attach to the same PTY
- [ ] Typing in either window reaches the PTY; both see the same output stream
- [ ] Closing one window leaves the other connected; PTY stays alive

### Lifecycle
- [ ] `DELETE /api/projects/:secret` while a terminal is running → PTY is killed
- [ ] Send SIGTERM to the Node server with a terminal running → PTY is killed cleanly (no orphan processes in `ps`)

### Title and bell (§23, HS-6473)
- [ ] In a terminal, run `printf '\\033]0;custom-title\\007'` — **only the in-pane terminal toolbar** switches to "custom-title". The drawer tab keeps its static name (HS-6473 follow-up: runtime titles apply to the toolbar only, since shell-pushed titles are per-cwd and would clutter the narrow drawer tab)
- [ ] Restart the PTY (Stop → Start) — the toolbar reverts to the configured name (e.g. "claude" or "zsh") until the new process pushes its own title
- [ ] In terminal A while terminal B is the active drawer tab, run `printf '\\007'` (or `tput bel`) — terminal A's tab gains a wiggling bell glyph
- [ ] Click terminal A — the bell glyph clears as soon as the tab activates
- [ ] Bell fired in the *currently active* terminal does not produce an indicator (the user is already looking)

#### Cross-project bell (§24, HS-6603)
- [ ] In project A's terminal, run `printf '\007'` while project B is active — project A's tab gains a bell glyph (small Lucide bell, accent color, one-shot 350 ms wiggle)
- [ ] Switch to project A — the project-tab bell clears immediately on activation
- [ ] The in-drawer terminal tab for the bell-emitting terminal still shows its bell glyph after the project switch
- [ ] Click that terminal tab — its bell glyph clears (both locally and server-side, so other polling clients observe the clear)
- [ ] Switch back to project B — project A's tab no longer shows a bell (all its per-terminal bells were acknowledged in the previous step)
- [ ] Bell fires in a lazy terminal that has never been spawned: no indicator anywhere (a lazy terminal without a session cannot run, so cannot bell)
- [ ] Restart the Hot Sheet server while bells are pending — all indicators clear on restart (bellPending is in-memory only by design)

#### Auto-clear bell when viewing in dashboard / drawer-grid (HS-8046)
- [ ] Open the global terminal dashboard (per §25). With at least one terminal tile in the viewport, run `printf '\007'` (or `tput bel`) inside that terminal. The tile does NOT gain a `.has-bell` glyph — the user is already looking at it. The project-tab bell glyph also does NOT light up (server-side `bellPending` is cleared synchronously)
- [ ] Same dashboard, scroll a tile OUT of the viewport, fire `\007`, then scroll the tile back in. The tile briefly shows the bell glyph while off-viewport; on scroll-back-in the glyph clears immediately
- [ ] In the dashboard, single-click a tile to enter centered mode. While centered, fire `\007` in any OTHER (non-centered) terminal. That terminal's tile DOES gain `.has-bell` (it's behind the centered overlay — user can't see it). Dismiss the centered overlay — the bell on that tile clears immediately (occlusion lifted)
- [ ] In the dashboard, double-click a tile to enter dedicated view. While dedicated, fire `\007` in any OTHER terminal. Exit the dedicated view — that tile's bell clears immediately
- [ ] Repeat the first three checks in the per-project drawer terminal grid (§36 toolbar toggle) — same auto-clear behaviour
- [ ] **Hidden terminals are NOT affected.** With Show / Hide Terminals (§38 / §39) hiding a terminal that's currently bell-pending, the project-tab bell glyph stays lit (the user CAN'T see the terminal — its bell must remain). When the user un-hides it and the tile becomes visible, the bell auto-clears as above

### Rendering and input (§22.6)
- [ ] No black strip appears below the last rendered row (xterm viewport background matches the app theme even when container is taller than rows × cellHeight)
- [ ] Click into a terminal — focus ring (2 px accent border) appears on all four edges of the terminal pane, including the **bottom** (HS-6635 regression check). Click outside — ring disappears.
- [ ] Drag drawer resize handle → xterm reflows, shell inside (e.g. `claude` UI, `htop`) resizes correctly
- [ ] Commands Log tab vertically fills the entire drawer (no empty space below the entries area). HS-6404: was caused by `.drawer-terminal-panes` taking flex:1 alongside the commands-log pane; the wrapper now uses `display: contents` so only the active pane claims space.
- [ ] Switching from Commands Log to a Terminal tab and back: each pane fills the full drawer height in turn
- [ ] 256-color and true-color output renders (test with `echo -e "\033[38;5;196mred\033[0m"` and a truecolor printer)
- [ ] Clickable URL detected and opens in browser on click
- [ ] Copy (Cmd/Ctrl+C with selection) puts text on clipboard
- [ ] SIGINT (Cmd/Ctrl+C with no selection) interrupts running process
- [ ] Paste (Cmd/Ctrl+V) works correctly
- [ ] Click-and-drag across output in a drawer terminal paints a **clearly visible** accent-coloured selection highlight (HS-7330 regression check — previously invisible on the white theme). Repeat in the dedicated dashboard view (double-click a tile in the dashboard or the drawer-grid).
- [ ] **HS-8010 — selection disabled in centered tile.** Open the dashboard, single-click a tile to enter centered mode (NOT double-click). A small "Double-click to select text" chip appears in the top-right of the centered preview. Click-drag across the xterm body — no selection paints, no offset highlight. Double-click → dedicated view → selection drag works there. Repeat the same flow with the drawer terminal grid (toolbar → grid view → single-click to center).
- [ ] Move keyboard focus out of the terminal (click a ticket) — the selection stays visible but its fill drops to the lower-alpha inactive variant
- [ ] With the drawer terminal focused, press **Cmd+K** (macOS) or **Ctrl+K** (Linux/Windows) — the viewport clears and scrollback drops; the current prompt stays at the top of the pane (HS-7329). Repeat in a centered dashboard tile and in the dedicated dashboard view.
- [ ] Repeat the clear test while a TUI like `vim` or `nano` is running — the clear fires even though the TUI would normally consume the shortcut (matches Terminal.app / iTerm2)
- [ ] **HS-7459 regression check on macOS**: with the drawer terminal focused, type a long line and then press **Ctrl+K** (not Cmd+K) — readline's `kill-line` fires (cursor-to-end deletion) and the viewport is NOT cleared. This verifies we no longer hijack Ctrl+K on macOS.
- [ ] **HS-7460 regression check on macOS — Ctrl+F**: with the drawer terminal focused, press **Ctrl+F** (not Cmd+F). Readline's `forward-char` fires (cursor advances by one character) and the terminal-search widget does NOT open. The app-header ticket-search input is also NOT focused. Then press **Cmd+F** — the terminal-search widget DOES open. Repeat in the dashboard dedicated view.
- [ ] **HS-7460 regression check on macOS — Ctrl+Up/Down**: with the drawer terminal focused (and shell integration enabled — Settings → Terminal → "Enable shell integration UI" checked, plus an OSC 133 prompt in the buffer), press **Ctrl+Up** and **Ctrl+Down**. The viewport does NOT jump between OSC 133 markers; instead xterm forwards the escape sequence to the shell (e.g. tmux pane resize, vim/nvim, fish-shell history-token-search). Then press **Cmd+Up** / **Cmd+Down** — those DO jump between OSC 133 prompt markers.
- [ ] **HS-7460 outside-terminal sanity check**: with focus in the ticket list (NOT in a terminal), press both **Cmd+F** and **Ctrl+F** on macOS — both still focus the app-header ticket search (no platform restriction outside a terminal — the ticket list has no conflicting use of Ctrl+F).
- [ ] Press **Ctrl+Shift+K** — readline's kill-line passes through (the Shift modifier is deliberately excluded from the clear match on Linux/Windows)

### Tauri desktop (§22.11)
- [ ] Terminal works inside the Tauri window on macOS arm64 + x86_64
- [ ] Terminal works inside the Tauri window on Linux x86_64
- [ ] Terminal works inside the Tauri window on Windows (ConPTY via node-pty)
- [ ] On a release build, open a Terminal tab and run a trivial command (echo hello / cmd /c echo hello) to verify the bundled `node-pty` native binary loads

### Drawer tab visibility (§22.10)
- [ ] With `terminal_enabled: false` (default): Terminal tabs are hidden in the drawer
- [ ] Toggle `terminal_enabled` on in Settings → Experimental → Terminal tabs appear immediately (no reload)
- [ ] Toggle off while a Terminal tab is active → drawer falls back to Commands Log

### Multi-terminal UI (§22.17)
- [ ] Configured default terminals in `settings.terminals` each get a tab in the drawer, in settings order
- [ ] Adding a terminal in Settings → Experimental → Embedded Terminal appears as a tab on save (no reload)
- [ ] Renaming a terminal in Settings updates the drawer tab label
- [ ] Reordering via drag changes drawer tab order
- [ ] The **+** button after the last tab creates a new dynamic terminal running the default shell; new tab is selected
- [ ] Dynamic terminal tabs show an **×** close button; clicking tears down the PTY and removes the tab
- [ ] Configured default terminal tabs do **not** show a close button (only removable via Settings)
- [ ] Many tabs overflow → the tabs area scrolls horizontally (Commands Log stays pinned; **+** stays visible at the end when scrolled fully right)

### Eager-spawn (§22.17.8)
- [ ] Set `lazy: false` on a configured terminal via Settings → Experimental; click Done. The terminal's PTY starts immediately (process visible in `ps`) without opening the drawer
- [ ] Restart the Hot Sheet server with a non-lazy terminal configured. Inspect `ps`: the PTY is already running before any browser window opens
- [ ] Open the drawer after an eager terminal has been running for a while: the terminal shows the accumulated scrollback on first attach
- [ ] Flip a terminal from `lazy:false` to `lazy:true`: the running PTY keeps running (no retroactive kill) but subsequent restarts will be lazy
- [ ] A broken command on an eager terminal surfaces in the xterm output on first attach; the server stays up (failure is best-effort)

### Per-project drawer state (§22.17.7)
- [ ] Open the drawer + activate a specific terminal tab in Project A; switch to Project B → drawer shows Project B's terminals (not A's); A's tabs are gone from the DOM
- [ ] Project B remembers its own saved drawer state (open/closed + active tab) independently of A
- [ ] Close the drawer in Project B, switch to A → A's drawer re-opens (if it was open when A was last active) with A's active tab selected
- [ ] Reload the browser → the active project's drawer state is restored from settings
- [ ] If the saved active tab is a `terminal:<id>` that was since removed in Settings, drawer falls back to Commands Log without error

### OSC 9 desktop notifications (§27, HS-7264)
- [ ] In a drawer terminal, run `printf '\e]9;Build done\a'` — a toast with text "Build done" appears in the bottom-right, and the tab (if not active) gains the bell glyph
- [ ] Click the tab — the bell glyph clears immediately; the toast stays up for its remaining ~6 s and auto-fades
- [ ] Switch to a second project; in a terminal there, run `printf '\e]9;Tests passed\a'` — the toast does NOT appear in the first project (active-project scope); the second project's tab gets a bell dot
- [ ] Switch back to the second project — the "Tests passed" toast surfaces on arrival via the `/terminal/list` seed
- [ ] Run `printf '\e]9;4;3;50\a'` — NO toast fires (iTerm2 progress subcommand is parked in the scanner)
- [ ] Run `printf '\e]9;Same message\a'` twice in rapid succession — only one toast is visible (dedupe via the `recentlyToasted` cache)
- [ ] Run `printf '\e]9;Stage 1\a'` then `printf '\e]9;Stage 2\a'` — two distinct toasts appear in sequence (different-message bust of the dedupe cache)

### OSC 133 copy-last-output (§31, HS-7268)
- [ ] Run `eval "$(starship init zsh)"` (or source VS Code's published shell-integration rc) in a drawer terminal. Run `echo hello; echo world`.
- [ ] The copy-output button appears in the toolbar (between the CWD chip and the stop/clear pair) after the first OSC 133 prompt.
- [ ] Click the button — glyph flashes green for ~1 s. Paste into another app — you get exactly `hello\nworld` with no trailing prompt or blank line.
- [ ] Run `for i in 1 2 3; do echo stage $i; sleep 1; done` and click copy mid-loop — you get the partial output so far. Click again after completion — you get all three lines.
- [ ] Run `true` (no output) then click copy — the button briefly shakes (no range to copy).
- [ ] Click the power button to restart the PTY. The copy-output button disappears; it reappears on the next OSC 133 A.
- [ ] Scroll past ~1000 rows to trim the C marker. Click copy — button shakes (disposed marker).
- [ ] Use a shell WITHOUT OSC 133 integration (e.g. `/bin/sh` without an rc). The button never appears.

### OSC 133 Phase 2 jump shortcuts + hover popover (§32, HS-7269)
- [ ] In a shell-integrated terminal (Starship or VS Code's rc), run three distinct commands (e.g. `echo first`, `pwd`, `echo third`).
- [ ] Press `Cmd/Ctrl+Up` — xterm viewport scrolls so `pwd`'s prompt line sits at the top. Press again — scrolls to `echo first`. Press once more — nothing happens and no `\e[1;5A` escape leaks into the shell input.
- [ ] `Cmd/Ctrl+Down` walks forward (most recent direction).
- [ ] Hover the top gutter glyph — a three-button popover mounts to the right of the glyph. Move cursor into the popover — it stays open. Click **Copy command** → paste elsewhere and get `echo first`.
- [ ] Hover same glyph, click **Rerun** — `echo first` appears at the prompt and runs.
- [ ] Hover same glyph, click **Copy output** → paste and get `first`.
- [ ] Open Settings → Terminal. Uncheck "Enable shell integration UI" — all gutter glyphs disappear and the copy-output toolbar button hides. Cmd/Ctrl+Up does nothing (no scroll). Hovering where glyphs used to be → no popover.
- [ ] Re-check the box — glyphs reappear at their original positions (the ring buffer was preserved); shortcuts and popover work again.

### OSC 133 Phase 3 Ask Claude (§33, HS-7270)
- [ ] Connect Claude Code to Hot Sheet (green channel dot visible). In a shell-integrated drawer terminal, run `false` (exits 1).
- [ ] Hover the red-X gutter glyph — popover shows Copy command / Copy output / Rerun / **Ask Claude** (accent-coloured + bold at the end).
- [ ] Click **Ask Claude** — the channel dot pulses, and within a few seconds Claude responds in the Commands Log panel with a diagnosis of the `false` exit.
- [ ] Run a command with very long output then `false` at the end (`for i in $(seq 1 1000); do echo line $i; done; false`). Ask Claude — the prompt (visible in Commands Log) truncates to the last 8 000 chars with a `[output truncated to last 8000 chars]` header.
- [ ] Disconnect Claude Code (Ctrl+C the MCP client). Re-open the popover on any glyph — the Ask Claude button is now absent. Copy command / Copy output / Rerun still work.
- [ ] Reconnect Claude Code — Ask Claude reappears on the next popover open.
- [ ] Open a terminal in a project without OSC 7 (no Starship prompt). Ask Claude — the prompt omits the "in `...`" cwd clause cleanly.

### OSC 9 native OS notifications (§30, HS-7272) — Tauri only
- [ ] First run after install: Hot Sheet asks for notification permission via the OS dialog; grant it. Subsequent runs don't re-prompt.
- [ ] With Hot Sheet focused, run `printf '\e]9;Build done\a'` — toast fires. **No** OS banner appears (we gate on `document.hidden || !document.hasFocus()` so the user looking at Hot Sheet doesn't get a double-notification).
- [ ] Minimise Hot Sheet (or focus another app), then fire the OSC 9 from a second path (ssh into the same host, run a delayed `sleep 3 && printf '\e]9;Build done\a'` before minimising, etc.) — an OS banner appears with the active project's name as title and the message as body. The in-app toast also fires so it's visible on return.
- [ ] Return focus to Hot Sheet — the project-tab bell glyph is set; click the tab to clear.
- [ ] Fire the same message twice while backgrounded — only one banner (dedupe shared with the toast via the `recentlyToasted` cache).
- [ ] Fire two distinct messages while backgrounded — two banners, latest on top.
- [ ] In a browser build (open `http://localhost:4174` in Chrome instead of the Tauri app): an OSC 9 fires the toast only — no OS banner, no errors in the JS console.

---

## 12.1. Drawer terminal grid view (HS-6311, §36)

Automated coverage in `e2e/drawer-terminal-grid.spec.ts` (3 tests) covers toggle enable/disable + grid on/off + slider persistence + tab-click auto-exit. The items below are what automated tests don't exercise — drag / resize / visual / bell animation / Tauri-only paths.

### Basic toggle + grid behavior
- [ ] With one terminal configured, open the drawer and confirm `#drawer-grid-toggle` is **visible but disabled** (cursor: not-allowed, reduced opacity, tooltip explains the 2-terminal minimum).
- [ ] Add a second terminal (via Settings → Terminal or the drawer `+` button) — the toggle **enables** immediately without a page reload.
- [ ] Click the toggle — the drawer body swaps from the tab pane to the tile grid. The slider becomes visible next to the toggle.
- [ ] Click the toggle again — back to tabs; the previously-active tab (Commands Log by default) is re-revealed.

### Tile rendering + slider
- [ ] With 3–4 terminals in the project, enter grid mode — every terminal gets a tile, tiles are 4:3, labels match the drawer-tab display names.
- [ ] Drag the slider left → tiles shrink, more per row. Drag right → tiles grow, fewer per row. Snap-point tick marks appear under the slider at "N per row" positions and the slider magnetically snaps within ~2.5 units of each.
- [ ] For a live `alive` terminal whose shell has been running for a bit (some scrollback), the tile shows a scaled-down live preview of the content.
- [ ] For a lazy terminal that has never been attached, the tile shows a muted placeholder with a play glyph + "Not yet started".
- [ ] For an exited terminal, the tile shows "Exited (code N)" with the play glyph.

### Click / dblclick / Esc routing
- [ ] Single-click a live tile — it grows out of its grid slot (FLIP animation) to a centered overlay filling ~90 % of the drawer. A dim backdrop covers the rest of the drawer (NOT the full viewport).
- [ ] Type into the centered overlay — the shell receives the keystrokes.
- [ ] Click the backdrop, click the same tile, or press Esc — the tile animates back into its grid slot (reverse FLIP).
- [ ] Double-click any tile — enters the dedicated full-drawer view. `FitAddon.fit()` scales the text to real cols × rows. A back button + terminal label show in a slim top bar.
- [ ] Click Back, or press Esc — returns to the grid (or centered overlay if that was the prior state).
- [ ] While in dedicated view, click another drawer terminal tab — exits grid mode entirely and activates that tab.
- [ ] Press Esc on the bare grid (no centered / dedicated) — exits grid mode (reverts to the prior tab).

### Placeholders
- [ ] Click a lazy / exited placeholder tile — shows "Starting…", spawns the PTY, then transitions to the centered overlay once the first history frame arrives.
- [ ] Double-click a placeholder — same spawn + goes straight to dedicated.

### Bell indicators
- [ ] In one of the project's terminals, run `printf '\007'` while grid mode is active in the same project — the tile does a one-shot bounce and keeps a persistent 2 px accent-color outline.
- [ ] Click the tile (centered overlay) — the outline clears immediately and the server-side `bellPending` flag drops (verify: the `.drawer-tab.has-bell` indicator on that terminal's tab also clears after exiting grid mode).
- [ ] Fire a bell in another project's terminal while the current project is in grid mode — the tile outline does NOT appear for that (cross-project) bell; the project-tab bell indicator on the other project's tab does appear as normal.

### Per-project state + project switch
- [ ] Project A in grid mode with slider at 60 → switch to project B → project B opens in its last state (tabs mode by default, slider at 33 default if never opened).
- [ ] Switch back to project A — still in grid mode, slider still at 60.
- [ ] Page reload (Cmd+R) — grid state resets to tabs mode for every project (session-only).

### Tauri-only gate
- [ ] In a plain browser (`http://localhost:4174` in Chrome, not the Tauri window) — confirm `#drawer-grid-toggle` is absent from the drawer toolbar.

---

## 13. Terminal find / search (HS-7331, §34)

Most of the happy-path flows are now covered by `e2e/terminal-search.spec.ts` (HS-7363). The items below are what's left for manual verification — visual-color checks, fallback paths, and state-reset flows that automated tests don't yet exercise.

### Drawer terminal
- [ ] Type `apple` into the search box (with `apple` appearing 3 times in the scrollback) — **visually confirm** the match highlights are amber/orange (not accent blue), the active match is a brighter orange than the rest, and Enter advances the active highlight to the next row
- [ ] With keyboard focus OUTSIDE a terminal (e.g. in the ticket list), press Cmd/Ctrl+F — the app-header ticket search focuses, **NOT** the terminal search widget (fallback path)
- [ ] Restart the terminal (Stop → Start) with the search box open — after the new PTY attaches the search box is back in its collapsed state with no stale highlights
- [ ] **HS-7427 history persistence across widget close/reopen**: submit two distinct queries via Enter, click the × close button, click the magnifier to reopen, press ArrowUp — the most recent query appears in the input. (The history ring survives × close even though the cursor is reset.)
- [ ] **HS-7427 history reset on PTY restart**: submit two queries, then Stop → Start the terminal. After the new PTY attaches and the widget is back open, ArrowUp does nothing (history is wiped when the xterm is GC'd)

### Dashboard dedicated view
- [ ] Re-enter the dedicated view for a DIFFERENT tile — the search widget re-mounts fresh (no leaked query or highlights from the previous view)
- [ ] Pressing Esc (rather than clicking Back) exits the dedicated view — both paths should return you to the grid view with the sizer restored

### Grid tile (regression check)
- [ ] Visually confirm no grid tile itself shows a magnifier / search UI (grid tiles are preview-scale and deliberately excluded per §34.1 — test 4 in the e2e spec asserts the app-header slot is hidden in grid view, but a visual scan of the tile DOM is the clearest "nothing leaked" check)

---

## 14. Feedback dialog click-to-insert (HS-6998, §21.2.1)

The dialog is heavily visual — rendered markdown pills, in-between hover-to-reveal `+` insert affordances, inline response blocks with remove buttons, and a catch-all textarea. Playwright can't easily assert "visually reads as a question set with inline replies," so these flows are manual.

### Basic rendering
- [ ] Trigger a feedback note whose prompt is a single-paragraph question. Open the feedback dialog: the prompt renders as a single accent-bordered pill, ONE insert slot sits below it showing a muted `+` glyph (no "Add response here" text visible by default), and a catch-all textarea with label "Or respond below (catch-all)" sits under that. Focus lands in the catch-all on open.
- [ ] Trigger a feedback note with intro paragraph + bulleted list + closing question + options list (use the prompt from the HS-6998 screenshot). Each of the four blocks renders as its own pill. Between each pair of blocks — and after the last — a `+` glyph insert slot is visible. Hover the mouse anywhere in the gap between two blocks: the glyph brightens and " Add response here" reveals next to it. The click target spans the full width of the dialog (minus block horizontal padding) — clicking anywhere across that full-width gap opens the inline textarea.
- [ ] Trigger a feedback note whose prompt is ONLY the string `FEEDBACK NEEDED:` (no content). The dialog renders an italic `(no prompt text)` placeholder and the catch-all textarea. No `+` insert affordance appears.

### Click-to-insert flow
- [ ] Click anywhere in an insert slot between two blocks (does not require hovering the `+` glyph itself — the full-width button accepts the click). A new inline response block appears with a blue-tinted background, a textarea, and a `×` button top-right. Focus jumps to the new textarea immediately.
- [ ] Add TWO inline responses in the same slot (click the insert button twice). Both appear in insertion order; the `+` insert slot stays visible below them so the user can add more.
- [ ] Add an inline response, then click its `×` button. The response is removed cleanly and focus is not stolen from wherever the user clicked next.
- [ ] Add inline responses in different slots, type distinct text in each, then submit. A new note appears on the ticket with the prompt blocks quoted (`> ` prefix) and the responses interleaved un-quoted in the correct slots. **Visually read the note** to confirm every question is right next to its answer.

### Catch-all only (regression check)
- [ ] Open dialog, type into the catch-all only, submit. The new note body is EXACTLY the catch-all text — no quoting, no prompt restatement. This is the common case and must not accidentally regress into quoted output when no inline responses were used.

### Submit gating
- [ ] Open dialog, leave every field blank, no attachments, click Submit. Submission is blocked and focus returns to the catch-all (or the first inline textarea if one exists).
- [ ] Open dialog, add an inline response with whitespace-only text, leave catch-all blank, Submit. Submission is still blocked — whitespace-only inline responses do NOT count as "any response used."
- [ ] Add an attachment only (no text anywhere), Submit. The attachment uploads; no note body is created.

### Mixed response + attachments
- [ ] Fill catch-all, add an attachment, submit. Note is created with the catch-all text; attachment appears on the ticket. Channel notification fires if the Claude Channel is alive.
- [ ] Fill one inline response AND the catch-all AND add an attachment, submit. Note body has quoted prompt blocks with the inline response interleaved, then the catch-all text appended un-quoted at the end. Attachment uploads.

---

## Automated Coverage Summary

For reference, here's what IS covered by automated tests (no manual check needed):

- Ticket CRUD (create, read, update, delete, batch operations)
- Status lifecycle transitions
- Tag add/remove
- Note add/edit/delete
- Attachment upload via file picker
- Clipboard copy/cut/paste (Cmd+C/X/V)
- Keyboard shortcuts (Cmd+F, Cmd+A, Cmd+D, Cmd+Z, N, Delete, Escape)
- Sort dropdown order change
- Detail panel position toggle (side/bottom)
- Long-poll auto-refresh
- Plugin sync: full field roundtrip, conflict resolution, note/comment sync, attachment sync
- Plugin config: validation feedback, label colors, enable/disable, uninstall/reinstall
- Plugin UI extensions: toolbar, detail_top/bottom, context_menu, status_bar, sidebar
- Backup create + preview data
- Settings dialog: tabs, category list, checkbox persistence
- Terminal command resolution branches (unit tests in `src/terminals/resolveCommand.test.ts`)
- Terminal PTY lifecycle: spawn, kill, scrollback ring buffer, multi-subscriber broadcast, exit state (unit tests when HS-6264 lands)
- Terminal WebSocket auth guard (reject missing/wrong secret with 403) and roundtrip (unit tests when HS-6265 lands)
- Terminal drawer tab toggle (E2E when HS-6268 wires up the setting toggle)
- Terminal find widget happy path (drawer open+type+Enter/Shift+Enter+× close; Cmd+F routing; dashboard dedicated-view mount/unmount; grid-view regression) — `e2e/terminal-search.spec.ts` (HS-7363)
- Terminal find recent-query history (3-query ArrowUp MRU walk + ArrowDown draft restore against a real PTY) — `e2e/terminal-search.spec.ts` (HS-7427)
- Terminal find regex toggle (regex toggle flips aria-pressed; `appl.` matches 3 lines; `[abc` invalid regex flips `.is-invalid` + `err` chip) — `e2e/terminal-search.spec.ts` (HS-7426)
- OSC 133 Phase 1b copy-last-output (button hidden when no OSC 133 fires; complete A→B→C→output→D cycle reveals the button, click writes C→D range to navigator.clipboard with success-flash class) — `e2e/terminal-osc133-copy-output.spec.ts` (HS-7327)
- OSC 133 Phase 2 jumps + popover (three OSC 133 cycles → 3 gutter glyphs, popover surfaces on hover, Copy command writes to navigator.clipboard, Cmd/Ctrl+Up jump intercepted; Settings → Terminal "Enable shell integration UI" off hides glyphs) — `e2e/terminal-osc133-jump-popover.spec.ts` (HS-7328)
- OSC 133 Phase 3 Ask Claude (channel alive: failing command's gutter glyph popover surfaces Ask Claude button, click POSTs canonical prompt with command + exit code + output to /api/channel/trigger; channel dead: button absent from popover) — `e2e/terminal-osc133-ask-claude.spec.ts` (HS-7332)
