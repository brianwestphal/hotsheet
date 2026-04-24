# 27. OSC 9 desktop notifications (HS-7264)

## 27.1 Overview

OSC 9 is the iTerm2-convention "desktop notification" escape: a shell emits

```
printf '\x1b]9;Build done\x07'
```

and the terminal host surfaces the payload as a short, user-readable message. Hot Sheet treats it as an extension of the bell indicator (§23.3) — whereas a plain `\x07` communicates *something happened*, OSC 9 carries the specific message a user wants to see without having to switch tabs and scroll the scrollback.

This feature ships the server-side detector, the cross-project transport, and an in-app toast that reuses the shared toast affordance used by the plugin system (`src/client/toast.tsx`). Native OS notifications via `tauri-plugin-notification` are explicitly out of scope for v1 and tracked under HS-7272 as a follow-up.

## 27.2 Detection

The scanner in `src/terminals/registry.ts` (formerly `scanForRealBell`, now `scanPtyChunk`) walks every byte of every PTY output chunk. It already tracks OSC/DCS/APC/PM/SOS string state to avoid misreading an OSC-terminating BEL as a bell. For HS-7264 the same pass accumulates the OSC payload into `SessionState.oscAccumulator` while the scanner is inside an OSC specifically (not DCS/APC/PM/SOS), and on close (BEL or ESC\\) inspects the payload:

- If the payload starts with `9;` — the rest is the user-facing notification message.
- If the rest starts with a digit followed by `;` (e.g. `9;1;…`, `9;4;…`) — that's an iTerm2 proprietary subcommand (progress bars, marks), NOT a notification. Skipped.
- Any other OSC number — passes through untouched; xterm.js still processes titles (OSC 0/1/2), CWD (OSC 7), hyperlinks (OSC 8).

The accumulator is capped at **4 KiB** (`MAX_OSC_PAYLOAD_LEN`). Real-world OSC payloads are short (titles, URLs, one-line notification strings); the cap guards against a pathological or adversarial stream pinning per-session memory.

State that must reset on PTY restart: `bellScanInString`, `bellScanAfterEsc`, and the new `oscAccumulator`. `spawnIntoSession` zeroes all three.

## 27.3 Server data model

`SessionState` gains one new field:

```ts
notificationMessage: string | null;
```

Latest-wins semantics: a second OSC 9 overwrites the first. The `bellPending` flag is still the "attention on this tab" signal (glyph, cross-project indicator); `notificationMessage` is the extra payload the toast layer renders.

Both fields clear together:
- `clearBellPending(secret, terminalId)` clears both and returns `true` on flip (so the caller knows to bump `bellVersion`).
- `restartTerminal` and `destroyTerminal` reset via fresh session state.

New export: `getNotificationMessage(secret, terminalId)` for the route layer to read the value without exposing the full `SessionState`.

`listBellPendingForProject` changed shape from `string[]` to `Array<{ terminalId: string; message: string | null }>`. Existing in-tree callers (`src/routes/projects.ts`, the registry tests) were updated in the same change.

## 27.4 Transport

### `/api/terminal/list`

Each annotated entry gains `notificationMessage: string | null` alongside the existing `bellPending`, `state`, and `exitCode`. Consumed by `loadAndRenderTerminalTabs` on first drawer open / project switch / settings save to seed toasts for notifications that arrived while the client was disconnected or on another project.

### `/api/projects/bell-state` (cross-project long-poll)

Per-project payload shape extends from

```ts
{ anyTerminalPending: boolean; terminalIds: string[] }
```

to

```ts
{ anyTerminalPending: boolean; terminalIds: string[]; notifications: Record<string, string> }
```

`notifications` is a map of `terminalId → message` for terminals whose shell pushed an OSC 9. Bell-only terminals (plain `\x07` with no OSC 9) are absent from `notifications` even though their id is in `terminalIds`. The field is always present (possibly empty) so clients can do an unconditional lookup.

### `/api/terminal/clear-bell`

Unchanged externally. Server-side now clears both `bellPending` and `notificationMessage` in one step — the tab has been acknowledged; both bits of state are invalidated simultaneously.

## 27.5 Client UI

### Toast

The toast helper in `src/client/toast.tsx` renders a fixed-position `.hs-toast.plugin-toast` element. Plugin-action toasts use `durationMs: 3000` (default); OSC 9 toasts use `durationMs: 6000` because the message is written for the user to *read*, not just to acknowledge.

Variant styling (`hs-toast-info` / `hs-toast-success` / `hs-toast-warning`) is declared on the className but not currently differentiated in CSS — `info` uses the existing `plugin-toast` styling. Follow-up ticket can add visual differentiation if needed.

### Dispatch

Toasts dispatch from `bellPoll.tsx` on every long-poll tick (`dispatchOsc9Toasts`) and from `terminal.tsx` on every `/terminal/list` seed (`fireToastsForActiveProject`, exported from `bellPoll`). Both share a `recentlyToasted: Map<'{secret}::{terminalId}', string>` dedupe cache so:

- Re-polling the same message does not re-toast.
- A changed message from the same terminal DOES toast (build server emitting "stage 1", "stage 2", … each fires).
- After `clearBellPending` drops a notification, the cache entry is GC'd on the next tick so a subsequent identical-text notification re-toasts (the user acknowledged, they still deserve to see the re-fire).

### Scope — active project only

OSC 9 toasts only render for the **active project**. Rationale: an OSC 9 fired from a background project should not yank the user out of their current context with a toast. The cross-project `bellPoll` still reports `notifications` for every project so:

- The project-tab bell glyph (§24) signals *which* project wanted attention.
- When the user switches to that project, `loadAndRenderTerminalTabs` fires the toast for whatever's in the `/terminal/list` seed via `fireToastsForActiveProject`.

This is the same "ambient awareness, focused attention" pattern the bell glyph uses.

## 27.6 Subcommand parking lot (9;1, 9;4, 9;N;…)

iTerm2 has extended OSC 9 into a subcommand namespace for progress indicators and other ephemeral UI:

- `9;1;remote;ttl` — legacy progress bar.
- `9;4;state;progress` — newer progress (state = 0/1/2/3/4 for remove/default/error/indeterminate/pause; progress = 0–100).

Hot Sheet v1 **parks these** — the scanner detects the numeric-subcommand form and returns `null` so no toast fires. Rationale: progress bars deserve a dedicated UI (a slim indicator on the tab, not a series of overlapping toasts); implementing them via the toast layer would be annoyingly noisy. If there's demand, `9;4` progress can get its own UI affordance in a follow-up ticket; the scanner already discriminates.

Plain `9;<message>` remains the supported form. Subcommand numbers `2`–`9` that iTerm2 may define later will also be parked (same digit-semicolon guard).

## 27.7 Out of scope (explicit deferrals)

- **Native OS notifications via `tauri-plugin-notification`.** HS-7272 follow-up ticket. Requires: Cargo dep + `.add_plugin` registration in `src-tauri/src/main.rs`, a JS-side permission-request at app start (`requestPermission`), a `fireNative(message, title)` wrapper that falls back to the toast when `getTauriInvoke()` is null. V1 ships toast-only; v2 adds the native channel for backgrounded-Tauri case.
- **Cross-project OSC 9 toasts.** See §27.5 — the bell glyph does the cross-project signalling; toasts stay active-project-only. Revisit if users report missing notifications from backgrounded projects.
- **Click-to-focus / click-to-open the firing terminal.** The toast is transient and non-interactive for v1. A click handler that switches projects + activates the terminal is a natural extension; defer until needed.
- **Audio.** The bell feature (§23) explicitly has no audio chime; OSC 9 inherits that policy.
- **Progress bar rendering** (OSC 9;4 subcommand). See §27.6.

## 27.8 Testing

### Unit tests (shipped with this change)

In `src/terminals/registry.test.ts`, a new `describe('OSC 9 desktop notifications (HS-7264)')` block covers:

- BEL-terminated notification captures the message + flips `bellPending`.
- ST-terminated notification (ESC\\) also captured.
- Split-chunk payload (OSC open in one chunk, message in next, terminator in a third).
- `9;<digit>;…` subcommand forms are correctly ignored.
- OSC 0 / 1 / 2 / 7 don't set `notificationMessage`.
- Latest-wins overwrite.
- `clearBellPending` clears both fields.
- `listBellPendingForProject` returns the new shape with per-terminal message.

`src/routes/projects.test.ts` updated to exercise the new `notifications` map in the `/projects/bell-state` response.

### Follow-up tests

E2E coverage (Playwright) and a manual-test-plan entry are tracked under HS-7273 (follow-up) — they need a fixture that emits OSC 9 via a real PTY (same pattern as the title/bell tests in `e2e/terminal-drawer-title-and-bell.spec.ts`).

## 27.9 Manual test plan (add to `docs/manual-test-plan.md` §12)

- In a drawer terminal, run `printf '\e]9;Build done\a'`. A toast appears with text "Build done". The tab also gains the bell glyph.
- Click the tab — glyph clears and the toast remains visible until it auto-fades.
- Switch to another project. In a terminal there, run `printf '\e]9;Tests passed\a'`. A toast does NOT appear (active-project scope). The first project's tab gains a bell dot.
- Switch back. The "Tests passed" toast surfaces on arrival via `loadAndRenderTerminalTabs`.
- Run `printf '\e]9;4;3;50\a'` — NO toast fires (iTerm2 progress subcommand parked).
- Repeated `printf '\e]9;Same message\a'` in quick succession — only one toast (dedupe).
- Change message: `printf '\e]9;Stage 1\a'` then `printf '\e]9;Stage 2\a'` — two distinct toasts.

## 27.10 Cross-references

- [22-terminal.md](22-terminal.md) — base terminal.
- [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) — OSC 0/2 title + Phase 1 bell.
- [24-cross-project-bell.md](24-cross-project-bell.md) — long-poll transport that carries `notifications` now.
- [25-terminal-dashboard.md](25-terminal-dashboard.md) — tile bell indicators pick up OSC 9's `bellPending` flip for free.
- `src/client/toast.tsx` — shared toast helper.
- **Tickets:** HS-7264 (this doc), HS-7272 (native Tauri notification follow-up), HS-7273 (e2e coverage follow-up).
