# 30. OSC 9 native OS notifications (HS-7272)

## 30.1 Overview

Phase 1 of the OSC 9 feature (docs/27-osc9-desktop-notifications.md) shipped an
in-app toast: a shell that emits `\x1b]9;Build done\x07` surfaces a
6-second `.hs-toast` in the currently-active project. That works when the user
is looking at Hot Sheet — but if they've switched to their editor, minimised
the window, or hidden the tab, the toast auto-fades before they return and
they never see the message.

HS-7272 closes that gap for the Tauri build by adding a native OS notification
channel that fires **alongside** the toast when the app is backgrounded. The
browser build is unaffected — there is no Tauri invoke to call, so the
function silently resolves to `false` and the toast alone carries the message.

## 30.2 Tauri plumbing

### Cargo + plugin registration

`src-tauri/Cargo.toml`:

```toml
tauri-plugin-notification = "2"
```

`src-tauri/src/lib.rs` registers the plugin in the `tauri::Builder::default()`
chain:

```rust
.plugin(tauri_plugin_notification::init())
```

and exposes a single custom command that the JS client calls:

```rust
#[tauri::command]
async fn show_native_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}
```

Registered in `invoke_handler!` alongside the other Rust commands (HS-7272
landed next to `open_url`, `quicklook`, etc.).

### Capabilities

`src-tauri/capabilities/default.json` gains `"notification:default"` — this
permission set covers the plugin's built-in `is_permission_granted`,
`request_permission`, and `notify` commands, and is enough to cover
`show_native_notification` since that command is declared inside the Hot Sheet
app crate (custom commands don't need their own capability entry beyond
`core:default`).

## 30.3 JS-side helpers (`src/client/tauriIntegration.tsx`)

Three exports drive the native channel:

- **`requestNativeNotificationPermission(): Promise<void>`** — called once
  from `app.tsx` boot. Reads `window.__TAURI__.notification` (exposed because
  `withGlobalTauri: true` in `tauri.conf.json`), calls `isPermissionGranted`,
  and if not granted calls `requestPermission`. On macOS the first
  `requestPermission` shows the system permission dialog; subsequent calls
  short-circuit. Idempotent — a module-local `notificationPermissionPrimed`
  boolean prevents re-running even if something re-invokes it after boot.
  Errors are swallowed (denied permission is not a failure mode worth
  surfacing to the user — the toast channel still works).

- **`fireNativeNotification(title, body): Promise<boolean>`** — calls
  `invoke('show_native_notification', { title, body })`. Returns `true` on
  success, `false` when `getTauriInvoke()` is null (browser) or the invoke
  rejects. The boolean is informational — callers don't currently branch on
  it, but it's there for future UI (e.g. "native sent, hide the toast sooner").

- **`isAppBackgrounded(): boolean`** — returns `document.hidden ||
  !document.hasFocus()`. Used by the bell-poll dispatcher as a gate so the
  native fire only happens when the user is not already looking at Hot Sheet.

## 30.4 Dispatch — `bellPoll.tsx`

`maybeFireNotificationToast` in `src/client/bellPoll.tsx` is the single
choke-point for every OSC 9 message (same function for the long-poll tick via
`dispatchOsc9Toasts` and for the `/terminal/list` seed via
`fireToastsForActiveProject`). HS-7272 extends it with one conditional:

```ts
showToast(message, { durationMs: 6000 });
if (isAppBackgrounded()) {
  const projectName = getActiveProject()?.name ?? 'Hot Sheet';
  void fireNativeNotification(projectName, message);
}
```

Key properties:

- **Dedupe is shared with the toast.** The existing `recentlyToasted` map
  (keyed on `secret::terminalId`, value = last message) gates the whole
  function. A build server emitting the same `Building stage 1/5` message on
  every long-poll tick fires exactly one toast AND one native notification.
  A changed message re-toasts AND re-fires native.
- **Active-project scope inherited.** `dispatchOsc9Toasts` only walks the
  active project's `notifications` map; cross-project OSC 9s still set the
  project-tab bell glyph (§24) but do not fire either channel from the
  background. Rationale: an OSC 9 fired in a backgrounded project would
  yank the user's attention via the OS banner — louder than the ambient
  bell glyph the existing cross-project model uses. Revisit if users
  report missing critical notifications from backgrounded projects.
- **Native fires only when backgrounded.** A user looking at Hot Sheet
  sees the toast; firing the OS banner on top would be a double
  notification and annoying. Tests in `tauriIntegration.test.ts` verify
  `isAppBackgrounded` returns false only when `!hidden && hasFocus()`.

## 30.5 Out of scope

- **Click-to-focus the firing terminal.** `tauri-plugin-notification`
  supports a `click` handler; Hot Sheet does not wire one yet. A user
  clicking the OS banner currently does nothing — focus returns to whatever
  they last had active. A follow-up ticket can attach a project-switch +
  drawer-open + tab-activate dispatcher if users ask.
- **Sound.** The OSC 9 feature is silent by policy (§27.7 carried over).
  Native notifications inherit the OS default (macOS Notification Center's
  "Play sound for notifications" toggle). We do not pass a custom sound id.
- **Per-project toggle.** All OSC 9 messages fire native when backgrounded.
  A user who wants to mute a chatty CI terminal must disable native
  notifications for Hot Sheet at the OS level (Settings → Notifications).
  Follow-up ticket can add a per-project or per-terminal mute if needed.
- **Browser-side `Notification` API.** In a browser context,
  `fireNativeNotification` silently no-ops. We could wire
  `new Notification(title, { body })` behind `Notification.permission`
  checks — deferred because the primary Hot Sheet distribution is the Tauri
  desktop app and the browser case is development-only.

## 30.6 Testing

`src/client/tauriIntegration.test.ts` (new) runs in the default Node
environment with `window` / `document` stubs installed in `beforeEach`. The
module only touches those globals lazily inside exported functions, so the
tests don't need jsdom. Coverage:

- `requestNativeNotificationPermission` — browser short-circuit, requests
  permission only when not already granted, idempotent on repeat calls,
  swallows API errors.
- `fireNativeNotification` — browser returns false, Tauri invoke fires with
  `{ title, body }`, invoke rejection returns false.
- `isAppBackgrounded` — hidden / unfocused / both / neither.

E2E coverage for the backgrounded-app case is deferred: Playwright's
`page.evaluate` can't convincingly simulate Tauri's `window.__TAURI__.core`
object, and asserting that an OS banner actually appeared requires platform
integration beyond the existing Chromium-only harness. Manual verification
via the test plan below.

## 30.7 Manual test plan

Add to `docs/manual-test-plan.md` §12 (OSC 9 section):

- In a drawer terminal while Hot Sheet is focused, run
  `printf '\e]9;Build done\a'`. A toast fires. NO OS banner appears (we're
  looking at Hot Sheet).
- Minimise Hot Sheet, then re-run the command via another path (e.g. via
  another terminal via ssh, or a scheduled job). An OS banner appears with
  the project name as title and `Build done` as body. The in-app toast also
  fires so it's visible when you return.
- Click back to Hot Sheet. The project-tab bell glyph is set (cross-project
  §24) — click the tab to clear.
- First run after install: the OS permission prompt appears once; subsequent
  runs use the saved permission.
- In a browser build (open `http://localhost:4174` in Chrome): an OSC 9
  fires the toast only — no OS banner, no errors in the console.

## 30.8 Cross-references

- [27-osc9-desktop-notifications.md](27-osc9-desktop-notifications.md) — the
  in-app toast feature. §27.7 listed native notifications as out-of-scope v1;
  this doc is the v2 follow-up.
- [24-cross-project-bell.md](24-cross-project-bell.md) — long-poll transport
  that feeds the dispatcher. Unchanged by HS-7272.
- `src-tauri/src/lib.rs` — `show_native_notification` command + plugin
  registration.
- `src/client/tauriIntegration.tsx` — JS helpers.
- `src/client/bellPoll.tsx` — dispatch gate.
- **Tickets:** HS-7272 (this doc), HS-7264 (parent — OSC 9 toast).
