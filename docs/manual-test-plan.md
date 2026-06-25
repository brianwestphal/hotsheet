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

### Clipboard Paste Attachments (HS-8662) — needs a real OS clipboard
- [ ] Copy an image (e.g. a screenshot to clipboard) with **1 ticket selected**, press Cmd/Ctrl+V → the image attaches to that ticket; toast "Attached 1 file".
- [ ] Same with **no ticket selected** → a new "Attachment" ticket is created with the image attached (multiple files → titled "Attachments").
- [ ] Same with **2+ tickets selected** → nothing happens except a toast "Pasting attachments to multiple tickets at once isn't supported".
- [ ] Paste an image while the **new-ticket draft input is focused** → still becomes an attachment (a text field can't hold a file).
- [ ] Paste **plain text** (no files) while a text field is focused → normal text paste, NO attachment created.
- [ ] Copy a file in the OS file manager and paste into Hot Sheet → attaches like an image.

### Project Tabs
- [ ] Drag a tab to reorder — drop indicator shows insertion point
- [ ] Release — tab order persists across reload
- [ ] HS-8664: Even with a single project registered, the project tab strip shows (not a plain title) with a trailing "+" button; clicking "+" opens the folder picker; picking a folder registers + switches to a new project.
- [ ] HS-8663: Select one or more tickets, drag onto **another** project's tab — the hovered tab highlights (accent), the cursor shows a **copy** (+) badge; release → toast "Copied N ticket(s) to <project>", tickets appear in that project, originals remain.
- [ ] HS-8663 move: Repeat holding **Option/Alt** — cursor shows a **move** badge; release → toast "Moved N…", originals disappear from the source project (in Trash) and appear in the target. **Verify in the Tauri desktop app specifically** (WKWebView): the copy→move switch is now driven by a window-level Alt tracker because WKWebView drops modifier flags from drag events — the earlier `e.altKey`-only read always fell back to copy there (HS-8663 fix).
- [ ] HS-8663 no-op: Drag tickets onto the source project's **own** tab — no highlight, nothing happens.
- [ ] HS-8663 "+"-drop: Drag tickets onto the "+" button → folder picker opens; pick a folder → tickets copied/moved into the new project and the app switches to it. **Cancel** the picker → nothing changes (no new project, originals untouched).
- [ ] HS-8739: Attachments ARE carried across projects — copy/move a ticket that has an attachment to another project (drag or copy/cut+paste) and verify the attachment is present on the ticket in the target project (open its detail panel).
- [ ] HS-8542: Click the sidebar dashboard widget to open the per-project analytics dashboard; then click the active project's own tab → dashboard dismisses, regular ticket view returns (the previously-active view's items are visible, sidebar item gets the `.active` class)
- [ ] HS-8626: Open the analytics dashboard (sidebar widget) → header controls (search box, list/column toggle, sort dropdown, detail-position toggle) are hidden. Then click the cross-project-stats header button (requires telemetry data on some project so the button shows) → cross-project page takes over. Close it (second click on the button / project-tab click) → back in the normal ticket view, **all four header controls are visible again** (pre-fix the analytics dashboard's inline `display:none` survived the cross-project takeover and left them missing).

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
- [ ] HS-8946: Claude (and other CLI) discovery on a GUI launch with no `$SHELL`. With `claude` installed only in a shell-rc dir (e.g. `~/.local/bin` via the official installer, or an nvm/volta dir — NOT in `/usr/local/bin`), launch Hot Sheet as a **packaged GUI app** from Finder/Dock. The configured "Claude" terminal launches `claude` (the channel-connected form), NOT a bare shell, and the Glassbox/Claude toolbar affordances resolve — because `enrichProcessPath` recovered the login-shell PATH via the passwd-DB shell even though the GUI provided no `$SHELL`. (Shell-resolution + merge logic unit-tested in `src/enrich-path.test.ts`; this verifies the real Finder-launch PATH recovery.)
- [ ] HS-8786: Glassbox launch from the GUI app (minimal launchd PATH). With the `glassbox` CLI installed in `/usr/local/bin` (Homebrew), launch Hot Sheet as a **packaged GUI app** (not from a terminal). The Glassbox toolbar button appears (status resolves the CLI via the augmented PATH / known locations, not just bare `PATH`), and clicking it opens Glassbox. With the CLI **not** installed, clicking shows a "Could not open Glassbox…" toast instead of silently doing nothing. Installing the CLI while Hot Sheet is running makes the button appear without a restart (no permanent negative cache).
- [ ] HS-8784: Glassbox "nothing to review" feedback. On a project with a **clean** working tree and **no unpushed commits** (`git status` clean + not ahead of upstream), click the Glassbox button → a **"No pending changes for Glassbox to review."** hint appears **anchored directly under the Glassbox button** (NOT a bottom-center toast — the user was missing the toast because it landed far from the button) and Glassbox does NOT open (previously it opened an empty review that looked like nothing happened). The hint auto-dismisses after a few seconds or on the next click. Make a change (edit/add a file) OR have an unpushed commit → clicking now opens Glassbox as usual. (Logic unit-tested in `src/client/glassboxReview.test.ts` via `hasGlassboxReviewableChanges`; the hint render/dismiss lifecycle is unit-tested in `src/client/anchoredHint.test.tsx`.)
- [ ] HS-8472: Pending commits in the git-status popover. On a branch with ≥2 **unpushed** commits (ahead of its upstream — make a couple of local commits without pushing), click the sidebar git chip → the popover shows a **Pending commits** section listing each commit (short hash + subject, with up to 3 body lines for commits that have a body), newest first, between the "N ahead" line and the working-tree buckets. With the **Glassbox CLI installed**: each commit has a **Review** button → clicking opens Glassbox showing just that commit's diff (`glassbox --commit <sha>`); an **"Open all pending changes in Glassbox"** button at the bottom opens one review of the whole pending range (`glassbox --range <upstream>..HEAD`). With Glassbox **not** installed, the commit list still shows but without the Review buttons. (Parsing + arg-building + body-preview are unit-tested; this verifies the real popover render + external launch.)

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

### Multiple connections / cleanup (HS-8460 / HS-8948)
- [ ] Open two Claude Code instances in the same project → the sidebar shows "2 Claude connections active — triggers route to the oldest one" with a **Clean up** button.
- [ ] Click **Clean up** → the duplicate channel-server(s) are terminated, a toast confirms "Cleaned up N…", and the warning disappears (only the leader remains). `mcp.log` shows a `multi-connection` roster line + a `multi-connection-cleanup` line.
- [ ] Reproduce an orphan (e.g. a Claude exits but its MCP child lingers) → the warning shows even with one Claude window; Clean up clears it.

### Visibility
- [ ] Channel UI hidden if Claude CLI version < 2.1.80
- [ ] Channel toggle in Settings → Experimental registers `.mcp.json`

### HS-8349 Multi-project tool naming
- [ ] Open Hot Sheet on a project named `foo` (basename of the project root directory). Open Settings → Experimental. The launch command rendered under "Enable Claude Channel" reads `claude --dangerously-load-development-channels server:hotsheet-channel-foo` (slug-suffixed, not the legacy `server:hotsheet-channel`).
- [ ] Open the project's `.mcp.json` (parent of `.hotsheet/`). The registered key is `hotsheet-channel-foo`, not `hotsheet-channel`.
- [ ] Add a second project at a different path (e.g. `~/Documents/bar`). Its `.mcp.json` registers under `hotsheet-channel-bar`. Inside Claude Code, run `/mcp` — the tool list shows distinct names for each project (`mcp__hotsheet-channel-foo__hotsheet_update_ticket` vs `mcp__hotsheet-channel-bar__hotsheet_update_ticket`).
- [ ] Migration: create a project whose `.mcp.json` contains a legacy `hotsheet-channel` entry (pre-HS-8349 shape). Enable the channel — the legacy entry is removed and the new slug-suffixed entry is written. Disable the channel — both keys (legacy + slug-suffixed) are removed from `.mcp.json`.
- [ ] Edge case: project root with non-alphanumeric basename (e.g. `My Project!!!`). The slug collapses to `my-project` and the command displays accordingly.

---

## 4. Shell Commands

- [ ] Shell command button in sidebar executes the configured command
- [ ] "Shell running" busy indicator shows while process executes
- [ ] Command log entry shows stdout/stderr with `---SHELL_OUTPUT---` separator
- [ ] Stop button (square icon) appears for running processes
- [ ] Stop sends SIGTERM; if process doesn't exit in 3 seconds, SIGKILL follows
- [ ] Working directory is the project root (parent of `.hotsheet/`)

### Long-press → run in new terminal (HS-8539, §83.1) — gesture + per-OS

- [ ] **Long-press** a shell command button (press and hold ~0.5 s): a **new drawer terminal opens running the default shell** and the command runs in it as if typed; after it finishes the shell prompt is live (you can type more). The drawer opens if it was closed.
- [ ] **Press feedback** — the button visibly depresses (slight scale/dim) while held, and clears on release.
- [ ] **Click is not double-fired** — a long-press does NOT also trigger the inline streaming run (only the new terminal opens).
- [ ] **Normal (quick) click** still does the inline streaming run (unchanged), with the spinner + Commands Log.
- [ ] **First-use hint toast** — on the FIRST normal click of any shell command button (fresh `localStorage`), a one-time toast appears explaining the long-press. It does NOT reappear on later clicks/reloads, and does NOT fire if the very first interaction was a long-press.
- [ ] **Per-command "Launch in New Terminal"** — enable it in the command editor (shell-only checkbox). Now a *normal click* opens a new terminal by default; long-press still opens a new terminal (redundant, harmless). Disable it → click reverts to the inline run.
- [ ] **Default shell, per OS** — the new terminal runs the user's **default shell** (zsh/bash on macOS/Linux, the configured default on Windows), NOT the command as the PTY program. Verify the injected command runs and the shell stays open on each target OS. **HS-8840 — the command is injected once the shell output *settles* (prompt rendered + 150 ms quiet), not after a fixed delay**, so it adapts to slow shells (PowerShell). Watch for any truncated/garbled first command on slow Windows/Linux startups; if it still mistimes, tune `_settleInjectTimings` (`quietMs` / `maxWaitMs`) in `src/routes/terminal.ts`.

### Long-press → make a task (Claude command buttons, HS-8538, §83.2)

- [ ] **Long-press** a Claude command button (~0.5 s): a **Task ticket** is created from it — title = the command name, details = the command's prompt — and a success toast appears. The ticket shows in the list (reload happens automatically). The prompt is NOT sent to the channel.
- [ ] **Category is `task`/TSK** even if you've removed "task" from the project's configured categories (Settings → Categories). The ticket still saves with category `task` (it may render without a custom color/label in that edge case, but it's a real, filterable ticket).
- [ ] **Normal (quick) click** still sends the prompt to the channel (unchanged). When Claude isn't connected, a warning **toast** appears (not a blocking dialog).
- [ ] **Press feedback + no double-fire** — the button depresses while held; a long-press does NOT also send the prompt to the channel.
- [ ] **First-use hint toast** — the first normal click of any Claude command button (fresh `localStorage`) shows the one-time long-press hint; it doesn't reappear on later clicks/reloads, and doesn't fire if the first interaction was a long-press.

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

### Non-localhost bind + auth (`--bind`, HS-7940) — needs a second machine / device

The access-control matrix is unit + in-process tested (`src/trusted-origin.test.ts`, `src/routes/server.auth.test.ts`); these manual items cover the real off-box transport that CI can't exercise.

- [ ] Default `hotsheet` (no `--bind`) is loopback-only: from a SECOND machine on the LAN, `http://<host-ip>:4174` does NOT connect (connection refused).
- [ ] Local browser on the host keeps working unchanged with the **default loopback** bind (plain HTTP, Tier-0 — UNCHANGED by mTLS).

### Exposed-bind mutual TLS (`--bind` non-loopback, HS-8993 / §94) — needs a second machine / device

The listener behavior (accepts a CA-signed client, rejects no-cert / foreign-CA) is integration-tested against a real Node HTTPS server (`src/auth/tlsListener.test.ts`); the cert *enrollment* UX lands in sub-ticket 3 (HS-8994), so full end-to-end manual testing with an installed `.p12` is gated on that. For now:

- [ ] `hotsheet --bind 0.0.0.0` prints "⚠ Bound to 0.0.0.0…" + "🔒 Mutual TLS REQUIRED — connect over https:// with an enrolled client certificate." + the trusted-origins line, and the "running at" URL is **`https://`**; no browser auto-opens.
- [ ] From the second machine, plain `http://<host-ip>:4174` does NOT work (the listener is HTTPS now); `https://<host-ip>:4174` with **no client cert** is rejected at the TLS layer (the browser shows a cert-required / connection error), confirming an unauthenticated remote can't reach any handler.
- [ ] Settings → **Remote Access → Add Device…** (loopback): in the **Tauri desktop build**, the native **Save** dialog appears and writes the `.p12` to the chosen path (HS-9024 — Chromium's `<a download>` can't catch the WKWebView no-op, so this MUST be checked in the real desktop app, not Playwright). Installing that `.p12` on the second device lets `https://<host-ip>:4174` connect and load the UI; the **Revoke** button blocks it again (HS-8995).
- [ ] **QR pairing (HS-9026), full device path:** Settings → Remote Access → **Pair a Device…** → confirm the reachable URL → a QR shows with a live countdown. On a phone/tablet, scan it; the device generates its key + CSR in-browser, enrolls over the pairing token, installs the signed client cert, and then connects over mTLS and appears in the device list. (Desktop QR display + payload + the server CSR round-trip are automated; the phone-side scan→CSR→install→connect is this manual item — browser client-cert install is platform-specific.)
- [ ] **Keychain-less host (Windows / headless Linux, HS-9019):** with **no** `HOTSHEET_CA_PASSPHRASE` and no keyring, `hotsheet --bind 0.0.0.0` fails to start with the "cannot start mTLS … project CA could not be set up" / "HOTSHEET_CA_PASSPHRASE not set" error (never plaintext). Set `HOTSHEET_CA_PASSPHRASE` and it starts, writing `<dataDir>/auth-ca.enc`; restart with the **same** passphrase → already-enrolled devices still connect (same CA); a **wrong** passphrase refuses to start rather than regenerate.
- [ ] **WS revocation re-check (HS-9025):** with a terminal or `/ws/sync` socket open from an enrolled remote, **revoke** that device; within ~30 s the open socket closes (next HTTP request was already 403 immediately).
- [ ] Terminal + `/ws/sync` WebSockets still attach from an enrolled remote (they ride the same HTTPS server → `wss://`).

### WebSocket live sync (`/ws/sync`, HS-8981) — multi-client

The transport (connect / reconnect / fallback / classification) is unit-tested (`src/client/wsSync.test.ts`); these cover the real browser round-trip.

- [ ] Open the same project in two browser tabs/windows. Create / edit / delete a ticket in tab A → it appears in tab B within a moment **without a manual reload**.
- [ ] In DevTools (tab B) Network panel, confirm the live update arrives over the `/ws/sync` WebSocket frame (the data-refresh that follows is expected until HS-8984 lands the no-refetch reducer).
- [ ] Stop the server (or block the WS) while a tab is open: after ~2 quick drops, the amber "Live updates unavailable — falling back to polling" banner appears and ticket changes still sync via the long-poll.
- [ ] Restart the server / restore the WS: the banner clears and live push resumes.
- [ ] Switch the active project tab: live updates track the newly-active project (a mutation in the now-active project pushes; the old one no longer drives this tab).

### Editable AI partition overlay (HS-8977) — visual

The model + reassign-via-select are unit-tested (`partitionEdit.test.ts` / `partitionEditor.test.ts`); these cover the real overlay rendering.

- [ ] Worker Pool → "AI: partition" with ≥2 running workers opens the editable overlay showing a column per worker with its proposed tickets (not the old read-only confirm).
- [ ] Each ticket has a worker `<select>`; changing it moves the ticket to that worker's column (re-renders). Emptied workers show "— empty —".
- [ ] "Apply + Dispatch" dispatches the edited chunks (toast reports counts); Cancel / Esc / backdrop-click closes without dispatching.
- [ ] (HS-8988) Dragging a ticket row from one worker column and dropping it on another reassigns it (a `.drag-over` highlight shows on the hovered column); the `<select>` remains as the fallback.

---

## 8. Demo Mode

- [ ] `hotsheet --demo:1` loads sample tickets in list view
- [ ] `hotsheet --demo:7` loads in column/kanban view
- [ ] `hotsheet --demo:10` shows multiple project tabs
- [ ] Browser title shows "Hot Sheet Demo"
- [ ] Demo data is ephemeral (gone after closing)

### Test Instance (`--test`, HS-8921 / HS-8922)

Presence/absence of the badge + the isolation are automated (`src/cli.testMode.e2e.test.ts`, `e2e/test-badge.spec.ts`); these check the visual styling + the run-alongside-prod experience:

- [ ] `hotsheet --test` opens on port 4274 and the header shows an amber **TEST :4274** pill in the top-left — visually unmistakable next to a normal instance
- [ ] A normal `hotsheet` (4174) and `hotsheet --test` (4274) run at the same time without interfering
- [ ] The badge color/placement reads as "caution, not prod" and isn't confused with category/priority colors

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
- [ ] **HS-8336 ticket-list FLIP animation (default list view).** With a handful of tickets visible in the default list view (not column / trash / preview), trigger an operation that reorders rows: toggle a ticket's up-next star, flip status from `not_started` → `started`, or change priority such that the sort key shifts. The rows should slide smoothly from their old positions to their new positions over ~200 ms — they should NOT snap. HS-8331 introduced the bindList reconcile path; HS-8336 restored the FLIP via `setTicketsAnimated` wrapping the `loadTickets` setTickets writes. Regression check after either HS-8332 (column view bindList) or HS-8333 (trash + preview bindList) lands — those branches still rely on `renderTicketList`'s captureSnapshot / flipAnimate pair until they migrate.
- [ ] **HS-8333 trash view bindList.** Send a ticket to trash. Click the Trash view in the sidebar — the ticket appears with a date column and a Restore button (the `createTrashRow` variant). Empty the trash; the "Trash is empty" message appears. Send another ticket to trash; the message disappears and the trash-row appears. Click Restore; the ticket goes back to the active set and the trash list refreshes (now showing 0 items + the empty message). Switch back to the active view; the default-list rows render correctly (no leftover trash variants, no leftover Restore buttons). Switch trash → another sidebar view → trash again; the trash-row variants render correctly each time.
- [ ] **HS-8333 backup-preview bindList.** Settings → Backups → Preview a backup. The ticket list switches to the `createPreviewRow` variant (non-interactive — no checkbox column, dimmed star, no inline edit). With a preview that contains 0 visible tickets in the current view filter, the "No tickets match this view" message appears. With matching tickets, they render in the preview variant. Exit preview mode; the default list view returns with the editable `createTicketRow` variants (no leftover preview rows, no stale "No tickets match this view" message). Re-enter preview mode; the preview variants render again cleanly.
- [ ] **HS-8334 client-side view filtering — within-scope view switches are instant.** With tickets spanning multiple statuses + categories + priorities visible in the default view, click "Up Next" / "Open" / "Completed" / "Verified" sidebar entries in succession. The list should narrow instantly with each click (no network round-trip delay) and FLIP-animate rows in/out as they move between buckets. Then click a category-filter chip or priority-filter chip — narrowing is similarly instant. The server fetch still happens in the background (`?status=active`), but the visual narrowing precedes it.
- [ ] **HS-8796 new-ticket line above the selected-ticket toolbar.** In list view, select one or more tickets so the batch (Category / Priority / Status / … / "N selected") toolbar shows. The **"New ticket…"** draft row sits **above** that toolbar (was below it). Typing a title + Enter still creates the ticket; the draft input keeps its text/focus across list re-renders. Switch to **column** view → the top-of-list draft row is gone (each column has its own); switch to **Trash / backup Preview** → no draft row; open the **analytics dashboard** → no stray "New ticket…" line above it. Return to the list → the draft row is back above the toolbar.
- [ ] **HS-8735 / HS-8734 / HS-8736 / HS-8733 / HS-8732 new-ticket line appearance.** The new-ticket line has **no gray background** and **no dashed bottom border** (it reads as a plain input row; the toolbar's own background separates them). There is **no decorative ○ circle** before the type badge (HS-8733, dropped in HS-8736) and **no extraneous gap** between the type badge and the text field (HS-8732 — the empty draft-number span that produced a ~5em gap is gone; the badge + input now sit in one rounded-rect `.draft-entry` with a normal `8px` gap). The empty checkbox column is gone, so the type badge starts near the row's left edge.
- [ ] **HS-8334 cross-scope transitions show a brief empty state.** Click Trash in the sidebar → trash rows appear. Click "All" → the list briefly shows empty (~50–300ms depending on network), then populates with the active tickets. This is expected post-HS-8334 — the bindList subscribes to `filteredTickets` which reacts to view changes immediately; the active-scope data arrives a moment later via `loadTickets`'s `?status=active` fetch. (Pre-HS-8334 would show the now-irrelevant trash rows during the transition window — arguably more confusing.) Same behavior for Backlog → All, Archive → All, and the reverse transitions.
- [ ] **HS-8334 backup-preview filtering against full snapshot.** Settings → Backups → Preview a backup. With the preview active, click through Up Next / Completed / Verified / category / priority filters in the sidebar. Each click should narrow the preview's ticket list correctly using the SAME `filteredTickets` logic as the live view — the pre-fix `loadPreviewTickets` had its own duplicate filter switch (now deleted); a regression here means the dedup is wrong. Also verify "No tickets match this view" appears when a filter combination matches nothing in the snapshot.
- [ ] **HS-8332 column-view bindList.** Switch to column layout (toolbar layout toggle). With tickets spanning all 4 statuses (Not Started / Started / Completed / Verified) visible, drag a card from one column to another — the card should slide cross-column (FLIP animation), the source column-count chip should decrement, the destination's should increment. Drag multiple selected cards at once → all move. Click a column header to bulk-select that column → batch toolbar shows the count; click again to deselect. Settings → toggle "Hide Verified Column" → column count changes 4→3 with verified items merged into Completed (or 3→4 splitting them out). Switch view between 'all' / 'up-next' / 'open' / 'non-verified' → the visible column set changes appropriately and tickets re-partition without flicker. Custom view with includeArchived → "Archived" column appears.
- [ ] **HS-8332 column-view in-place edits leave card DOM stale (closed 2026-05-11 by HS-8335 — keep this entry as a regression check).** With a ticket card in column view, click the category badge → pick a new category. The category badge color + label should now update IN PLACE on the same card (no rebuild, no status change required). Same for priority indicator (click → pick), star button (Cmd+D), and any server-pushed title update.
- [ ] **HS-8335 list-view per-row reactivity.** With a ticket visible in the default list view, click the status button → status cycles. The status icon should update in place on the same row. Click the star → `.up-next` class flips, star symbol toggles ★/☆, title attr updates. Click the category badge → pick a new category. Badge color + label update in place. Same for priority indicator. Edit the title input — type characters — the row's title stays as you type. Open the same project in a second window (browser tab) and change the title there. The first window's row updates to the new title IF AND ONLY IF the title input isn't focused. Focus the input, have the second window change the title, then blur. The next server-pushed update propagates the change.
- [ ] **HS-8335 column-view per-row reactivity.** Same drill as the list-view test but on a column-card. Toggle star, change category, change priority — all update in place. Status changes still move the card cross-column (correct behavior — different per-column bindList).
- [ ] **HS-8335 cut-pending class reactivity.** Cmd+X / Edit → Cut on a selected ticket — the row's `.cut-pending` class flips on (typically renders as a dashed border or faded appearance per the CSS). Cmd+C / Edit → Copy a different ticket — the previous cut row clears its `.cut-pending`. Paste — the cut clears entirely. Pre-fix this required a full `renderTicketList` rebuild to update; post-HS-8335 it's a single-class-flip per row via the per-row `effect()` on `cutTicketIdsSignal`.
- [ ] **HS-8365 reader-mode `morph()` preserves text selection across note navigation.** Open a long-ish note in reader mode (book-open icon next to the timestamp). Select a span of text inside the rendered body. With the selection active, press ArrowDown to navigate to the next note. The new note's body renders in place — verify that if the selected span's surrounding markup survives the morph (same `<p>` parent, same text node), the selection is preserved on the matching DOM; otherwise the selection clears cleanly without throwing. Repeat ArrowUp / ArrowDown a few times — no flicker, no scroll jump beyond the intentional reset to top.
- [ ] **HS-8365 feedback-dialog file list `morph()` preserves textarea state.** Open the feedback dialog on a ticket with a `FEEDBACK NEEDED:` prompt. Focus the catch-all textarea and type a partial answer. Drag-and-drop a file onto the dialog — the file row appears below; verify the textarea's cursor / typed-so-far content is unchanged. Add a second file. Click the × button on the first file row — the row disappears; the second row's × button still works (verifies the delegated click handler reads the current `data-idx`). The textarea remains focused with its content intact throughout.
- [ ] **HS-8651 notes `morph()` in Tauri WKWebView (Chromium verified by `notes-morph.spec.ts`; smoke the desktop engine).** In the **Tauri desktop app**, open a ticket with enough notes that the detail panel scrolls. Scroll the notes partway down and leave the panel open — across poll ticks (every couple seconds the detail re-fetches + re-renders its notes) the scroll position must NOT snap back to the top, and the list must not visibly flicker/rebuild. Then click a note to edit it (inline textarea), type a few words, and — WITHOUT saving — let poll re-renders fire (or have the ticket touched externally): the in-progress edit + caret survive (the entry is `data-morph-skip`-ped while uncommitted). Blur / ⌘-Enter to save — the entry rebuilds into display mode with the new text. Also confirm a note containing a private-repo GitHub image still renders (proxied `img.src`) and its download link is present after a re-render (morph reconciles proxied-against-proxied, doesn't strip them).
- [ ] **HS-8371 list virtualization on 100+ ticket projects.** Open a project with ≥ 100 tickets in the list view. Scroll the ticket list down. Inspect `#ticket-list` in DevTools — only ~30 `.ticket-row` elements are in the DOM at any scroll position (viewport + buffer above + buffer below). `.ticket-list-rows` has `padding-top` + `padding-bottom` matching the offset / tail row counts × 32 px. Scrollbar position + size feels natural — the scrollbar isn't 30 rows tall. Multi-select (Cmd+A) selects every ticket in the filtered list (count in batch toolbar reflects the FULL list, not just the mounted rows). Type into the search box — visible window narrows correctly. Switch view (All → Up Next → All) — only the currently-displayed rows are mounted at any time.
- [ ] **HS-8372 list virtualization extends to trash + preview variants.** On a project with ≥ 100 deleted tickets, navigate to the Trash view — only ~30 `.ticket-row.trash-row` elements are in the DOM at the visible scroll position. Restore some tickets via Cmd+A → batch restore — selection covers the full trash list. Settings → Backups → Preview a backup with ≥ 100 tickets — same DOM scope check in preview mode.
- [ ] **HS-8374 scroll-position restoration on project / view switch.** With virtualization active (≥ 100 tickets in two projects A and B), scroll project A's All view down to the middle. Switch to project B. Switch back to project A. The scroll position is preserved at where you left off in A. Same drill across views in one project: All → Up Next → All — when you return to All the scroll position is preserved. Per-view independence: scroll All to row 50, switch to Up Next + scroll to row 10, switch back to All — All's scroll is at row 50, not row 10. Clamp behavior: scroll to the bottom of a project, delete most of its tickets, navigate away + back — scroll position lands at the new max scroll (clamped to `scrollHeight - clientHeight`), not above it. Preview-mode isolation: open backup preview, scroll the previewed list, exit preview — live list's scroll is unchanged (preview + live are separate keys).
- [ ] **HS-8648 per-ticket "Claude usage" block appearance + responsive columns.** Open a ticket that has channel-attributed Claude usage (so the "Claude usage on this ticket" block renders) in the detail panel. Verify: (1) the block sits directly **above** the Notes section (not at the panel bottom under the timestamps); (2) each stat is a bordered card with a small muted label (Cost / Tokens / Prompts / Time spent) above a bold value — NOT label-and-value mashed inline like "Cost$10.98"; (3) drag the detail-panel resize handle to make the panel narrow — the four stat cards reflow to a 2×2 grid; widen it — they snap to a single 4-across row (container-query at 360px of the block's inline width). On a ticket with zero attributed prompts the block is absent entirely (collapses, no empty bordered box).

---

## 11. Keychain / Secure Storage

- [ ] On macOS: plugin secret (e.g., GitHub PAT) is stored in Keychain after first read
- [ ] Verify via `security find-generic-password -s com.hotsheet.plugin.github-issues -a token -w`
- [ ] If Keychain is locked/unavailable, falls back to file storage silently
- [ ] On Linux: `secret-tool lookup service com.hotsheet.plugin.github-issues account token` returns the value
- [ ] **HS-8954 status move survives sync.** Sync a GitHub repo, then move a synced ticket to **Backlog** (or Archive) — a status GitHub doesn't model. Click the **Sync** button (more than once). The ticket must STAY in Backlog; pre-fix the second sync reset it to **not_started**.
- [ ] **HS-8955 out-of-sync count returns to 0.** After editing + syncing GitHub-synced tickets (incl. the Backlog move above), the sync toolbar badge count must settle to **0** once everything is pushed/pulled — it should not stay stuck at a non-zero number after a successful sync. Specifically: a ticket in **conflict** must NOT keep the badge non-zero (conflicts show only in the Plugins-settings conflicts section); and editing one synced ticket must bump the badge by exactly 1 (not 2).
- [ ] **HS-8952 GitHub body-image → attachment.** Create/edit a GitHub issue whose body has a **pasted** image (renders as `<img src="https://github.com/user-attachments/assets/…">` — these are NOT fetchable with a PAT and must be resolved via the issue's `body_html`) or a markdown `![](url)` image. Sync the repo into Hot Sheet. Open the synced ticket's detail panel — the image appears in the **Attachments** list (downloaded into `.hotsheet/attachments/HS-NNNN_…`), and clicking it shows the image. Re-sync — no duplicate attachment is added (idempotent via the `img_` `note_sync` marker). Backfill: a ticket that synced *before* this support gets its attachment on the next **full** sync (the "Sync" button), and a ticket stuck in **conflict** gets its image once the conflict is resolved.
- [ ] **HS-8956 GitHub body-image inline display.** Open a synced ticket whose Details contain a pasted `user-attachments` image. The image renders **inline** in the Details/reader view (proxied via `image-proxy` → resolved to the signed URL, fetched with no auth). Pre-fix this showed a broken image.
- [ ] **HS-8959 sync-conflict banner.** With at least one GitHub ticket in `conflict` (edit a ticket locally and remotely between syncs), a gray banner appears at the top of the window showing the plugin icon, "N sync conflict(s) need resolution", and a red count badge — without opening Settings. Clicking the banner opens Settings → Plugins and scrolls to the conflicts list. Resolving the last conflict hides the banner.

### API Keys registry (HS-8751, §79) — needs a real OS keychain

E2E stubs the `/api/keys` routes, so the real keychain round-trip is manual.

- [ ] Settings → API Keys → add an Anthropic key (type + name + value) → it appears as a row; the value field is empty (write-only).
- [ ] Verify the value landed in the keychain: macOS `security find-generic-password -s com.hotsheet.plugin.keys -a <id> -w` (the `<id>` is the `data-key-id` on the row); Linux `secret-tool lookup service com.hotsheet.plugin.keys account <id>`.
- [ ] Verify the metadata (id/type/name, NO value) is in `~/.hotsheet/config.json` under `keys`.
- [ ] "Set value" on a row overwrites the keychain secret; renaming / changing type persists across a restart.
- [ ] Delete a row → both the config metadata and the keychain secret are gone.
- [ ] Settings → Experimental → Announcer: the key dropdown lists the named keys; selecting one and restarting keeps the choice (`announcer_ai_key_id`); with no selection it uses the first Anthropic key; the Listen button enables once a key resolves.
- [ ] **HS-8804 playback session restore (Tauri, real audio).** Open the announcer (Listen), let it start speaking, then **quit the app mid-playback** (don't press Stop). Relaunch → the PIP reopens on its own at the same entry and resumes speaking via the `say` voice (the unit/e2e tests stub TTS + use the paused/visible path, so this real-audio auto-resume-on-launch is manual-only). Repeat while **hidden** (HS-8827: the **X** now hides the panel and keeps playing) → relaunch comes back minimized with the Listen button glowing. Now press the **Stop** button (HS-8827, the explicit end-session control) and relaunch → no PIP returns (Stop clears the saved session). Browser caveat: a restored *playing* session may not sound until you interact, since `speechSynthesis` can be gated behind a user gesture.

- [ ] **HS-8827 announcer PIP controls (real audio).** Open the announcer. Verify: (1) the header **X hides** the panel (audio keeps playing, Listen button glows; click it to restore) and there is **no separate minimize button**; (2) the **Stop** button (filled square) ends the session and tears the PIP down; (3) each entry shows a **timestamp** in the footer (relative, absolute on hover); (4) **Clear All** (trash icon) asks to confirm, then removes every announcement in the current view (all projects in "All Projects" mode) and shows "No announcements."; (5) there is **no "idle/working" presence line** and **no "Speaking via … voice"** label; (6) with the **Live** toggle on, the **context dropdown is still switchable** — switching retargets live tailing to the newly-selected project / "All Projects"; (7) **forward/back** move between entries correctly.

## 12. Embedded Terminal

See [22-terminal.md](22-terminal.md). Requires `terminal_enabled: true` in `.hotsheet/settings.json` or via Settings → Experimental → Embedded Terminal.

### Default command resolution (§22.5)
- [ ] With `claude` on PATH + Claude Channel enabled: Terminal launches `claude --dangerously-load-development-channels server:hotsheet-channel` (verify from `ps` or from xterm header)
- [ ] With `claude` on PATH + Channel disabled: Terminal launches plain `claude`
- [ ] Without `claude` on PATH: Terminal launches `$SHELL` (Unix) / `%COMSPEC%` (Windows)
- [ ] Custom `terminal_command` with no `{{claudeCommand}}` token is passed verbatim

### Terminal rendering: WebGL / DOM (HS-8488 / HS-8619, §22.21)
GPU-dependent **visual-quality** checks (crispness, no blur, no raster artifacts) — not reproducible in the automated test env. The **renderer-selection** seam itself IS now automated under WebGL: `e2e/dashboard-tile-webgl-dom-renderer.spec.ts` re-enables WebGL (headless Chromium ships SwiftShader WebGL2) and asserts that every scaled dashboard tile — grid + magnified, including the drawer-active project's terminal — uses the DOM renderer (no `<canvas>`) while the non-scaled drawer pane uses WebGL; `e2e/dashboard-drawer-active-tile-sizing.spec.ts` asserts the drawer-active tile still converges to 4:3. So the items below are now purely about how the pixels LOOK on a real GPU (which the test env can't judge); the DOM-vs-WebGL routing that makes them correct is regression-guarded.
- [ ] **HS-8609 double-click a drawer tab toggles full height** — open the drawer with ≥2 terminal tabs. Double-click a tab: it becomes the active tab (if it wasn't) and the drawer expands to full height (ticket area collapses; the Expand button's icon flips to `arrow-down-from-line`). Double-click a tab again: the drawer returns to normal two-pane height. The state persists like the Expand button (survives drawer close/reopen / project switch per `drawer_expanded`). Double-clicking the tab's × close glyph does NOT toggle height (it closes a dynamic terminal as before).
- [ ] **WebGL default in the drawer** — open a drawer terminal, run something with heavy output (`yes`, a long `claude` session, `top`). Output is smooth; text is crisp. (Settings → General has no "Use software rendering" tick.)
- [ ] **Software-rendering opt-out** — Settings → General → tick "Use software rendering for terminals". Open a NEW terminal. It renders via the DOM (still correct, just CPU). The row is hidden entirely on a browser without WebGL2.
- [ ] **HS-8619 dashboard tiles are crisp + resize cleanly** — open the Terminal Dashboard with several live terminals. Tiles are crisp (not blurry) and don't visibly jump / mis-size as the grid lays out or the size slider moves. (Tiles use the DOM renderer because they're CSS-scaled.)
- [ ] **HS-8619 magnified tile** — single-click a tile to center/magnify it. It scales up crisply with no resize glitch. Shift+Cmd/Ctrl+Arrow to move the magnified target between tiles — each stays clean.
- [ ] **HS-8619 dedicated view keeps WebGL** — double-click a tile for the full-pane dedicated view. It real-`fit()`s to the pane (not CSS-scaled) and renders via WebGL — smooth + crisp. Press Back; the grid tile is crisp again.
- [ ] **HS-8619 drawer ↔ dashboard round-trip** — with a terminal active in the drawer, open the dashboard (that terminal's tile flips to DOM), then close it (drawer pane flips back to WebGL). No stuck-blurry / blank-canvas state in either direction.

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
- [ ] **"Quit Anyway" actually quits (HS-8828, Tauri desktop — the reported regression).** With a non-exempt process running (so the dialog fires), ⌘Q → "Quit Anyway" → the app must actually close. This regressed under Tauri 2.11: app commands (`confirm_quit`) called from the remote `http://localhost` origin were ACL-rejected (`confirm_quit not allowed. Plugin not found` in the console), so `app.exit(0)` never ran and the window stayed open while the app remained fully functional. Verify via DevTools console too: `await window.__TAURI__.core.invoke('confirm_quit')` must NOT throw `not allowed. Plugin not found` (it should quit the app). Covered by the `build.rs` `AppManifest` command list + `capabilities/remote-localhost.json` grants; `cargo check` validates the permission identifiers but the *runtime* remote-origin grant needs a real desktop build. **Also re-test Quick Look (HS-8826)** — same root cause: `quicklook` was ACL-rejected → select an attachment, press Space → native Quick Look (no broken-image overlay, no "not allowed" error).
- [ ] **Dev quit actually kills the Node server (HS-8828, Tauri dev only).** Run `npm run tauri:dev`. In another terminal note the `node … src/cli.ts` PID (`pgrep -f 'src/cli.ts'`). Quit the app (red traffic-light / ⌘Q → Quit Anyway). Within a few seconds the `cli.ts` process is GONE (`pgrep` empty) and port 4174 is free (`lsof -i:4174` empty). Pre-fix the server was orphaned (the SIGTERM hit the `npx` wrapper, not the server) and "the app never actually quit." Check `~/.hotsheet/shutdown.log`: it should show `CloseRequested` → `confirm_quit` → `RunEvent::Exit — SIGTERM server pid <PID>` with `kill(pid)=0`, and the Node side's `[cli] SIGTERM received` + `[lifecycle] step "…" done` trail. **Also test terminal Ctrl+C** in the `npm run tauri:dev` terminal — the server must still shut down gracefully (it's not in a separate process group, so it still receives the terminal SIGINT).

#### Closing a project tab (HS-8604, §37.10)
- [ ] **PTY actually dies (no orphan)** — open a project, start `claude` (or a long-running `node`/dev server) in a drawer terminal, note its PID (`ps`). Close the project's tab (X / right-click → Close Tab). After confirming, the process is GONE (`ps` shows it killed). Pre-fix it kept running, unreachable, until the whole app quit.
- [ ] **Tab-close confirm fires for a running non-exempt process** — with `claude` running and the project's Quit-confirmation set to its default ("only with non-exempt processes"), closing the tab shows the lightweight confirm dialog listing `claude`. Cancel: tab stays open, claude continues. Close tab: claude is killed and the tab closes.
- [ ] **Idle tab closes without a prompt** — a tab whose only terminal is an idle login shell closes immediately with no confirm (nothing to stop). Same even with the setting on "Always".
- [ ] **Exempt-only tab closes without a prompt** — only `htop`/`tmux`/etc. (exempt) running → no confirm under the default mode; the tab closes and the exempt process is killed.
- [ ] **Setting = Never** — with the project set to "Never", closing a tab with `claude` running shows NO confirm (still kills it).
- [ ] **Bulk close** — right-click → "Close Other Tabs" / "Close Tabs to the Left/Right" with a running non-exempt terminal in one of the closing tabs fires a single batch confirm before closing them all.

#### Quit-confirm preview pane = real xterm (HS-8041, §54.6)
- [ ] **Live xterm preview** — start `claude` (or `htop`, `vim` — anything with rich TUI rendering) in a drawer terminal. ⌘Q with the prompt firing. Click any row in the dialog list. The preview pane on the right shows the **actual rendered xterm canvas** for that terminal (alignment / color / box drawing all match the live drawer view). HS-7969 originally complained that the previous ANSI-spans preview "doesn't really match what the real terminals look like fully" — that gap is gone.
- [ ] **Cross-project preview** — open two projects, one with `claude` running. ⌘Q from either project. Click the row for the other project's `claude` terminal. The preview shows that terminal's live xterm even though it's never been mounted in this page session.
- [ ] **Drawer mount restored on dismiss** — open the drawer with a live `claude` terminal in view. ⌘Q (prompt fires, auto-selects first row → preview pane takes the live xterm). Cancel. The drawer's terminal pane is back to showing the live xterm immediately, with no flash of the "Terminal in use elsewhere" placeholder.
- [ ] **Rapid row clicking** — open the dialog with 3+ terminals listed. Click row A, row B, row C as fast as possible. The preview pane lands on C's xterm; no flicker, no error, no orphaned xterm element. Open the browser dev console — no warnings about unhandled WebSocket / xterm errors.
- [ ] **Rendering size (HS-7969 follow-up 2026-04-30)** — when a row is selected, the xterm canvas should fill the preview pane with no empty bands of background color on the right or bottom. The `fit.fit()` call after checkout sizes cols × rows to the pane's pixel dimensions; pre-fix the static 80 × 30 left obvious empty-pane gaps. A wide-format `htop` may now wrap at whatever cols actually fit the pane (e.g. ~62 cols at default font), but the canvas itself fills the pane's full area.

#### Dedicated-view checkout migration (HS-8042, §54.7)
- [ ] **Dashboard dedicated view** — open the global terminal dashboard. Double-click any tile to enter the dedicated full-pane view. The dedicated pane shows the live terminal, fits the pane via `fit()` for native cell dims. Type into it; output appears. Click Back. The grid restores; the tile's preview is the same as before (no flash of placeholder).
- [ ] **Drawer-grid dedicated view** — open the drawer-grid for a project (toolbar toggle, ≥2 terminals required). Double-click a tile. Same dedicated-view behavior — fits the drawer-grid's dedicated body. Click Back; grid restores cleanly.
- [ ] **Long-scrollback history replay (the load-bearing HS-8042 history fix)** — run a wide `htop` or `top` for ~30 seconds in a drawer terminal so its scrollback ring fills with content captured at the drawer's column count. Open the dashboard, double-click that tile to enter dedicated view. The historical `htop` output renders correctly aligned at the dashboard pane's column count (xterm reflowed it from history dims to current dims via the resize-first-write step). Pre-fix the historical content would have rendered at "current dims" without the resize-first, mangling the box-drawing characters.
- [ ] **Centered → dedicated → exit dedicated returns to centered** — single-click a tile to enter the centered FLIP-animation overlay. Double-click again. Dedicated view enters; the centered tile becomes invisible. Click Back. The centered overlay is restored intact, no flash.
- [ ] **Dedicated → quit-confirm interaction** — open dedicated view in the dashboard. Press ⌘Q. The quit-confirm dialog opens; clicking a row that points to the same terminal as the dedicated view should checkout the live xterm into the quit-confirm preview pane (per §54.6 Phase 2.1). The dedicated view's pane drops to the "Terminal in use elsewhere" placeholder. Cancel quit-confirm. The dedicated view's pane regains the live xterm.

#### Tile preview checkout migration (HS-8048, §54.8)
- [ ] **Single xterm per terminal across surfaces (the load-bearing HS-8048 win)** — open the dashboard with a tile showing live `claude` output. Open dev tools → Memory tab. Note the heap size. Double-click the tile to enter dedicated view. The heap should NOT grow by a second xterm canvas allocation — pre-HS-8048 dedicated created a fresh xterm + WS, doubling memory for the same PTY. Click Back. Heap returns to baseline. The tile's preview is the live xterm again, no flash of placeholder.
- [ ] **Tile keystroke routing in shared-xterm world** — center a tile (single click). Type into the centered tile. Output appears in the centered tile AND propagates to the underlying drawer pane (which is showing the same terminal via its own xterm — pre-HS-8048 each surface had its own xterm so the drawer would also receive output via its own WS subscriber; post-HS-8048 only one WS subscriber exists for tile-mounted terminals, but the drawer pane has its own legacy WS via §22). Verify both surfaces stay in sync.
- [ ] **`term.onData` keystroke regression closed** — open dedicated view from a dashboard tile (the HS-8042-introduced regression scenario). Type characters. They appear in the dedicated view AND reach the server-side shell (`echo $?` should reflect the keys you typed). Pre-HS-8048 (between HS-8042 and HS-8048 main), the dedicated-view typing was silently broken because checkout's WS handler didn't wire keystroke-send.
- [ ] **Tile virtualization with shared xterm** — open the dashboard with 50+ tiles spanning a project pool (or set up a stress scenario via two projects each with many configured terminals). Scroll through the grid. Tiles that scroll out of viewport release their checkout (entry disposed when no other consumer holds it). Verify in dev tools → Memory: heap stays bounded as you scroll, doesn't grow linearly with the number of scrolled-past tiles. Scroll back to a tile that was off-screen — it re-mounts and replays scrollback within ~1 second.
- [ ] **CSS scale after dedicated → tile restore** — center a tile. Double-click to enter dedicated. The dedicated pane shows the xterm at fit-driven dims (not scaled). Click Back. The centered tile is restored at the centered-overlay dims (CSS-scaled). Verify no visible flicker, no "ghost" scaling from the dedicated view.

### Magnified-grid navigation (HS-8028, §56)
- [ ] **Centered tile, Shift+Cmd+Arrow swap.** Open the dashboard with at least 4 alive tiles laid out in a 2×2-ish grid. Single-click any tile to enter the centered overlay. Press Shift+Cmd+Right (macOS) or Shift+Ctrl+Right (Linux/Windows). The centered tile swaps to the tile that's spatially to the right (closest match using the cone metric — same-row preferred over diagonal). Press Shift+Cmd+Down — swaps to the tile below. Press Shift+Cmd+Right past the rightmost tile — no-op (no tile to navigate to in that direction).
- [ ] **Dedicated view, Shift+Cmd+Arrow swap.** Double-click any tile to enter the dedicated full-pane view. Shift+Cmd+Right swaps the dedicated view to show the tile spatially to the right. Click Back — returns to the bare grid (NOT to a centered state, even if the original double-click came from a centered tile, since the swap forced `priorCenteredTile = null`).
- [ ] **Skip non-alive tiles.** Manually exit one terminal in the grid (it becomes a "Not yet started" / "Exited" placeholder). Center an alive tile next to it. Press Shift+Cmd+Right past the dead tile — navigation skips the placeholder and lands on the next alive tile in that direction.
- [ ] **No magnification = no chord.** Open the dashboard with no centered/dedicated state. Press Shift+Cmd+Right inside a focused tile (or anywhere in the grid). The chord does NOT enter centered mode; it's simply unbound.
- [ ] **Plain Cmd+Up/Down still works for OSC 133 jumps.** While focused inside a terminal that has shell-integration enabled (OSC 133 marks present), press Cmd+Up (no Shift). The viewport jumps to the previous prompt marker per HS-7269 — HS-8028's chord requires Shift, so the two coexist.
- [ ] **Wrong-platform modifier passes through.** On macOS, press Shift+Ctrl+Right inside a focused terminal. The chord does NOT trigger HS-8028 (it's a Linux/Windows binding); it reaches xterm / shell normally.
- [ ] **Drawer-grid magnified navigation.** Open the drawer-grid (per §36 toolbar toggle, with ≥2 terminals). Single-click any tile to center within the drawer-grid scope. Shift+Cmd+Arrow swaps the centered tile within the drawer-grid layout. Same behavior as the dashboard but scoped to the drawer.
- [ ] **No xterm escape leak.** Inside a centered or dedicated terminal showing a shell prompt, press Shift+Cmd+Right. The shell does NOT receive a `\e[1;9C`-style escape sequence (no random characters appear in the prompt). The chord is fully consumed by the magnified-nav handler.

### Permission popup — live-terminal checkout (HS-8171 v2)
- [ ] Trigger a long Bash / Edit / Write permission via Claude where the MCP `input_preview` is truncated (e.g. a long ImageMagick chain, or a Write of a multi-page file).
- [ ] The popup should appear with the **live project terminal** mounted in the body slot (`.permission-popup-live-terminal` container, ≤ 60vh tall). It is the SAME xterm the project's drawer / dashboard tile would normally show — not a snapshot.
- [ ] Scroll the mouse wheel inside the popup body — the real PTY scrollback scrolls, including content that scrolled out of the visible region BEFORE the popup opened.
- [ ] Type a key inside the popup body — the keystroke reaches the running `claude` (test by typing characters into a free-form input).
- [ ] **Bumped consumer.** If the same project's drawer is open and showing the `'default'` terminal at the moment the popup opens, the drawer pane shows the §54 "Terminal in use elsewhere" placeholder for the duration of the popup. After Allow / Deny / Minimize / X / "No response needed", the drawer pane re-takes the live xterm with its own dims restored.
- [ ] **No bumped consumer.** If no other surface is currently showing the `'default'` terminal, the popup is the only consumer; on close the §54 entry is disposed cleanly (no leaked WebSocket — verify in DevTools Network tab).
- [ ] **Regression check** — short permission prompts (no truncation) should still mount with the normal flat preview / diff body, NOT the live terminal. Bash with a one-line command, Edit with a small diff, etc.

### Focus ring on magnified terminals (HS-8170)
- [ ] **Dashboard centered tile.** Single-click a tile in the dashboard. Type a key — the tile shows a 3 px blue (`#3b82f6`) focus ring around the tile preview. Click outside the tile (e.g. on the backdrop) — the ring disappears as focus leaves.
- [ ] **Dashboard dedicated view.** Double-click a tile to enter the dedicated full-pane view. The xterm pane shows a 3 px blue focus ring. Tab away to a button in the dedicated bar (e.g. Back) — ring disappears. Click back into the xterm — ring returns.
- [ ] **Drawer-grid centered tile.** Open the drawer-grid (§36 toggle). Single-click a tile. Same focus-ring behavior as the dashboard.
- [ ] **Drawer-grid dedicated view.** Double-click a tile in the drawer-grid. Same focus-ring behavior as the dashboard's dedicated view.

### PTY size resync after Terminal Dashboard exit (HS-7592, §22 / §25)
- [ ] Open the drawer with a configured terminal active (e.g. `claude` or a shell) — confirm the prompt fits the drawer width.
- [ ] Run something that writes to the full screen width (e.g. `printf '%s\n' "$(printf '%-200s' '=')"` to print a 200-char banner, or `htop`).
- [ ] Open the Terminal Dashboard (`#terminal-dashboard-toggle`). Double-click that terminal's tile to enter the dedicated full-viewport view. The PTY resizes to dashboard-pane dims (much wider/taller than the drawer).
- [ ] Click Back, then click the toggle again to exit the dashboard and return to the drawer. The drawer terminal should immediately show output formatted for the **drawer's** dims again — long lines wrap at the drawer's width, not the dashboard's. Hit Enter at the prompt; new shell output should not run off the right edge of the drawer.
- [ ] Regression check: before HS-7592 the PTY stayed at dashboard-pane cols/rows after exit until the user happened to drag the drawer enough to trigger a fit() resize. The fix exports `resyncActiveTerminalPtySize()` from terminal.tsx and calls it from `exitDashboard()` so the PTY snaps back unconditionally.

### Drawer terminal fit-convergence on project switch (HS-8590, §22)
- [ ] Open two+ project tabs, each with a drawer terminal that's been running long enough to have output (e.g. `claude`). Switch between the project tabs repeatedly.
- [ ] After each switch, the new project's drawer terminal should render at the **correct size immediately** — content fills the drawer width, no cramped ~80-col rendering, no need to manually drag-resize the drawer or wait for more output to "fix" it.
- [ ] Regression check: pre-HS-8590 the fresh per-switch checkout started at 80×24 and the mount-time fits could run before the pane laid out; because the drawer panel's box is unchanged across a switch, the panel ResizeObserver never fired to correct it, leaving the terminal cramped until a manual resize. The fix adds a `term.onRender` convergence to the drawer mount (mirrors the §25 dashboard-tile fix).

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
- [ ] Repeat the first three checks in the per-project drawer terminal grid (§36 toolbar toggle) — same auto-clear behavior
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
- [ ] Click-and-drag across output in a drawer terminal paints a **clearly visible** accent-colored selection highlight (HS-7330 regression check — previously invisible on the white theme). Repeat in the dedicated dashboard view (double-click a tile in the dashboard or the drawer-grid).
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
- [ ] **HS-8657 middle-click closes a dynamic tab (with confirmation when alive).** Middle-click (mouse button 3 / the scroll-wheel click) a dynamic terminal tab whose PTY is running → the "Close terminal?" confirm fires; confirm tears down the PTY + removes the tab, cancel leaves it. Middle-click a configured tab → nothing happens (configured terminals aren't closeable). Right-click still opens the context menu (not close). (Automated unit coverage exercises the non-alive direct-close + the gating; the live-PTY confirm dialog needs a real terminal.)
- [ ] **HS-8656 Cmd/Ctrl+Shift+[ / ] cycle tabs.** With a terminal focused, Cmd+Shift+[ / ] move between drawer/terminal tabs (same as Cmd+Shift+←/→); with focus outside the drawer they move between project tabs. (macOS Terminal.app parity — both brackets and arrows work.)
- [ ] **HS-8655 Cmd+W closes a tab, never the app (Tauri build only).** ⌘W must NEVER close the desktop window. With a dynamic terminal focused → ⌘W closes that terminal (confirm fires when the PTY is alive). With a configured terminal focused → ⌘W does nothing (persistent terminals aren't closeable). With no terminal focused and more than one project tab open → ⌘W closes the active project tab after a "Close tab?" confirm; with only one project tab → ⌘W does nothing. The window is still closeable via the red traffic light and ⌘Q (both run the §37 quit-confirm). Browser ⌘W can't be intercepted, so this is a Tauri-only behavior. (Automated unit coverage exercises the pure target-decision matrix; the Tauri menu routing + live confirm dialogs need a real desktop build.)
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

### Per-terminal shell history (§51, HS-7965 / HS-8654)
- [ ] With bash as the default shell (`$SHELL` = bash) and config kept in `~/.bash_profile` (e.g. a custom `PATH` export or `alias hs8654=echo`), open a Hot Sheet drawer terminal → the `.bash_profile` content is loaded: the alias/PATH is present (HS-8654 — pre-fix only `~/.bashrc` was sourced, so `.bash_profile`-only config was missing). Compare against the same check in your real macOS terminal — they should match.
- [ ] Up-arrow recall in that terminal is scoped to the tab (commands from a different tab / project don't appear), confirming the HISTFILE override still lands after the user's rc.
- [ ] Settings → Terminal → set history scope to "inherit" → new terminals fall back to the shared global history + no `--rcfile` rewrite (bash reads its normal startup files directly).
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
- [ ] Hover the red-X gutter glyph — popover shows Copy command / Copy output / Rerun / **Ask Claude** (accent-colored + bold at the end).
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

## 15. Announcer — audio narration (HS-8747, §78)

Playback *logic* (state machine, controls, cursor advance) is covered by unit + e2e tests (`announcerPlayer.test.ts`, `tts.test.ts`, `e2e/announcer.spec.ts` with `speechSynthesis` stubbed), and the per-platform OS-voice/kill **command construction** for macOS/Linux/Windows is covered by Rust unit tests (`npm run test:rust`). What can't be auto-verified — real audio output and actually spawning the OS-voice process under Tauri — is manual. Requires an Anthropic API key.

### Setup + opt-in (any build)
- [ ] Settings → Experimental → Announcer: the section shows a BETA chip, the privacy/cost disclosure ("sends this project's notes + activity log to Anthropic using your own API key"), an enable toggle (off by default), and a password key field with a "Save key" button. The header has no "Listen" button yet.
- [ ] Paste an Anthropic key, click Save key: a success toast fires, the field clears, and the status line reads "API key configured · N entries in the reel." Toggle Enable on. The header "Listen" button (audio-lines icon) appears.
- [ ] Toggle Enable off → the Listen button disappears. Toggle back on → it returns.

#### Apple Foundation Models provider (HS-8790 — desktop, macOS 26 only)
The Node/UI side is unit-tested (`models.test`, `summarize.test`, `appleFoundation.test`); the on-device helper now ships prebuilt in the **`apple-fm`** npm package (HS-8907 — we no longer compile our own Swift), used via its `probe()` / `generate()` API. The end-to-end app behavior still needs a manual pass on a machine with Apple Intelligence on. **Prereq:** none — `apple-fm` is in `node_modules`, so `npm run tauri:dev` / `npm run dev` discover `node_modules/apple-fm/bin/apple-fm-helper` automatically (no build step, no env var). **HS-8907 packaged-app validation TODO:** the migration is unit-tested + the build rewired, but a real signed/notarized arm64 `tauri:build` + on-device run hasn't been done — verify the bundled `server/apple-fm-helper` is re-signed and that `APPLE_FM_BIN` resolves inside the `.app` (docs/tauri-architecture.md §"Apple Foundation Models helper").
- [ ] Settings → Announcer with the helper available: the **Summarization model** field is **first**, lists "Apple Intelligence — on-device (free, private)" and is **selected by default**; the **Anthropic API key** field is **hidden**. Pick an Anthropic model → the key field appears; pick Apple again → it hides.
- [ ] On a machine WITHOUT Apple Intelligence (or no helper): the Apple option is absent and the default is Haiku; the key field shows.
- [ ] With Apple selected and **no Anthropic key set**, enable the Announcer → the Listen button still appears; click Listen → a reel is generated **on-device** (no Anthropic spend recorded on the §70/§71 dashboards). Verify the narration is coherent.
- [ ] Live mode with Apple selected: enabling Live narrates work as it happens **without** an Anthropic key (server runs the helper).

#### Local (Ollama / OpenAI-compatible) provider (HS-8792, §81 — any OS)
The Node/UI side is unit-tested (`localProvider.test`, `summarize.test`, `models.test`), and the **settings model-detection dropdown flow is now network-mocked in Playwright** (`e2e/announcer.spec.ts`, HS-8798 — the "Local model" option appears/hides on `localAvailable`, selecting it toggles the local field vs. the key field + populates the model dropdown from `localModels`, and the Listen button shows for a keyless enabled project). This manual pass verifies the end-to-end flow against a **real** local server (the part the mock can't). **Prereq:** run a local OpenAI-compatible server with ≥1 model (e.g. `ollama serve` + `ollama pull llama3.1`). For the `npm run dev` browser path the server reaches `http://localhost:11434/v1` directly.
- [ ] With the local server running, Settings → Announcer shows a **"Local model — Ollama / OpenAI-compatible"** option in the model dropdown; selecting it reveals the **endpoint URL** field (prefilled placeholder `http://localhost:11434/v1`) and a **model dropdown populated with your installed models**, and **hides** the Anthropic key field.
- [ ] Pick a local model → with **no Anthropic key set**, enable the Announcer → the Listen button appears; click Listen → a reel is generated **on-device** (no Anthropic spend on the §70/§71 dashboards) and reads coherently.
- [ ] Stop the local server → after the ~10 s probe TTL, the "Local model" option disappears (and a stored local selection falls back to Haiku). Restart it → the option returns.
- [ ] Change the endpoint URL to a wrong port → the model dropdown empties / shows "No models found"; fix it → models repopulate.
- [ ] Live mode with a local model selected narrates work **without** an Anthropic key (server POSTs to the local endpoint).

#### Mid-task narration off telemetry (HS-8789, §82 — needs telemetry + a live key)
The collector, merge gating, and importance filter are unit-tested; this verifies the live behavior end-to-end. **Prereq:** telemetry enabled for the project + a working summarization provider; enable Live in the PIP.
- [ ] With Live on, start Claude working in a project terminal (a prompt + several tool calls). Within ~15 s of activity the reel produces an "in progress / working on …" entry **before** any ticket is completed — i.e. it narrates mid-task, not just on completion.
- [ ] A turn's burst of many tool calls collapses into **one** entry (grouped by prompt turn), not one per tool.
- [ ] Routine/mechanical churn is **not** narrated — only meaningful in-progress work surfaces (the AI drops low-importance entries). Verify the reel isn't a play-by-play of every Read/Bash.
- [ ] Disable telemetry for the project → Live narration falls back to completion-only (no mid-task "in progress" entries).
- [ ] Cost: mid-task generation stays within the call budget (no runaway spend on the §70/§71 dashboards); turning Live off stops it.

### Generate + transcript PIP
- [ ] With some recent completed tickets / notes, click Listen. The button shows a busy state, then a corner-docked PIP appears (bottom-right) with the first entry's title + spoken script and a "1 / N" position. The transcript reads as a coherent spoken summary of recent work (not raw notes).
- [ ] (HS-8883) Click Listen with no new work for the active project → the PIP opens immediately showing an in-panel placeholder ("Preparing your narration…" briefly, then "Nothing to announce here yet…") at "0 / 0" — NOT a dead-end toast. You can still switch the context dropdown to another project that has work and hear it.
- [ ] PIP stacking: open a feedback dialog / permission popup while the PIP is open — the dialog/popup renders ABOVE the PIP (never obscured).

### PIP visuals — resize + emphasis + code diff (HS-8749 / HS-8772, §78.5)
*(Structural presence is e2e-covered; this checks the actual visual rendering, which can't be auto-verified.)*
- [ ] Expand toggle (header maximize icon): widens the panel and gives the body more room; the icon flips to collapse; the state survives closing + reopening the PIP; the widened panel never spills off the right/bottom edge.
- [ ] Text emphasis: when an entry's key phrase is emphasized, it renders as a tasteful gradient (blue→purple) **bold** run inline in the script — readable, not garish — and the rest of the script is normal weight. Entries without emphasis read as plain text.
- [ ] Code-diff visual: trigger a curated `hotsheet_announce` with a `diff` (or seed one). The PIP shows a color-coded diff (red removals / green additions) below the script with the file-path header — the same look as the §47 permission-popup diff. Navigating to an entry without a diff hides the pane.

### Audio playback — browser build (`npm run dev`, open in Chrome/Safari)
- [ ] On Listen, the browser voice speaks the first entry aloud and auto-advances to the next when it finishes (position increments, title/script update).
- [ ] Play/pause: the central button pauses mid-sentence and resumes from where it left off (browser `speechSynthesis` true pause). Prev/Next jump entries and start speaking the target. Skip (thumbs-down) dismisses the current entry (it won't reappear next Listen) and advances.
- [ ] Close the PIP (× or Escape while focused): audio stops immediately and the listened cursor advances (a subsequent Listen with no new work says "nothing new").

### Audio playback — Tauri desktop build
- [ ] On Listen, the macOS system voice (`say`) speaks aloud (NOT the browser path — confirm by checking it uses the OS voice). Auto-advance works.
- [ ] Pause/Skip/Next/Prev/Close all interrupt the current utterance promptly (the `tts_stop` command kills the `say` child). On a non-resumable OS voice, resume re-speaks the current entry from the start (expected).
- [ ] No orphaned `say` processes remain after closing the PIP or quitting the app.

#### Linux / Windows OS voice (HS-8765)
**OS-voice audio — automated + verified (2026-06-11).** The maintainer's "render a wav and check it's not silent" idea is now two re-runnable scripts that drive the **exact** command the app's `tts_speak` spawns and confirm non-silent output:
- **Linux** (`spd-say --wait` → speech-dispatcher → espeak-ng): `scripts/verify-tts-linux-docker.sh` — headless via Docker, records the synthesized audio off a PulseAudio null sink, asserts non-silence (verified: peak −2.2 dBFS) **and** that no `spd-say` children linger after `--wait` (orphan check). Needs Docker + ffmpeg on the host.
- **Windows** (`System.Speech.Synthesis.SpeechSynthesizer`): `scripts/verify-tts-windows-parallels.sh "Windows 11"` — drives the synth in a Parallels Windows VM (no Rust toolchain needed), copies the wav back, asserts non-silence (verified: peak −0.3 dBFS).

Still manual (need the actual Tauri *desktop app* GUI on each OS, which the scripts don't run): **mid-speech `tts_stop` interrupt promptly** on Linux/Windows, and the full Listen→speak flow inside the real desktop build. The kill-command construction is Rust-unit-tested (`npm run test:rust`).
**WKWebView `speechSynthesis` empirical check (HS-8811 / HS-8744 open question) — VERIFIED 2026-06-16.** Ran the voice-enumeration + spoken-utterance console snippet in the **Tauri macOS** build's WebKit dev console: `'speechSynthesis' in window` true, `getVoices()` returned the full macOS voice list (Samantha [default], Albert, Fred, …), the utterance fired `onstart` → `onend` with **no `onerror`**, and **audio was audibly produced**. Verdict: the browser `speechSynthesis` path is a viable *secondary* on the macOS desktop build; `say`-via-Tauri stays the primary regardless. This retires the last open WKWebView-reliability question from the HS-8744 spike — re-run the §78.6 console snippet only if the WKWebView/macOS TTS stack changes.

### Spoken permission checks (HS-8781 / HS-8794)
*(The text mapping + arbitration are unit-tested; actual speech output is manual.)*
- [ ] With the Announcer-tab "Speak permission checks" toggle on (default), trigger a permission popup → the OS/browser voice reads "Permission needed in &lt;project&gt;: &lt;description&gt;" — and it **names the project** the popup belongs to (HS-8794). Verify with **two+ registered projects** that a permission on a *non-active* project still speaks that project's name.
- [ ] Turn the toggle off → no permission is spoken.
- [ ] HS-8795: the after-the-fact **reel does NOT narrate** "permission granted/needed" or "Claude finished" — listen to a reel covering a session that included permission prompts + a channel done; the narration covers ticket/notes work only (channel permission + done chatter is excluded).

---

## 16. GitHub Plugin Sync (HS-8933 scheduled auto-sync, HS-8791 badge)

The sync engine + counts are unit-tested; these cover the live-GitHub + visual parts:

- [ ] **Auto-sync default:** with the GitHub plugin configured + enabled, the config dialog shows "Auto-sync every" defaulting to **15 minutes**; background sync runs on its own (a new issue created on GitHub appears locally within the interval without clicking Sync).
- [ ] **Interval change takes effect:** set it to **1 minute**, save; a remote change appears within ~1 min. Set to **Off**; background sync stops.
- [ ] **Self-heal:** after the first scheduled run (or a manual Sync), an issue that previously wouldn't sync (older than the watermark) is pulled in.
- [ ] **Out-of-sync badge:** make a change on GitHub (or edit a synced ticket locally) and within ~5 min the sync toolbar button shows an amber count badge; the tooltip reads "N changes to sync (X in, Y out)". Clicking Sync clears it to 0 (badge disappears).
- [ ] **Badge respects direction / disabled:** disabling the plugin or an unconfigured plugin shows no badge.

---

## 17. Git Worktrees (HS-8934/8935/8938, docs/89)

The follower-redirect, server git-ops, and panel render/wiring are automated; these cover the real-git + visual flow:

- [ ] Git popover shows a **"Manage worktrees…"** button (git repos only); it opens the worktrees overlay listing the main worktree.
- [ ] Create a worktree (branch name + "New branch") — it appears in the list with a **follower** badge, and a sibling `../<repo>-worktrees/<branch>` directory is created with a `.hotsheet/settings.json` pointing at the main project's `.hotsheet`.
- [ ] Launching Hot Sheet (or a Claude terminal) from the worktree shares the **same** tickets as the main project (no separate DB); the real `<worktree>/.hotsheet/db` is not created.
- [ ] Remove a worktree from the panel (confirm dialog) — it disappears from the list and the directory is gone; the branch is kept.
- [ ] **HS-8936** — click "Open terminal" on a worktree row: a drawer terminal opens with cwd = the worktree, running `claude`. Inside it, `/hotsheet` reads the **owner's** worklist and `hotsheet_*` MCP tools act on the **same** tickets as the main project (the worktree's `.mcp.json` + skills point at the owner). The worktree's `.mcp.json` registers the owner's `--data-dir`.

### Distributed worker loop (HS-8863, docs/90 §90.5/§90.7)

The loop invariants (claim/complete/release, no-double-claim across two workers, dead-worker reclaim, lease-loss skip, park-on-error, graceful stop) are automated in `workers/workerLoop.test.ts`; the launcher + skill generation are automated, and the launch route is integration-tested against a real temp git repo (`routes/workers.test.ts`, HS-8969). These cover the end-to-end *real-agent* flow that can't be unit-tested:

- [ ] In a worktree terminal (HS-8936), run the **`/hotsheet-worker`** skill with several Up Next tickets queued. The worker claims the top ticket, marks it `started`, does the work, marks it `completed` + notes, releases, and immediately claims the next — repeating until the pool is empty, then calls `hotsheet_signal_done` and stops.
- [ ] Run **two** worker terminals (two worktrees) against the same Hot Sheet at once. Every ticket is worked exactly once — no two workers grab the same ticket — and you can watch the claimed-by columns flip live in the owner UI.
- [ ] Kill one worker terminal mid-ticket. After the lease (~120 s) expires, the other worker (or a fresh one) reclaims that ticket and finishes it; the ticket shows a "lease expired — reclaimed" note.
- [ ] A blocked ticket (`hotsheet_set_blocked_by`, HS-8865) is **not** claimed by any worker until all its blockers are completed/verified.

### Claimed-by chip + in-flight view (HS-8864, docs/90 §90.8)

The chip render + lease/stale logic + the in-flight rows are unit-tested; this covers the live poll-driven visual flow:

- [ ] Claim a ticket via the API/MCP (`hotsheet_claim_next` or a worker). Within ~5 s, a `⚙ <worker>` chip appears on that ticket's **row** and (if open) its **detail header**, without a manual refresh. **HS-9041** — while the lease is healthy (a worker renewing on schedule) the chip shows just the worker name (no countdown); hovering shows the lease time in the tooltip.
- [ ] Let a claim's lease run down (stop renewing): once under ~60 s remaining, the `m:ss` countdown appears in an **amber warning** tint and ticks down each second; within 30 s of expiry it flips to the red **stale** (pulsing) state, then reads `expired` once past.
- [ ] Release the ticket (or it completes) → the chip clears on the next poll.
- [ ] Open the git popover → **"In-flight work…"**: every currently-claimed ticket is listed with its worker + lease countdown; clicking a row opens that ticket's detail. Empty state shows when nothing is claimed.

### Coordinator-dispatch (HS-8964, docs/92)

The dispatch helper + personal-queue ordering are unit-tested; this covers the real drag/menu flow (the menu path is the Tauri-safe one):

- [ ] With a worker pool running, **drag** an Up Next ticket onto a worker tile — the tile highlights (`.drag-over`), and on drop the ticket's claimed-by chip flips to that worker; the worker picks it up before the shared pool. (Browser; raw HTML5 drag is unreliable in Tauri — use the menu there.)
- [ ] Right-click one or more tickets → **"Dispatch to worker ▸"** → pick a worker: same result via the Tauri-safe path. The submenu lists only live (idle/working) workers and doesn't appear when no pool exists.
- [ ] Dispatch a ticket already claimed by another worker → a toast reports "already claimed by `<worker>`" and it isn't reassigned.
- [ ] A dispatched worker finishes its dispatched queue, then falls back to self-claiming the shared pool.
- [ ] **Queue-only mode (HS-8975):** check a worker tile's "queue-only" box → it works only tickets you dispatch to it and, once its queue empties, stops claiming (does NOT pull shared Up Next work); unchecking returns it to self-claiming. The toggle survives a worker re-register.
- [ ] **AI partition (HS-8965):** with 2+ running workers and several Up Next tickets, click **"AI: partition"** → a confirm shows the proposed split (`worker-1 ← HS-1, HS-2` …); accepting dispatches each chunk to its worker (chips flip). With no AI provider it still produces a round-robin split; with no running workers it prompts to add one.
- [ ] **Reassign (HS-8974):** dispatch a ticket already claimed by worker A to worker B → a confirm prompts "Reassign to B? (abandons in-progress work)"; confirming moves the claim to B (chip flips), declining leaves it with A.
- [ ] **Recall (HS-8974):** right-click a claimed ticket → "Recall claim" → its chip clears and it returns to the self-claimable pool (a worker can claim-next it again).

### Worker-pool panel (HS-8962, docs/91 §91.5)

The pool manager (drain semantics, state derivation) + panel render/drain wiring are automated; this covers the real launch/drain/teardown flow:

- [ ] Open the git popover → **"Worker pool…"**. With Up Next tickets queued, step the **target-N stepper** up to 1 (`+`): a new worktree + a `claude` terminal running `/hotsheet-worker` opens, and a tile appears (state flips idle → working with the ticket it claimed). The "X running" count tracks live workers.
- [ ] Step the target to 2 — a second worker is launched; both drain the pool in parallel with no double-claim (tiles show distinct current tickets); the owner UI updates live. (HS-8971 reconcile: the panel adds/drains to match the target.)
- [ ] Click **Drain** on a *working* tile: the worker finishes its current ticket (NOT interrupted mid-work), then stops; the tile goes draining → stopped and is auto-cleaned (its terminal closes + worktree is removed).
- [ ] **Drain all** gracefully stops every worker the same way.
- [ ] **Zombie reap (HS-8972):** kill a worker's Claude process *without* draining (close the terminal / `kill`). After ~5 min of no claim-next/renew, its tile shows **Unresponsive** then is auto-reaped (terminal closed + worktree removed + a "looked unresponsive — reaped" toast); if a target-N is set, a replacement worker is launched. A worker actively renewing a long ticket is NOT reaped.
- [ ] A worker started by hand (`/hotsheet-worker` not via the panel) is unaffected by pool drain (it's not in the registry).
- [ ] **Buttons removed (HS-9039):** the worker-pool panel no longer shows **"AI: suggest"** or **"AI: partition"** — only the manual stepper, per-worker Drain, Drain all, and queue-only remain.

### Auto worker pool switch (HS-9039, docs/91 §91.11)

The persistence + cadence + toggle/sync + first-tick sizing are automated (`workerAutoMode.test.ts`); this covers the real worktree/terminal launch the loop drives:

- [ ] With Claude connected, an **"Auto worker pool"** switch appears in the sidebar just above the play button. (It's hidden when the channel is disabled.)
- [ ] With several Up Next tickets queued, flip **Auto on**: within ~a minute Hot Sheet sizes the pool (worktrees + `/hotsheet-worker` terminals launch automatically — no manual stepper) and the workers self-claim and drain Up Next in parallel; the claimed-by columns flip live in the owner UI.
- [ ] As Up Next empties, the pool **scales itself down**: workers finish their current ticket, drain gracefully, and the worktrees/terminals are cleaned up (target → 0).
- [ ] Flip **Auto off**: auto-sizing stops; any still-running worker finishes its current work (it is NOT killed mid-ticket). You can Drain it from the panel.
- [ ] The switch is **per project**: toggle it on for project A, switch to project B — B's switch reflects B's own saved state (off unless you enabled it there). Reload the app — each project's switch restores its saved on/off.
- [ ] Cost check: with an Anthropic key configured, Auto on for a while does NOT spam the suggestion endpoint — it re-sizes roughly once a minute (watch the §70/§71 usage dashboards stay modest), not every few seconds.

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
- Terminal renderer selection under WebGL: with WebGL re-enabled (SwiftShader), every scaled dashboard tile (grid + magnified, including the drawer-active project's terminal) uses the DOM renderer (no `<canvas>`) while the non-scaled drawer pane uses WebGL — `e2e/dashboard-tile-webgl-dom-renderer.spec.ts` (HS-8619); the drawer-active tile still converges to ≈4:3 — `e2e/dashboard-drawer-active-tile-sizing.spec.ts` (HS-8619). Visual crispness on a real GPU stays manual.
- Checkout `handle.resize` top-of-stack gate: a bumped-down consumer cannot resize the shared term; the top consumer can; a restored consumer can resize again — `src/client/terminalCheckout.test.ts` (HS-8619)
- Announcer (§78 / HS-8747) playback: state machine (sequential play, pause/resume on resumable + non-resumable backends, prev/next, skip+dismiss, stale-resolution guard, transcript-only `none` backend) — `src/client/announcerPlayer.test.ts`; TTS backend selection + each engine's `ended`/`cancelled`/`error` contract — `src/client/tts.test.ts`; client UX (Listen-button opt-in gate → PIP renders → next/prev/skip/close → cursor advance) with announcer routes intercepted + `speechSynthesis` stubbed — `e2e/announcer.spec.ts`. Per-platform OS-voice/kill command construction (macOS `say`, Linux `spd-say`, Windows PowerShell `System.Speech`, unix `kill` vs Windows `taskkill`) — Rust `#[cfg(test)]` tests in `src-tauri/src/lib.rs` (`npm run test:rust`). Real audio output + actually spawning the OS-voice process under Tauri stay manual (§15).
