# 129 — Codex model-B: terminal owns the thread, drive discovers it

Status: **Phase 1 shipped (HS-9428); Phase 2 in design (HS-9429); Phase 3 planned (HS-9430).**

Companion to [121-codex-app-server-drive.md](121-codex-app-server-drive.md) (the drive) and
[123-codex-terminal-attach.md](123-codex-terminal-attach.md) (the terminal attach this supersedes).
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
  the daemon.
- `thread/list { cwd, … }` → threads for a cwd, each with `{ id, cwd, path, status, recencyAt }`.
- `ThreadStartParams` has **no id field** — codex mints thread ids; a client cannot supply one. But
  `thread/start` returns the id immediately, and the two list methods make discovery first-class, so
  **no id coordination is needed**.
- `codex --remote <ADDR>` = "Connect the TUI to a remote app server endpoint"; present on both fresh
  `codex` and `codex resume` (+ `--last`), with `-C/--cd <DIR>` to set the session cwd. `ADDR` is
  `unix://<socket>` for the local daemon (`codex app-server daemon start` /
  `~/.codex/app-server-control/app-server-control.sock`). (`codex remote-control` is the separate
  token/pairing flavor for *networked* remote control — not used here.)
- Also available for later polish: `turn/steer`, `thread/injectItems`, `thread/read`.

## 129.3 Phase 1 — drive-side discovery (SHIPPED, HS-9428)

`codexAppServerMapping.ts`: pure `loadedThreadIdsFromResponse` + `pickThreadForCwd(listResult,
loadedIds, cwd)` — pick the **loaded** thread whose **cwd matches**, tie-broken by newest
`recencyAt`. `codexAppServer.ts`: `discoverLiveThreadForCwd` (`thread/loaded/list` ∩
`thread/list{cwd}`) + `codexDriveDiscoverEnabled()` (env gate `HOTSHEET_CODEX_DISCOVER_THREAD=1`,
default OFF). `bootSession` tries discovery FIRST (daemon-only, gated) → `thread/resume` the
discovered id, else the existing model-A resume-persisted/`thread/start` fallback. Dormant until
Phase 2 gives it a daemon-hosted terminal to discover.

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
- **Gate**: reuses `HOTSHEET_CODEX_DISCOVER_THREAD` (Phase-1) so terminal-hosting + drive-discovery
  flip on together; Phase 3 promotes it to a real setting.
- **Fallback**: daemon unreachable at spawn → plain `codex` (works standalone; the drive then uses
  model-A). The play button always works.
- **Known gate-on quirk (resolved by Phase 3):** with the gate on, the model-A "↻ Rejoin codex" chip
  (`codexReattachAvailable`, keyed off `codexTerminalAttachCommand`) can still evaluate against the
  now-unused attach command. Harmless while experimental; HS-9430 removes the chip.
- **Remaining before default-on:** the live interplay check (real `codex --remote` terminal + a drive
  `turn/start` on its thread rendering in the terminal) is manual (§129.8) — the automated tests cover
  the resolution + ensure-decision, not a real codex binary.

## 129.5 Phase 3 — retire the chase (PLANNED, HS-9430)

Once B is proven end-to-end: remove `codexTerminalAttachCommand`, `terminals/codexReattach.ts` +
`codexReattachAvailable`, the `codexReattach` field on `GET /terminal/list`, and the "↻ Rejoin
codex" chip (HS-9394/9397 — deletes the HS-9403 class). Promote the env gate to a real
config/setting. Keep model-A as the documented **headless fallback** (no live terminal → the drive
starts its own thread) so cron/worker/no-UI runs never regress.

## 129.6 Fallback matrix (nothing regresses)

| Situation | Behavior |
| --- | --- |
| Daemon-hosted terminal live for the cwd | Drive discovers + `turn/start`s on it (model-B) |
| No live terminal (headless / worker / no UI) | Drive starts/resumes its own thread (model-A) |
| Daemon unreachable at terminal spawn | Terminal launches plain `codex`; drive uses model-A |
| Gate off (default, pre–Phase 3) | Entirely model-A — no discovery, no `--remote` |

## 129.7 Decisions (RESOLVED, HS-9429 maintainer)

- **Q1 — continuity → (a) FRESH.** Each terminal open is a new `codex --remote` conversation; users
  run `/resume` inside codex to continue a prior session. (No `--last`, no id tracking.)
- **Q2 — daemon readiness → (a) AWAIT.** The spawn awaits `ensureCodexDaemonRunning` before launching
  daemon-hosted. Implemented as a *scoped defer* in `spawnIntoSession` (only the cold codex-model-B
  case awaits; all other spawns stay synchronous) rather than an async refactor of the whole
  registry — same guarantee, minimal surface (§129.4).

## 129.8 Testing

- **Unit** (shipped Phase 1): pure selection matrix (`pickThreadForCwd`) + drive discover/join vs
  fallback against the scripted fake app-server (`codexAppServer.test.ts`).
- **Phase 2**: resolve-command tests for the `codex --remote`/`resume --last --remote` forms +
  daemon-ready vs fallback; the daemon-readiness path per Q2.
- **Manual (`docs/manual-test-plan.md`)**: real end-to-end on codex 0.145.0 — open a `{{aiCommand}}`
  terminal (daemon-hosted), press play, confirm the driven turn renders **in that terminal**; type a
  turn yourself and confirm it shares the thread + transcript.
