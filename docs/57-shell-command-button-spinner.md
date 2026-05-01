# 57. Shell Command Button Spinner & Stop (HS-8056)

When a custom command button (§15 Shell target) is running, the button itself surfaces the running state with a spinner + stop icon overlay anchored to the button's right edge. Clicking the button again while it's in this state asks the user to confirm stopping the process. This is a sidebar-button enhancement to the existing §15 shell-command flow.

## 57.1 Status

- **HS-8056** — design (this document).
- **HS-8060** — Phase 1 implementation. Shipped 2026-05-01. Pure UI + per-button state wiring; no server-side change. The pre-existing single-shell-poll global timer was rebuilt as a single shared poll that watches every entry in `_runningButtonsForTesting` (the runtime map name is `runningButtons` — `_*ForTesting` is the export alias for tests). Per-id `autoShowLogById` map replaces the global `shellAutoShowLog: boolean` so concurrent commands don't race their auto-show flags.
- **HS-8070 (2026-05-01)** — `runningButtons` keyed by `${secret}::${commandKey(cmd)}` (composite `runningKey(secret, cmd)` helper) so a command running in Project A doesn't make Project B's identically-named button show the spinner after the user switches projects. Pre-fix the user reported "stop / spinner keeps showing on different project after switching" — `commandKey` collided across projects when both had a button with the same `name + prompt + target`. Render reads via `getActiveProject()?.secret` so the spinner state immediately matches the active project on every project switch (already triggered by `initChannel` → `renderChannelCommands` from the existing `reloadAppState` flow). The poll loop's drop-on-id-not-running gate is unchanged because `/shell/running` is still globally scoped server-side; entries for inactive projects survive across switches and the spinner shows again when the user returns. 4 new unit tests in `commandSidebar.test.ts` under `runningButtons per-project scoping (HS-8070)`: A's command doesn't show spinner in B, switching back to A still shows spinner, two projects can run the same-keyed command independently, `runningKey` composes secret + commandKey.

## 57.2 Motivation

Today the only running-state signal for shell commands is the global "Shell running" toolbar indicator (`setShellBusy(true)` in `commandSidebar.tsx`) and the Commands Log entry's live partial-output `<pre>`. Neither helps the user identify *which* command they kicked off — when several commands have similar names or icons, you have to check the log to remember. It also adds friction for the common "stop and rerun" loop: today the user has to open the Commands Log panel, find the entry, click its stop button, then come back to the sidebar to click the command again.

The button is already the user's mental anchor for the action. Showing the spinner *on the button itself* keeps the state visible where the user clicked, and using the SAME button as the stop affordance turns "stop and rerun" into two clicks instead of four.

## 57.3 UX

### 57.3.1 Button states

| State | Layout | Notes |
|---|---|---|
| **Idle** | Existing — icon, label, transparent right padding | Unchanged from §15. |
| **Running** | Idle layout + a spinner-with-stop-icon overlay anchored `position: absolute` to the button's right edge. The spinner has the SAME background colour as the button so it visually "punches" into the button rather than floating beside it. The spinner element is `position: absolute` so it does NOT cause the button to reflow — long button labels are partially obscured by the spinner instead. | First user-visible signal that the click took. |
| **Confirming stop** | Same as Running. The confirm dialog opens on top via §53's `confirmDialog`; no extra button-level visual. | The user clicks the button (or the spinner specifically — both routes work because the spinner is `pointer-events: none` and the button itself owns the click handler). |
| **Stopping** | Spinner stays. Button click is debounced for ~500 ms after the user confirms so a double-click on the confirm button doesn't immediately fire a new run. | Server-side: `POST /api/shell/kill` returns immediately; the SIGTERM-then-SIGKILL-after-3s logic is unchanged. |

### 57.3.2 Spinner construction

- 14×14 px (matches the button's icon size).
- Pinned `right: 6px; top: 50%; transform: translateY(-50%)`.
- Background: same as the button colour (`background: inherit` — the button itself paints the colour, the spinner is `position: absolute` inside the button so `inherit` returns the button's value).
- Spinner ring: 2 px stroke, animated rotation, colour = the button's `contrastColor()` foreground. Identical visual language to the existing channel-busy indicator.
- Inside the spinner ring: a 8×8 px Lucide `square` (filled) glyph in the contrast colour. Click target is the entire button — the spinner is `pointer-events: none`.
- Reflow guard: the spinner element is `position: absolute` so it never contributes to the button's intrinsic width. A long button label that visually clips behind the spinner is the accepted tradeoff (§57.4 Out of scope mentions an alternative if the user disagrees).

### 57.3.3 Stop confirmation dialog

Use the existing `confirmDialog` helper from `src/client/confirm.tsx` (Tauri-safe per CLAUDE.md). Copy:

```
Title:     Stop running command?
Message:   "{cmd.name}" is still running. Stop it now?
Confirm:   Stop
Cancel:    Keep running
Danger:    true   (red confirm button)
```

The dialog is non-blocking with respect to OTHER buttons — a different running command's spinner still works, and the user can click another idle button to spawn a second concurrent command.

### 57.3.4 Concurrency model

Multiple shell commands can run simultaneously. Each running command is identified by its `command_log` entry id. A `Map<commandId, runningLogId>` (where `commandId` is a stable id derived from the command's position in the saved `custom_commands` list) tracks which buttons are currently in the Running state. The existing global `shellPollTimer` in `commandSidebar.tsx` already polls `/api/shell/running`'s `ids: number[]` array — that's the source of truth.

When a button is clicked while idle:
1. POST `/api/shell/exec` → returns `{id}`.
2. Store `runningButtons.set(commandId, id)`.
3. Re-render the button into the Running state (or replace the button's `_state` className without a full re-render).

When a button is clicked while running:
1. Open the §57.3.3 confirm dialog.
2. On Stop: POST `/api/shell/kill` with `{id: runningLogId}`. Drop the entry from `runningButtons` optimistically; the next `/api/shell/running` poll will confirm.
3. On Cancel: no-op.

When the polling tick reports a previously-running id is no longer in `ids[]`:
1. Drop the entry from `runningButtons`.
2. Re-render the button into the Idle state.

The existing global "Shell running" toolbar indicator stays — it now reads `runningButtons.size > 0` instead of a single boolean. This preserves the channel-style global busy signal for users who still want to see "something is running" at a glance.

### 57.3.5 Identifying buttons across re-renders

Custom commands don't have stable ids in the saved JSON — the existing structure (§15.5) uses `name + prompt + icon + color + target`. Two commands with identical (`name`, `prompt`) would currently be indistinguishable. Phase 1 keys `runningButtons` by the running log entry id (already unique). Render-time, the button checks `for (const [_cmdKey, logId] of runningButtons)` against `cmd.name` + position — good enough for the realistic case (the user isn't going to define two identical-named commands). A future ticket can promote `CustomCommand` to have a stable `id: string` field if duplicates become a real-world concern.

## 57.4 Out of scope (potential follow-ups)

- **Stop-button pulsing animation.** A subtle scale pulse on the stop icon would communicate "click me to stop" more strongly. Skipped to ship Phase 1 lean.
- **Reflow-respecting layout** (giving the spinner a guaranteed width slot via `padding-right: 24px` on the button). The user explicitly asked for the no-reflow behaviour with the partial-text-obscure tradeoff, so the spec follows that. If they later prefer the reflow variant, swap to `padding-right` on the running-state class.
- **Per-button output preview** in the Running state (the existing §53 streaming output goes to the Commands Log; surfacing the latest line of output in the button itself would clutter the sidebar). Defer.
- **Stop ALL running** affordance somewhere global. Defer until users actually run >2 commands concurrently.

## 57.5 Implementation outline (Phase 1 ticket)

Files touched:
- `src/client/commandSidebar.tsx` — `renderButton` learns a `running: boolean` parameter; new `runningButtons: Map<string, number>` module-private state; click handler branches on running-state; new `attemptStopCommand(cmd, logId)` helper; `startShellPoll` walks `runningButtons` to drop completed entries + re-render their buttons.
- `src/client/styles.scss` — new `.channel-command-btn-spinner` block (14×14 absolute-positioned, bg:inherit, spin keyframes already defined in §15 styling for the global indicator → reuse).
- `src/client/commandSidebar.test.ts` — new tests for the running-state branch:
  - `renderButton in idle state has no spinner, click POSTs /shell/exec`
  - `renderButton in running state shows the spinner element with bg:inherit + stop glyph`
  - `click on a running button opens the confirm dialog (mock confirmDialog) — confirm fires /shell/kill`
  - `click on a running button — cancel-stop is a no-op`
  - `polling tick that drops a running id transitions the button back to idle`
  - `two concurrent commands track independent running state`

No server-side change — `/api/shell/exec`, `/api/shell/kill`, `/api/shell/running` are all already in place.

## 57.6 Reading order pointers

- `15-shell-commands.md` — the underlying execution model + log entry structure.
- `53-streaming-shell-output.md` — how live output is fanned out (the new spinner doesn't need to subscribe to the partial-output stream; it just consumes the `ids[]` boolean).
