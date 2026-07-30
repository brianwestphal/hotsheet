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

**Gate: REMOVED (HS-9513, 2026-07-31).** Model-B is unconditional; `HOTSHEET_CODEX_DISCOVER_THREAD=0|1` is the remaining escape hatch. The former `codexModelBTerminals` global-config flag (absent ⇒ enabled,
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
| Daemon unreachable at terminal spawn | Terminal launches plain `codex`; drive uses model-A — and **says so once in the Commands Log** (HS-9446) |
| Forced off (`HOTSHEET_CODEX_DISCOVER_THREAD=0` — the setting is gone, HS-9513) | Terminal launches plain `codex`; drive owns its own thread. No discovery, no `--remote` — and since HS-9430, no attach either |

**The one silent case, now audible (HS-9446).** A terminal that launches plain `codex` because the
daemon was unreachable owns a thread the drive can never discover, so driven turns run off-screen for
as long as it stays open — the HS-9403 shape, which cost days of misdiagnosis when nothing surfaced
it. `terminals/codexHostedWarning.ts` writes ONE Commands Log entry per (project, terminal) when a
codex project with model-B + the drive on resolves a codex launch without `--remote`. Deliberately a
log line rather than a rebuilt chip: the cold spawn already awaits `ensureCodexDaemonRunning` and the
daemon is pre-started at registration, so this should be rare — the log is how we find out whether it
happens at all before paying for an affordance. The command check (whole-word `codex`, no `--remote`)
is what keeps it per-terminal; the daemon-ensure gate is per-project and would also fire for a `btop`
terminal. The write goes through `runWithDataDir` because an eager spawn happens outside any request,
where `getDb()` would file the entry under the default project.

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
- **HS-9439** (mid-turn resubscribe): unit tests against the scripted fake — the retry fires only
  when the turn started unsubscribed, carries no `config`, persists the rollout path, backs off
  three times and then stops; the in-flight turn still ends on status idle *exactly once* even
  though `turn/completed` now also arrives; and the NEXT turn (started subscribed) ends on
  `turn/completed` while ignoring a foreign idle. Fake timers are scoped to
  `setTimeout`/`clearTimeout` so the suite's `setImmediate`-based flush still works. Verified live
  against the real daemon as well (first-turn transcript detail present).
- **Phase 3** (HS-9430): `codexDriveDiscoverEnabled` against a real config file (default-on with the
  key absent, explicit `false`/`true`, env override winning in both directions); an **end-to-end**
  `{{aiCommand}}` resolution through the REAL `codexTerminalRemoteCommand` — no injected resolver —
  covering daemon-up, daemon-absent, and toggle-off (this replaces the HS-9403 end-to-end that pinned
  the deleted attach; it stubs `$HOME` so the socket probe never touches the developer's `~/.codex`);
  the prestart matrix reworked for the dropped rollout precondition; and a browser E2E
  (`e2e/codex-drive-gating.spec.ts`) that the Experimental checkbox defaults ON and round-trips
  `codexModelBTerminals` through `PATCH /global-config` across a reload. **Removed in HS-9513** — the e2e now asserts the control is ABSENT instead.
- **Manual (`docs/manual-test-plan.md`)**: real end-to-end on codex 0.145.0 — open a `{{aiCommand}}`
  terminal (daemon-hosted), press play, confirm the driven turn renders **in that terminal**; type a
  turn yourself and confirm it shares the thread + transcript.

## 129.9 Multi-client protocol facts (MEASURED, HS-9440, codex-cli 0.145.0)

Model-B always has **two clients on one thread** — the terminal that owns it and the drive that
adopted it — so who-gets-what stops being an implementation detail. Measured directly against the
real daemon with two independent connections (T = thread owner/subscribed, D = adopter). These are
observations of codex's behavior, not our contract, so re-measure on a codex upgrade.

**1. `thread/status/changed` is broadcast to EVERY connection, subscribed or not.** D saw
`active` → `idle` for a turn T started and D knew nothing about. This is *why* the HS-9438
unsubscribed lifecycle works at all — and equally why a foreign turn's `idle` can end ours (§129.10).

**2. Approvals are routed by SUBSCRIPTION, not by who started the turn.**

| Drive state | Who receives `item/commandExecution/requestApproval` |
| --- | --- |
| Unsubscribed (first turn on a fresh adopted thread) | **The TUI only** — even for a turn the DRIVE started |
| Subscribed (turn 2 onward) | **Both**, same request id; `serverRequest/resolved` fires when either answers |

Two consequences, **both since fixed**:

- The first driven turn's approvals surfaced in the terminal, not Hot Sheet's §47 overlay —
  including for users who set `codex_interactive_permissions: false`, whose auto-accept the drive
  never got to apply. **Fixed by the mid-turn resubscribe (HS-9439, fact 5).** This was the
  user-reported bug **HS-9445**: codex asked, in the TUI, *"Allow the hotsheet-channel MCP server to
  run tool `hotsheet_signal_done`?"* — a request the drive is supposed to auto-accept invisibly,
  which it never saw because it held no subscription.
- Once both are subscribed, an approval answered in the TUI left our overlay standing, because the
  drive ignored `serverRequest/resolved`. **Fixed by HS-9447:** the notification carries
  `{ threadId, requestId }` (the request id is the JSON-RPC id, numeric — captured live), and the
  drive now dismisses the matching overlay and skips replying to a request codex has already closed.
  Our own reply produces the same notification, but the entry is gone by then, so it no-ops.
  Live-verified: the drive's overlay came down 365 ms after the TUI answered, and the denied command
  never ran.

**What raises an MCP elicitation at all** (worth knowing when reproducing): codex's per-tool
`[mcp_servers.<name>.tools.<tool>] approval_mode`. Measured on 0.145.0 — `"prompt"` **asks**;
`"approve"` **auto-allows** (it is what codex persists when a user picks *Always allow*). Hot Sheet
does not write this key, so a project's behavior here is the user's own codex config.

**3. Waiting for approval is `active`, not `idle`.** The status is
`{ type: 'active', activeFlags: ['waitingOnApproval'] }`. So the unsubscribed idle-ends-the-turn path
does **not** misfire mid-turn on an approval — the risk that looked most likely before measuring.
Other observed values: `activeFlags: []` and `{ type: 'notLoaded' }` (thread unloaded/deleted, which
correctly ends an unsubscribed turn since anything but `active` does).

**4. A concurrent `turn/start` is ABSORBED into the running turn, not queued as a second one.** D
firing `turn/start` mid-turn got a normal `{ turn: { id, status: 'inProgress' } }` result with a
*fresh* turn id — but that id never produced its own `turn/started`/`turn/completed`, and the thread
ran ONE turn (`thread/read` shows a single turn containing **both** prompts, both answered). Refines
docs/121's "codex queues a mid-turn `turn/start`": the prompt lands, but a caller waiting on *its*
turn id waits forever. The drive is unaffected today (it matches on thread, not turn id, and its own
O1 queue prevents self-overlap), but anything keying off the returned turn id must not assume it will
be echoed back.

**5. A fresh thread becomes resumable ~1 second INTO its first turn, not at the end.** Measured: the
rollout JSONL appeared at **+1058 ms** and `thread/resume` succeeded at **+1063 ms**, while the turn
ran to +6069 ms. The mid-turn resume was non-disruptive — the turn completed normally and D then
received the full `item/*` + `turn/completed` stream. This is the key finding: the drive does **not**
have to wait for the next turn boundary to subscribe.

**SHIPPED as HS-9439** — `scheduleMidTurnSubscribe` in `codexAppServer.ts` retries `thread/resume`
at 1.5 s / 3 s / 6 s after the `turn/start` ack whenever the turn began unsubscribed, then stops (a
bounded ladder, not a poll). It sends no `config`: HS-9438 established the per-thread MCP override
isn't needed for an adopted thread, and re-sending it mid-turn provokes MCP server restarts while a
tool call may be in flight. That closes both open gaps for the first driven turn — per-item
transcript detail, and approvals reaching the §47 overlay instead of only the TUI.

One subtlety the implementation has to respect: **how a turn ends is pinned when it starts**
(`Session.turnEndsOnStatus`), not read live from `subscribed`. Flipping the rule mid-flight opens a
window where the turn ends by *neither* rule — subscribing just after `turn/completed` was broadcast
(so we never saw it) but before the idle we would then start ignoring — and busy sticks until the
client's 60 s fallback. With the snapshot, a mid-turn subscribe is purely additive: this turn still
ends on idle, and the `turn/completed` the new subscription also delivers is a no-op.

Live-verified end-to-end against the real daemon: driving a thread owned by a separate client, the
first turn's Commands Log entry now carries its agent-message detail (it was empty before).

## 129.10 Premature-idle race — measured scope (HS-9440)

The race HS-9438 left open: while unsubscribed, the drive ends its turn on `idle`, so a *foreign*
turn's `idle` arriving between our `phase = 'active'` and our `turn/start` landing ends our turn
before it starts. Fact 1 confirms the premise (foreign idles do reach us). Fact 4 narrows the damage:
if our prompt is absorbed into the running turn, the shared `idle` at the end is a *correct* end —
our work was done in that turn. The genuinely wrong case is only when the foreign turn ends inside
that window, so our prompt starts a NEW turn whose idle we've already consumed.

The window is the discovery round-trip: `startNextTurn` sets `phase = 'active'`, then awaits
`maybeRejoinLiveThread` (`thread/loaded/list` + one `thread/read` per loaded thread) before sending
`turn/start`. Milliseconds locally, but it grows with the number of loaded threads. Exposure is the
first driven turn after a terminal opens (the `!subscribed` gate closes the path afterward), and both
the agent's own `hotsheet_signal_done` and the client's 60 s fallback already bound the damage.

**Guard (HS-9448, SHIPPED):** `Session.turnStartPending` is armed just before we send `turn/start`
and disarmed when its response lands; while set, a `thread/status/changed` idle is ignored. That
covers exactly the window and — unlike the "saw active since turn start" guard rejected during
HS-9438 — has no stick-forever failure mode, because it waits on a response we always get rather than
on a transition codex may never emit.

Two implementation details worth keeping: the disarm happens **before** `onTurnEnded` on a failed
`turn/start`, because that call can drain the queue straight back into `startNextTurn` and the
re-entrant arm must not be clobbered by the outer disarm; and the test pins the race by having the
scripted fake **withhold** the `turn/start` response (`deferTurnStart` / `releaseTurnStart`) so an
idle can be delivered inside the sent-but-unacked window. Removing the guard fails that test.


## 129.11 The toggle was removed (HS-9513, 2026-07-31)

Maintainer decision, alongside the docs/124 per-tool gate removal: with each AI tool an
`AiToolPlugin` (docs/132), readiness is managed by not shipping a plugin publicly and by
labeling early releases alpha/beta — not by runtime flags every user carries.

`codexModelBTerminals` was the easy half of that call, because it never gated readiness. It
selected between model-B and model-A, and **model-A already survives as the automatic
drive-side fallback** (§129.4) whenever nothing is discoverable for the cwd. So the flag
only ever offered a manual override of a decision the code already makes correctly. Gone:
the global-config key, its zod field, the Experimental checkbox, and its row in `pages.tsx`.

`HOTSHEET_CODEX_DISCOVER_THREAD` stays. It is what the tests use, and it keeps a quick
revert available without a user-facing toggle implying the choice is routine.

**A leftover `codexModelBTerminals: false` in a user's `~/.hotsheet/config.json` is now
ignored**, which is the one behavior worth pinning rather than assuming — a stale key
silently keeping model-B off after its flag was deleted is exactly the failure a deletion
invites. `codexAppServer.test.ts` asserts it.

The sibling `codexAppServerEnabled` was deliberately NOT removed in the same pass: it is
the only in-app path that clears handshake-failure flags, so deleting it would take a real
recovery route with it. That question is HS-9513's remaining half.
