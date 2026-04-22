# 24. Cross-project bell indicator (HS-6603 / HS-6473 Phase 2)

## 24.1 Overview

Phase 2 of the terminal bell indicator (Phase 1 is documented in [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) §23.3). Phase 1 only surfaces bells in mounted xterm instances of the **active** project — bells fired in other projects, or in lazy / non-mounted terminals, are silently dropped. Phase 2 closes both gaps:

- **Across projects:** when terminal A in project Foo rings while the user is looking at project Bar, the **project tab** for Foo gains a bell glyph so the user knows Foo wants attention.
- **Across mount state within a project:** once the user navigates to Foo, the in-drawer terminal tab for terminal A still shows the bell glyph (even if its xterm instance is being mounted for the first time and missed the original `\x07` event).

The unifying mechanism is **server-side bell detection** — the PTY data handler in `TerminalRegistry` watches for `\x07` bytes and records a per-terminal `bellPending` flag. Both indicators read from this flag.

## 24.2 Server-side bell detection

`TerminalRegistry` (`src/terminals/registry.ts`) gains a per-session `bellPending: boolean` field (default `false`).

The PTY data handler — currently writes to the ring buffer + broadcasts to subscribers — adds a single check:

```ts
if (chunk.includes(0x07)) {
  if (!session.bellPending) {
    session.bellPending = true;
    notifyBellWaiters(); // wakes any pending /api/projects/bell-state long-poll
  }
}
```

Notes:

- The check runs on raw PTY output bytes — it fires whether or not any client xterm is currently mounted.
- The flag is sticky: it stays `true` until explicitly cleared via the `clear-bell` endpoint. Re-firing a bell on an already-pending terminal is a no-op (no new wake event) — the indicator is binary, not a counter.
- The flag is **in-memory only**. Server restart clears all pending bells. This is intentional: a stale bell across a process bounce is more annoying than informative.

## 24.3 New API endpoints

### 24.3.1 `GET /api/terminal/list` (extended)

The existing per-project terminal list endpoint includes a new field per session:

```jsonc
{
  "configured": [
    { "id": "default", "name": "Default", "alive": true, "bellPending": false }
  ],
  "dynamic": [
    { "id": "term-7", "alive": true, "bellPending": true }
  ]
}
```

Used by the in-drawer terminal-tab indicator on initial render and on project switch.

### 24.3.2 `POST /api/terminal/clear-bell`

Body: `{ "terminalId": "default" }`. Clears the `bellPending` flag for the named terminal in the request's project (auth via `X-Hotsheet-Secret`). Returns `{ ok: true }` whether or not the flag was set.

Called when:

- A drawer terminal tab is activated (clicked or auto-activated on drawer open / project switch).
- The user explicitly dismisses the indicator (no UI for this in v1; reserved for later).

### 24.3.3 `GET /api/projects/bell-state` (new long-poll)

Mirrors the shape of `GET /api/projects/permissions` (`src/routes/projects.ts:126`):

```jsonc
// query: ?v=<lastSeenVersion>
{
  "bells": {
    "<projectSecret>": { "anyTerminalPending": true,  "terminalIds": ["default", "term-7"] },
    "<otherSecret>":   { "anyTerminalPending": false, "terminalIds": [] }
  },
  "v": 42
}
```

Behavior:

- One global change-version counter (`bellVersion`) maintained in `src/routes/notify.ts`. Bumped on any per-terminal `bellPending` flip in either direction.
- On request: if `clientVersion < bellVersion`, return immediately with the current snapshot.
- Otherwise: register a waiter, return on the first wake or after a 3 s timeout (matches permissions polling).
- Auth: standard secret check. The endpoint reports state for **all** projects the calling secret can see — this is the multi-project tab view's source of truth, so it must aggregate. Single-project secrets get only their own entry.

### 24.3.4 Wake / change-version plumbing

Add to `src/routes/notify.ts`:

```ts
export function notifyBellWaiters(): void;
export function addBellWaiter(resolve: () => void): void;
export function getBellVersion(): number;
```

Same pattern as the existing `notifyPermissionWaiters` / `getPermissionVersion`.

`TerminalRegistry`'s data handler imports `notifyBellWaiters` lazily (avoids circular deps) and calls it on every flip.

## 24.4 Client behavior

### 24.4.1 Cross-project poll

A new long-poll loop, started from `src/client/app.tsx` boot when at least one project is registered (could degenerate to single-project when there's only one secret — still useful for the in-drawer indicator). Implementation lives in a new module `src/client/bellPoll.tsx`:

- Calls `/api/projects/bell-state?v=<lastVersion>` with the standard cache-busting `v` cursor.
- On each response, updates a module-level `Map<projectSecret, BellState>` and:
  1. Re-renders the project tab indicators (via a new `updateProjectBellIndicators()` exposed from `projectTabs.tsx`).
  2. Re-renders the in-drawer terminal-tab indicators if any terminal in the **current** project has changed state (via a new hook into `terminal.tsx`).
- Reconnects on error with a 5 s back-off (matches the permissions poll).

### 24.4.2 Project tab indicator

In `src/client/projectTabs.tsx`, the tab DOM gains an additional span placed **after** the project name. The dot and the bell are parallel indicators — the dot stays in its existing position before the name (feedback / attention / busy signalling unchanged); the bell sits to the right of the name:

```tsx
<div className="project-tab" data-secret={p.secret}>
  <span className="project-tab-dot"></span>
  <span className="project-tab-name">{p.name}</span>
  <span className="project-tab-bell"></span>
</div>
```

The bell span is empty by default. `updateProjectBellIndicators()`:

- Sets `tab.classList.toggle('has-bell', shouldShow)` where:
  - `shouldShow = bellState[secret]?.anyTerminalPending && secret !== getActiveProject()?.secret`
- When the class is added, inject a Lucide `bell` SVG into `.project-tab-bell` and trigger the same one-shot 350 ms wiggle animation used by the in-drawer Phase 1 indicator.
- When the class is removed, empty the span.

The visibility rule deliberately suppresses the indicator on the **active** project — the user is already looking at that project, so the in-drawer per-terminal bells are sufficient. Switching away from a project that still has pending terminal bells re-shows the project-tab indicator.

### 24.4.3 In-drawer terminal-tab indicator (Phase 1 + Phase 2 merge)

The Phase 1 client (`src/client/terminal.tsx`) sets `inst.hasBell` from xterm's `term.onBell()` callback. Phase 2 keeps that as a low-latency local-update path AND adds a server-driven path:

- On `loadAndRenderTerminalTabs()` (called on drawer open + project switch), fetch `/api/terminal/list` (already does so for tab discovery) and seed `inst.hasBell` from the response's `bellPending`.
- The cross-project poll's "current project changed" callback (24.4.1) re-syncs `inst.hasBell` for all the active project's terminals on each tick.
- `activateTerminal(terminalId)` already clears `inst.hasBell` locally; Phase 2 also issues `POST /api/terminal/clear-bell` so the server-side flag drops and downstream pollers see the clear.

The two paths converge: a bell that fires while the project is active and the terminal mounted updates instantly via `onBell`; a bell that fires for a non-current project surfaces the next time the user navigates in.

### 24.4.4 Activating a project does **not** clear server state

When the user clicks a project tab whose project has a pending bell:

- The project-tab indicator hides because of the `secret !== activeProject` rule, not because anything was cleared server-side.
- Per-terminal `bellPending` flags remain set, so the in-drawer terminal tabs continue to show their per-terminal bell indicators.
- Each terminal-tab indicator clears only when the user activates that specific terminal (POST `/api/terminal/clear-bell`).

This preserves the "which terminal wanted attention" information across the project switch.

## 24.5 Settings / configuration

No new user-facing settings in v1. The feature is on whenever the embedded terminal feature is on (Tauri-only — see §22.1).

**Explicitly out of scope for v1** (decided during HS-6603 design):

- **Audio chime.** Visual indicator only.
- **Bell decay timer.** Bells stay set until the user activates the originating terminal tab — no time-based auto-clear.
- **Clear-all gesture.** No right-click / project-level "acknowledge all" affordance. The user must click each pending terminal tab to clear its server-side flag. (The project-tab glyph itself disappears as soon as the project becomes active, which is enough at the project level.)
- **Cross-bell suppression toggle.** No per-user opt-out yet. Easy to add behind a `notify_terminal_bell` setting if a user asks.

## 24.6 Edge cases

- **Project removed while bell pending.** When a project is unregistered, `destroyProjectTerminals` already clears its sessions; that path naturally drops their `bellPending` state. The next bell-state poll snapshot omits the project entirely.
- **Terminal destroyed while bell pending.** Same — destroying a session drops its row from the registry, the next snapshot doesn't include it.
- **Lazy terminal that has never been spawned.** Has no session, so cannot have `bellPending`. This is correct: a lazy terminal cannot ring a bell because it isn't running. (If the user spawns it later via the +/play UI and it then bells, the standard path applies.)
- **Bell during PTY restart.** The Stop → Start cycle calls `restartSession`, which destroys + recreates the session. `bellPending` resets to `false` on the new session.
- **Lots of bells in the same terminal.** Setting `bellPending = true` on an already-pending session is a no-op — no extra wake events, no flickering. The indicator stays on until the user activates the tab.

## 24.7 Manual test plan additions

Add to [manual-test-plan.md](manual-test-plan.md) §22 → "Title and bell":

- [ ] In project A's terminal, run `printf '\\007'` while project B is active — project A's tab gains a bell glyph (small Lucide bell, accent color, with a 350 ms wiggle).
- [ ] Switch to project A — the project-tab bell clears immediately on activation.
- [ ] The in-drawer terminal tab for the bell-emitting terminal still shows its bell glyph.
- [ ] Click that terminal tab — its bell glyph clears.
- [ ] Switch back to project B; project A's tab no longer shows a bell (all per-terminal bells were acknowledged in step 4).
- [ ] Bell fires in a lazy terminal that has never been spawned: no indicator (terminal cannot run, so cannot bell).
- [ ] Restart the Hot Sheet server while bells are pending — all indicators clear on restart (in-memory only).

## 24.8 Out of scope

- Counting / badge numbers per terminal or per project — Phase 2 is a binary indicator only.
- Surfacing bells via OS-level notifications (Tauri `request_attention` style). The existing `notify_permission` setting suggests a similar `notify_terminal_bell` could be added later, but is not part of this phase.
- Cross-machine notifications (e.g. desktop ↔ phone). Out of scope for the foreseeable future.

## 24.9 Cross-references

- [23-terminal-titles-and-bell.md](23-terminal-titles-and-bell.md) §23.3 — Phase 1 (this doc supersedes the "Phase 2 deferred" stub there).
- [22-terminal.md](22-terminal.md) — base terminal feature.
- `src/routes/projects.ts:126` — pattern to mirror for the new bell-state endpoint (`/api/projects/permissions`).
- **Tickets:** HS-6603 (this doc), HS-6473 (Phase 1 doc).
