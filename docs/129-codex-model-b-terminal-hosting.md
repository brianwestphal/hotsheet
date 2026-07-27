# 129 — Codex model-B: terminal owns the thread, drive discovers it

Status: **SHIPPED — Phases 1 + 2 (HS-9428/9429/9431), the adoption fix (HS-9438), and Phase 3's
gate-promotion + chase-retirement (HS-9430). Model-B is the shipped model, on by default.**

Companion to [121-codex-app-server-drive.md](121-codex-app-server-drive.md) (the drive) and
[123-codex-terminal-attach.md](123-codex-terminal-attach.md) (the terminal attach this superseded and,
as of HS-9430, deleted — that doc is now historical).
This doc is the home for the model-B *architecture* — the reframe of how a codex terminal and the
play-button drive share one conversation.

## 129.1 Why — the two-process problem

Codex is not Claude. With Claude, the process in your terminal **is** the agent; the play button
just messages it over the channel/MCP — one process, one conversation. Codex's TUI has **no
external prompt-injection interface**, so Hot Sheet drives codex by spawning its **own** headless
`codex app-server` process. That makes two codex processes — the drive and the terminal — that can
only share work by pointing at the **same thread (rollout) on the same shared daemon**.

**Model-A (shipped, docs/121+123):** the DRIVE owns the thread (`thread/start`), and the terminal
must *chase* it with `codex resume <id> --remote`. The chase is decided once, at terminal spawn
time, so a cold-start race (terminal spawns before the thread/daemon exist) strands the terminal on
plain `codex`, requiring the "↻ Rejoin codex" chip (docs/123 §123.8) or a manual restart. This is
the HS-9403 bug class.

**Model-B (this doc):** flip it. The **terminal owns a live daemon thread**; the **drive discovers
it by cwd** and `turn/start`s on it. Driven turns render in the window the user is already watching —
the Claude feel — with no chase, no race, no chip.

```
Model-A:  drive ──thread/start──► thread   ◄──resume <id> --remote── terminal (must chase, racy)

Model-B:  terminal = `codex --remote` ──owns──► thread on daemon (cwd = project)
          drive ──thread/list{cwd} ∩ loaded/list──► finds it ──turn/start──► renders in the terminal
```

## 129.2 Protocol basis (verified live, codex-cli 0.145.0)

Confirmed against the running daemon (read-only, on video-studio, 2026-07-24) and the app-server
JSON-schema (`codex app-server generate-json-schema`):

- `thread/loaded/list` → `{ data: string[] }` — the thread ids currently **loaded in memory** on
  the daemon (includes fresh, no-turn threads).
- `thread/read { threadId, includeTurns:false }` → `{ thread: { cwd, recencyAt, path, … } }` —
  resolves a **loaded** thread's cwd, INCLUDING a fresh one with no on-disk rollout. This is the
  discovery read (HS-9431). (`thread/list { cwd }` returns only threads **persisted to the on-disk
  session store** — it misses a just-launched terminal thread, so it is NOT used for discovery.)
- `thread/resume { threadId }` does **two** things, and the distinction is the whole of HS-9438:
  it loads a cold thread, **and it SUBSCRIBES the calling connection** to that thread's
  `turn/*` + `item/*` notifications. A connection that never resumed can still
  `turn/start` on a loaded thread, but receives **only `thread/status/changed`**
  (active/idle) — no `turn/started`, `item/*`, or `turn/completed`. Both directions verified live.
- `thread/resume` **FAILS** (`-32600 no rollout found for thread id …`) for a thread whose rollout
  JSONL hasn't been written yet — which is every `codex --remote` session before its first turn
  completes. `thread.path` names the file before it exists, so **on-disk existence**, not the
  field, is the signal.
- `turn/start { threadId, input }` needs no `config` and no prior resume: a loaded thread is
  already in memory. MCP is unaffected — the daemon spawns a thread's MCP children with **that
  thread's cwd** (verified with `lsof`), and Hot Sheet's global `hotsheet-channel` entry resolves
  its data dir from cwd, so a terminal launched with `-C <projectDir>` reaches the right project
  without the drive's per-thread override.
- `ThreadStartParams` has **no id field** — codex mints thread ids; a client cannot supply one. But
  `thread/start` returns the id immediately, and the two list methods make discovery first-class, so
  **no id coordination is needed**.
- `codex --remote <ADDR>` = "Connect the TUI to a remote app server endpoint"; present on both fresh
  `codex` and `codex resume` (+ `--last`), with `-C/--cd <DIR>` to set the session cwd. `ADDR` is
  `unix://<socket>` for the local daemon (`codex app-server daemon start` /
  `~/.codex/app-server-control/app-server-control.sock`). (`codex remote-control` is the separate
  token/pairing flavor for *networked* remote control — not used here.)
- Also available for later polish: `turn/steer`, `thread/injectItems`, `thread/read`.

## 129.3 Phase 1 — drive-side discovery (SHIPPED, HS-9428; corrected HS-9431)

`codexAppServerMapping.ts`: pure `loadedThreadIdsFromResponse` + `threadReadEntry(id, readResult)` +
`pickThreadForCwd(entries, cwd)` — pick the **loaded** thread whose **cwd matches**, tie-broken by
newest `recencyAt`. `codexAppServer.ts`: `discoverLiveThreadForCwd` + `codexDriveDiscoverEnabled()`.
`bootSession` tries discovery FIRST (daemon-only, gated) → `thread/resume` the discovered id, else
the existing model-A resume-persisted/`thread/start` fallback.

**Gate (HS-9430): now DEFAULT ON** — the `codexModelBTerminals` global-config flag (absent ⇒ enabled,
like `codexAppServerEnabled`); `HOTSHEET_CODEX_DISCOVER_THREAD` env force-overrides (`1` on / `0` off)
for tests + a quick revert. Verified end-to-end against real codex 0.145.0 (§129.4). model-A stays the
fallback (daemon down → plain codex; no live terminal thread → the drive starts its own), so a config
flip fully reverts without touching code.

### 129.3a Adoption ≠ resume (HS-9438 — the fix that made model-B actually fire)

Phase 1 shipped discovery that only **adopted a discovered thread if `thread/resume` succeeded**.
Against real codex that meant model-B never engaged in its primary case: a just-opened
`codex --remote` terminal has no rollout, resume answers `no rollout found`, and the drive
silently fell back to its own off-screen thread. Reported live (video-studio, 2026-07-25): play and
custom-command buttons drove turns the user never saw. Four changes:

1. **Adopt either way** (`adoptLiveThread`). Resume is still attempted — it's the event
   subscription, and it's how the per-thread MCP override gets pinned — but a failure no longer
   abandons the thread. `turn/start` drives a loaded thread regardless (live-verified).
2. **Unsubscribed lifecycle.** With no subscription, `thread/status/changed` → `idle` is what ends
   the turn (busy → idle → done). Gated on `!subscribed`, because a subscribed session gets
   idle-then-`turn/completed` for the same turn and would otherwise double-fire done/transcript.
   Cost while unsubscribed: no per-item Commands Log transcript detail for that first turn.
3. **Rejoin at the turn boundary** (`maybeRejoinLiveThread`, called from `startNextTurn`).
   Boot-time discovery is one shot but the drive session lives for the whole server process, so a
   terminal opened *after* the first play used to be invisible forever. Re-checking per turn also
   upgrades an adopted-unsubscribed thread to the full stream once its rollout exists. Deliberately
   runs *after* `phase = 'active'` — that assignment is what makes a concurrent play queue instead
   of starting a second turn.
4. **Exclude the drive's own thread** (`pickThreadForCwd(…, excludeId)`, `session.modelAThreadId`).
   A drive-owned thread's `recencyAt` is bumped by its own driven turns, so without the exclusion it
   out-recencies the terminal's live thread and the drive keeps re-electing its own.

**HS-9431 correction (found by a live test against the real daemon):** discovery is
`thread/loaded/list` → **`thread/read {threadId, includeTurns:false}` per loaded id** — NOT
`thread/list{cwd}`. A just-launched `codex --remote` terminal has a thread that is **loaded
in-memory but has no on-disk rollout yet** (no turn), so `thread/list` (which reads the on-disk
session store) returns it EMPTY — the exact model-B case. `thread/read` resolves a live in-memory
thread and returns its cwd. cwds are compared **realpath-normalized** (`/var/…` vs `/private/var/…`).

## 129.4 Phase 2 — terminal daemon-hosted (SHIPPED, HS-9429)

The codex `{{aiCommand}}` terminal launches daemon-hosted so it owns a discoverable thread:

- **Command** (`codexAppServer.ts::codexTerminalRemoteCommand`): `codex --remote 'unix://<sock>'
  -C '<projectDir>'` — **fresh** per open (maintainer decision Q1=a; users run `/resume` inside codex
  to continue a prior session). `-C <projectDir>` (= `dirname(dataDir)`) pins the session cwd so the
  drive's `pickThreadForCwd` matches. `terminals/resolveCommand.ts::pickAiCommand` uses it (codex
  branch) when the model-B gate is on, else the model-A `codexTerminalAttachCommand`; both fall
  through to plain `codex` when their precondition isn't met.
- **Daemon readiness** (maintainer decision Q2=a — await): the terminal spawn AWAITS the daemon so
  `codex --remote` reliably connects. Rather than rippling async through the whole registry,
  `spawnIntoSession` (`registry/lifecycle.ts`) checks `codexTerminalNeedsDaemonEnsure` (gate on +
  `ai_tool=codex` + socket not up) and, only in that rare cold case, `await`s `ensureCodexDaemonRunning`
  then spawns; **every other spawn stays synchronous** (so `attach`'s synchronous pty read is
  untouched). A failed ensure resolves to plain `codex` (the socket-absent fallback).
- **Gate**: the same `codexDriveDiscoverEnabled()` gate as the drive, so terminal-hosting +
  drive-discovery flip together. **Default ON** since HS-9430 (`codexModelBTerminals` config,
  env-overridable) — see §129.3.
- **Fallback**: daemon unreachable at spawn → plain `codex` (works standalone; the drive then uses
  model-A). The play button always works.
- **Known gate-on quirk (resolved by Phase 3):** with the gate on, the model-A "↻ Rejoin codex" chip
  (`codexReattachAvailable`, keyed off `codexTerminalAttachCommand`) can still evaluate against the
  now-unused attach command. Harmless while experimental; HS-9430 removes the chip.
- **Live verification (DONE, HS-9430):** proven end-to-end against real codex 0.145.0 — a real
  `codex --remote -C <cwd>` TUI registers a loaded daemon thread with that cwd **on launch, before any
  input** (so the drive can discover it the instant play is pressed), the discovery finds it by cwd,
  and a two-client `turn/start` fans out to the attached terminal client. This is what unblocked the
  default-on flip.

## 129.5 Phase 3 — promote the gate + retire the chase (SHIPPED, HS-9430)

Landed in two steps, deliberately: the reversible half first (a flag flip reverts it), the
irreversible half only once the maintainer had confirmed model-B in real use (2026-07-27 — "codex is
working as expected when clicking play / custom command buttons using aiCommand terminals").

**Step 1 — gate promoted + default-ON.** The `codexModelBTerminals` global-config flag
(env-overridable via `HOTSHEET_CODEX_DISCOVER_THREAD`) defaults ON.

**Step 2 — the model-A chase is DELETED.** Removed outright:

- `codexTerminalAttachCommand` (`codex resume <driveThreadId> --remote …`) and its branch in
  `pickAiCommand` — with it the `codexAttachOverride` resolve option;
- `src/terminals/codexReattach.ts` + `codexReattachAvailable` (and its test file);
- the `codexReattach` annotation on `GET /terminal/list` (`AnnotatedTerminalSchema`) and its
  per-request computation in `routes/terminal.ts`;
- the client "↻ Rejoin codex" chip — markup, `updateReattachButton`, `onReattachClick`,
  `TerminalInstance.codexReattach`, and its accent-pill SCSS;
- `SessionState.resolvedCommand`, the pre-shell-history-rewrite launch string that existed ONLY as
  the reattach comparison basis.

That deletes the HS-9403 cold-start-race class by construction: there is no longer a launch-time
decision that can be raced, because the terminal's own thread *is* the driven one.

Two behavior changes fall out of it:

- **`codexTerminalNeedsDaemonEnsure` / `prestartCodexDaemonIfNeeded` no longer require a persisted
  rollout on disk.** That was a model-A precondition (`codex resume` fails "no rollout found" until a
  turn has persisted one). Model-B's `codex --remote` only needs the socket, so a brand-new codex
  project now gets a warm daemon on its first terminal open instead of paying a cold start.
- **Gate OFF now means plain `codex`**, not "fall back to the attach": terminals host nothing and the
  drive keeps its own headless thread. See the matrix in §129.6.

**Settings surface.** Settings → Experimental → **"Codex terminals host the driven session"**
(`#settings-codex-model-b-terminals`), machine-global, default ON, next to the §121.7 drive toggle.
It writes `codexModelBTerminals` through the generic `PATCH /global-config` (no bespoke endpoint — the
flag is read at terminal-spawn and drive-boot time, so nothing needs a live re-init). The env var
still force-overrides in both directions, which is what tests use.

## 129.6 Fallback matrix (nothing regresses)

| Situation | Behavior |
| --- | --- |
| Daemon-hosted terminal live for the cwd | Drive discovers + `turn/start`s on it (model-B) |
| …and its rollout doesn't exist yet (fresh terminal) | Adopted anyway; lifecycle from `thread/status/changed`; subscription retried next turn (HS-9438) |
| Terminal opened AFTER the first play | Joined at the next turn boundary (`maybeRejoinLiveThread`, HS-9438) |
| No live terminal (headless / worker / no UI) | Drive starts/resumes its own thread (**model-A, the surviving headless fallback**) |
| Daemon unreachable at terminal spawn | Terminal launches plain `codex`; drive uses model-A |
| Toggle off (`codexModelBTerminals: false` / `HOTSHEET_CODEX_DISCOVER_THREAD=0`) | Terminal launches plain `codex`; drive owns its own thread. No discovery, no `--remote` — and since HS-9430, no attach either |

**Model-A survives as the DRIVE-side fallback only.** "Model-A" now names one thing: the drive
resuming/starting its own thread when nothing is discoverable. The terminal half of model-A (chasing
that thread at launch) is gone.

## 129.7 Decisions (RESOLVED, HS-9429 maintainer)

- **Q1 — continuity → (a) FRESH.** Each terminal open is a new `codex --remote` conversation; users
  run `/resume` inside codex to continue a prior session. (No `--last`, no id tracking.)
- **Q2 — daemon readiness → (a) AWAIT.** The spawn awaits `ensureCodexDaemonRunning` before launching
  daemon-hosted. Implemented as a *scoped defer* in `spawnIntoSession` (only the cold codex-model-B
  case awaits; all other spawns stay synchronous) rather than an async refactor of the whole
  registry — same guarantee, minimal surface (§129.4).

## 129.8 Testing

- **Unit** (shipped Phase 1): pure selection matrix (`pickThreadForCwd` / `threadReadEntry`) + drive
  discover/join vs fallback against the scripted fake app-server (`codexAppServer.test.ts`).
  HS-9438 adds, in the same fake: adopt-when-resume-fails, status-idle ends an unsubscribed turn,
  a subscribed turn does NOT double-end, the model-A exclusion, rejoin-when-the-terminal-arrives-late,
  and the unsubscribed→subscribed upgrade.
- **Live, local-only** (`src/codexModelBLive.test.ts`, HS-9431): drives the REAL codex daemon
  (skips via `describe.skipIf` when the daemon socket isn't present, so CI skips it) — starts a
  fresh daemon thread in a temp cwd and asserts the discovery sequence (`thread/loaded/list` →
  `thread/read` → `pickThreadForCwd`) finds it. Cost-free (no LLM turn); deletes the throwaway
  thread. HS-9438 adds the resume half to the same test: the fresh thread's reported `thread.path`
  does not exist on disk, and `thread/resume` on it errors `no rollout found` — the two facts the
  adoption fix rests on. This is the regression that would have caught the `thread/list` bug. The turn fan-out
  (a driven `turn/start` rendering in the terminal client) was verified by hand against the real
  daemon and is codex's own multi-client behavior.
- **Phase 2**: resolve-command tests for the `codex --remote` form + daemon-ready vs fallback; the
  daemon-readiness path per Q2.
- **Phase 3** (HS-9430): `codexDriveDiscoverEnabled` against a real config file (default-on with the
  key absent, explicit `false`/`true`, env override winning in both directions); an **end-to-end**
  `{{aiCommand}}` resolution through the REAL `codexTerminalRemoteCommand` — no injected resolver —
  covering daemon-up, daemon-absent, and toggle-off (this replaces the HS-9403 end-to-end that pinned
  the deleted attach; it stubs `$HOME` so the socket probe never touches the developer's `~/.codex`);
  the prestart matrix reworked for the dropped rollout precondition; and a browser E2E
  (`e2e/codex-drive-gating.spec.ts`) that the Experimental checkbox defaults ON and round-trips
  `codexModelBTerminals` through `PATCH /global-config` across a reload.
- **Manual (`docs/manual-test-plan.md`)**: real end-to-end on codex 0.145.0 — open a `{{aiCommand}}`
  terminal (daemon-hosted), press play, confirm the driven turn renders **in that terminal**; type a
  turn yourself and confirm it shares the thread + transcript.
