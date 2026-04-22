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
- [ ] Clicking outside the popup dismisses it locally (the popup goes away) and the channel server's request stays pending — the user can still answer in the terminal
- [ ] After dismissing the popup once, the next poll cycle (~100 ms later) does **not** immediately re-show the same popup (HS-6436). The blue attention dot on the project tab stays
- [ ] When a different request_id arrives later (the channel server gets a new permission), the popup does show — dismissed-tracking is per-request, not per-project
- [ ] Popup shows the full description (no 100-char truncation) and the input_preview block if Claude provided one (HS-6476)
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
- [ ] In a terminal, run `printf '\\033]0;custom-title\\007'` — the drawer tab and the in-pane terminal header both update to "custom-title"
- [ ] Restart the PTY (Stop → Start) — the label reverts to the configured name (e.g. "claude" or "zsh") until the new process pushes its own title
- [ ] In terminal A while terminal B is the active drawer tab, run `printf '\\007'` (or `tput bel`) — terminal A's tab gains a wiggling bell glyph
- [ ] Click terminal A — the bell glyph clears as soon as the tab activates
- [ ] Bell fired in the *currently active* terminal does not produce an indicator (the user is already looking)
- [ ] Cross-project bell (deferred — see §23.3 Phase 2): a bell in a non-current project does not yet show on the project tab. Tracked as a follow-up

### Rendering and input (§22.6)
- [ ] No black strip appears below the last rendered row (xterm viewport background matches the app theme even when container is taller than rows × cellHeight)
- [ ] Drag drawer resize handle → xterm reflows, shell inside (e.g. `claude` UI, `htop`) resizes correctly
- [ ] Commands Log tab vertically fills the entire drawer (no empty space below the entries area). HS-6404: was caused by `.drawer-terminal-panes` taking flex:1 alongside the commands-log pane; the wrapper now uses `display: contents` so only the active pane claims space.
- [ ] Switching from Commands Log to a Terminal tab and back: each pane fills the full drawer height in turn
- [ ] 256-color and true-color output renders (test with `echo -e "\033[38;5;196mred\033[0m"` and a truecolor printer)
- [ ] Clickable URL detected and opens in browser on click
- [ ] Copy (Cmd/Ctrl+C with selection) puts text on clipboard
- [ ] SIGINT (Cmd/Ctrl+C with no selection) interrupts running process
- [ ] Paste (Cmd/Ctrl+V) works correctly

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
