# 75. Load resilience — off-loop execution + central background-work scheduler

Theme: **Load resilience.** Every ticket spawned from this design carries the
`load-resilience` tag. The goal is a single, stated property:

> **Hot Sheet must stay interactive — project-tab switches, ticket edits, polls —
> regardless of how many project tabs are open or how slow/overloaded the machine
> is, even for a long time. Background work degrades (runs late); it never starves
> the foreground.**

> **Status: all five phases shipped.** Phase 1 (off-loop git status, HS-8723) is the
> contained fix for the reported freeze. Phase 2 (HS-8724) added the central
> `backgroundScheduler` and migrated every background consumer onto it (Option A —
> backups + snapshots coordinated but never deferred; git-refresh + markdown-sync +
> GC deferrable under load). Phase 3 (HS-8725) added active-project tracking so a
> background tab's `.git` nudge no longer fans out into proactive refresh — the
> scaling lever. Phase 5 (HS-8727) took the chunk-with-yields path for the heavy
> attachment paths (worker-thread full offload deferred to HS-8728). Phase 4 (HS-8726)
> added wake detection + a post-wake drain-stagger so a resume-from-suspend doesn't
> fire every project's overdue timers at once. Remaining: only the optional,
> measurement-gated HS-8728 (worker-thread offload).

## 75.1 Why this exists — the incident

On 2026-06-04 (~08:00 local) the user hit a freeze twice in a row: project-tab
switching stopped working ("the connection to the server died"), requiring a kill +
relaunch. The `freeze.log` diagnostics (HS-8054, `src/diagnostics/freezeLogger.ts`)
told the story:

- The **event loop was blocked in 500–1200 ms bursts every few seconds, sustained**
  (`source: "server-heartbeat"`, "event-loop blocked"), through the whole window.
- Each block lined up timestamp-for-timestamp with a synchronous
  `git.getStatus` entry (`source: "server-instrument-sync"`, 200–1800 ms each).
- The trigger was a **sleep→wake thundering herd**: a ~3.5 h "block" recorded the
  overnight suspend (monotonic clock counts suspended wall-time); on wake, every
  registered project's overdue timers + watchers + fetches fired at once into a cold
  loop. After each restart the per-minute block count tripled (12–18/min → 86 → 121
  → 141/min) as all 9 projects re-initialized simultaneously.

Root cause was **not** corruption or a crash. It was **event-loop saturation**: with
9 project tabs open, synchronous, CPU/IO-heavy background work — chiefly
`spawnSync`-based git status, fanned out to every tab on every change — ran on the
single shared Node event loop and blocked all request handling.

> **HS-9238 / HS-9239 — 2026-06-30 follow-up (disk-pressure recurrence).** A reboot
> + macOS Spotlight reindex saturated the disk and the freeze returned on tab-switch.
> `freeze.log` again pinned it on the server event loop: the git-status chain
> (collapsed to a single `git status --porcelain=v2 --branch` + an event-driven
> recursive working-tree watch — see [48-git-status-tracker.md](48-git-status-tracker.md) §48.3.1/§48.3.3),
> and the **startup backup catch-up** firing every overdue tier's heavy
> CHECKPOINT + `dumpDataDir` + fsync + manifest right at launch (now delayed to 30 s
> + 5-min tier backpressure-gated — see [7-backup-restore.md](7-backup-restore.md) §7.1).
> Crucially, the largest blocks were **uninstrumented** (a ~900 ms `server-heartbeat`
> gap with no adjacent `server-instrument-*` label). **HS-9239 closes that blind spot:**
> `src/db/queryInstrumentation.ts` wraps every cached PGLite instance in a Proxy that
> times `query` / `exec` / `dumpDataDir` (WASM, synchronous on the loop) via
> `instrumentAsync`, so a slow statement now appears in `freeze.log` as
> `pglite.query: SELECT … FROM tickets …` with its SQL. Disable with
> `HOTSHEET_DISABLE_QUERY_INSTRUMENTATION=1`. The structural floor remains: PGLite
> runs on the main loop — moving it to a worker thread is the open follow-up.

## 75.2 The diagnosis: per-project *state* is fine; per-project *execution* is not

Hot Sheet is one Node process multiplexing all project tabs by secret
(`src/server.ts:42`, `src/projects.ts`). That topology is correct — N tabs is not N
processes.

Per-project **state** is also cheap and correct: each project legitimately has its
own git repo, PGLite DB, backup dir, and dirty flags. A handful of `Map` entries and
`setTimeout` handles per project costs nothing.

What's wrong is that **scheduling and execution are *also* per-project and entirely
uncoordinated.** There is no central authority deciding *when* or *how much*
background work runs. Instead there are N independent timer sets and watchers all
firing onto one shared event loop:

| Background activity | Per-project cost | Scales as | Blocks loop? |
|---|---|---|---|
| Git status read (`src/git/status.ts`) | up to 5 `spawnSync` git invocations | O(N), fanned to **all** tabs on any one project's `.git` change (`src/routes/notify.ts:14`) | **Yes — synchronous** |
| Backup tiers (`src/backup.ts`) | 3 timers (5min/hourly/daily) | O(N) timers; **already globally serialized** by `withGlobalBackupLock` (HS-8229) | Mostly no (fsync on threadpool); manifest hashing can |
| Snapshot (`src/db/snapshot.ts`) | 2 timers (2 s debounce + 120 s safety) | O(N), **no** global gating | gzip/dump can |
| Markdown sync (`src/sync/markdown.ts`) | 2 debounce timers | O(N), no global gating | rarely |
| Attachment manifest / GC (`src/attachmentBackup.ts`) | per-backup hash of every attachment | O(attachments) — observed up to 19 s wall-clock | hashing can |

Two structural defects fall out of this table:

1. **Synchronous blocking work on the shared loop** (`spawnSync` git). A single such
   call freezes *every* tab; load multiplies it. This is the whole catastrophic-
   failure class.
2. **Uncoordinated O(N) fan-out + no admission control.** Any one project's change
   wakes all N tabs, each independently re-running work. Backups got a global mutex
   (the right instinct), but nothing else did, and a mutex is not load-aware — it
   serializes but cannot *shed* or *prioritize* under sustained pressure.

The existing `withGlobalBackupLock` (`src/backup.ts:88`) is the seed of the right
answer; this design generalizes it.

## 75.3 The mechanism — four principles

In rough priority order (earlier = bigger share of the failure class):

### P1 — Nothing heavy runs synchronously on the event loop

Non-negotiable, and most of the "catastrophic under load" risk. Every background
task must yield the loop:

- `spawnSync` → async `spawn` / `execFile` (git status, git fetch). **Phase 1.**
- CPU-heavy hashing (attachment manifest) and gzip/dump (snapshot, backup) → a worker
  thread, or at minimum chunked with `await`/`setImmediate` yields. **Phase 5.**

Once no background task can block the loop, request handling is always serviced *no
matter how slow the machine is*. A slow disk degrades to "the git chip updates a
second late," not "the app is dead."

### P2 — One process-wide, load-aware background scheduler

Generalize `withGlobalBackupLock` into a single scheduler that **all** non-request
background work submits jobs to (new module: `src/scheduler/backgroundScheduler.ts`).
Properties:

- **Bounded concurrency** — a small cap (1–2) of concurrent heavy jobs; the rest
  queue. No unbounded pile-up.
- **Coalescing** — if project X already has a pending/in-flight job of kind K, a
  second request is a no-op (or replaces the pending one). Dedupes the O(N) fan-out
  storm. (The 500 ms git cache + the 250 ms watcher debounce do a little of this
  per-project today; this centralizes and generalizes it.)
- **Fairness** — round-robin across projects so one churning repo can't starve the
  other tabs' work.
- **Priority** — request handling > git status > markdown sync > snapshot safety >
  backups > GC.
- **Backpressure** (the key to "heavy load for a long time") — the scheduler reads
  the **event-loop lag** signal Hot Sheet *already measures* (the heartbeat in
  `src/diagnostics/freezeLogger.ts:227`). When lag is high, it defers/skips
  low-priority jobs. A 5-min backup can wait five more minutes; a tab switch cannot.
  The system *sheds* background work to protect interactivity instead of trying to do
  everything and falling over.

### P3 — Foreground-scoped refresh (the scaling lever for many tabs)

You don't need live git status for 9 repos you aren't looking at. The client knows
which project tab is visible; have it tell the server (a `foregroundProject` hint on
the poll, or a lightweight `POST /api/active-project`). Then:

- The **active** project gets live, watcher-driven refresh.
- **Background** projects get coarse / lazy / paused refresh (e.g. refresh on
  tab-activation, not on every `.git` mtime nudge).

This collapses the O(N) fan-out (`src/routes/notify.ts` waking every tab on any one
project's change) toward O(1) regardless of how many tabs are open — exactly the
scaling property the load-resilience goal demands.

### P4 — Wake-aware re-staggering (kills the thundering herd)

There is currently **no** sleep/wake handling anywhere. The same `hrtime` gap the
heartbeat already computes is a perfect suspend detector: a gap ≫ the tick interval
means the machine slept. On detecting it, the scheduler enters a brief **drain mode**:
re-stagger all overdue periodic work with jitter rather than letting N projects'
intervals fire simultaneously. (Backups got per-project startup jitter in HS-8352;
this generalizes that idea to *every* periodic task and binds it to the wake event.)

## 75.4 What stays, what changes

- **Stays:** one process per machine; per-project state (DBs, secrets, dirty flags,
  fs.watch handles — `fs.watch` is OS-level and cheap); the typed-API layer; the
  `/api/poll` long-poll transport.
- **Changes:** every synchronous/CPU-heavy background path moves off-loop; the N
  independent timer sets + uncoordinated execution are replaced by submission to one
  central scheduler with concurrency caps, fairness, priority, and lag-driven
  backpressure; refresh becomes foreground-scoped; periodic work re-staggers on wake.

## 75.5 A self-inflicted amplifier to fix along the way

`git status` can write to `.git/index` to refresh its stat cache, which trips the
`.git/index` watcher → `/api/poll` wake → another git status — the feedback loop
`src/git/watcher.ts:29` already filters `.git/index.lock` to partly avoid. Phase 1
should also pass flags that avoid index rewrites where possible (the read already sets
`GIT_OPTIONAL_LOCKS=0`; verify it doesn't self-trigger the watcher) so the async git
reads don't manufacture their own change events.

## 75.6 Phases & tickets (all tagged `load-resilience`)

Incident bug: HS-8721. Epic: HS-8722. Phases: HS-8723 (1) / HS-8724 (2) /
HS-8725 (3) / HS-8726 (4) / HS-8727 (5).

1. **Phase 1 (HS-8723) — Off-loop git status (fixes the reported freeze).** Convert
   `getGitStatus` / `getGitStatusFiles` / `runGitFetch` and the `getCachedGitStatus`
   cache to async (`spawn`/`execFile` instead of `spawnSync`); dedupe concurrent
   in-flight reads per project; make `GET /api/git/status` + `POST /api/git/fetch`
   await. Removes the only synchronous-blocking background path. Contained to
   `src/git/*` + `src/routes/git.ts` + tests.
2. **Phase 2 (HS-8724) — Central background-work scheduler. ✅ shipped.** New
   `src/scheduler/backgroundScheduler.ts` generalizing `withGlobalBackupLock`:
   bounded concurrency (default 2), per-`key` coalescing, round-robin fairness,
   priority tiers, `exclusiveGroup` mutual-exclusion (≤1 per group — backups keep
   their HS-8229 serialization), and event-loop-lag backpressure (`deferUnderLag`,
   sourced from `freezeLogger.getRecentEventLoopLagMs()`). `submit()` is awaitable
   so durability callers (manual backup, shutdown snapshot flush) can wait.
   **Option A migration (user-chosen):** backups (`exclusiveGroup:'backup'`) and
   snapshots run with `deferUnderLag:false` (coordinated by the shared budget but
   never held back — durability first); git-refresh pre-warm, markdown sync, and
   attachment GC run with `deferUnderLag:true`. The markdown `flushPendingSyncs`
   path stays direct (immediate). The git-refresh pre-warm is process-wide for now;
   Phase 3 scopes it to the foreground project.
3. **Phase 3 (HS-8725) — Foreground-scoped refresh. ✅ shipped.** New
   `src/activeProjects.ts` tracks which projects a client is actively viewing,
   signalled implicitly by the `/api/poll` long-poll (always scoped to the shown
   project) + the `/api/git/status` chip fetch — no new endpoint or client change
   needed. The git watcher's debounced fire still busts the cache + bumps the
   version for EVERY project (so a tab-switch refetches fresh), but the **proactive**
   work — waking the poll (`notify.ts` fan-out) and the Phase-2 git pre-warm — now
   runs only for the actively-viewed project. A background project refreshes lazily
   on switch via the chip's on-demand `getCachedGitStatus`. Recency-based (90 s TTL)
   so it's the natural union of every connected client's view (forward-compatible
   with §46 multi-client). Safe default: until any project reports, all are treated
   active (no regression).
4. **Phase 4 (HS-8726) — Wake-aware re-staggering. ✅ shipped.** `freezeLogger`
   classifies a heartbeat gap ≥ `WAKE_GAP_THRESHOLD_MS` (10 s) as a suspend/resume
   rather than an event-loop block: it logs a `server-wake` entry (instead of a
   misleading multi-hour "event-loop blocked"), resets the backpressure lag reading
   so the sleep gap doesn't poison it, and fires `onServerWake` listeners. `cli.ts`
   wires that to `backgroundScheduler.noteWake()`, which opens a post-wake stagger
   window (default 15 s): during it the scheduler caps effective concurrency at 1 and
   spaces job starts by `wakeStaggerStepMs` (250 ms), so N projects' overdue
   backup/snapshot/GC timers drain gently into a just-woken machine instead of
   bursting. Outside the window behavior is unchanged.
5. **Phase 5 (HS-8727) — Heavy hashing/gzip off-loop. ✅ shipped (chunk-with-yields path).**
   The attachment-manifest BUILD + rebuild already yield between files (streamed
   SHA-256, HS-8359); HS-8727 closed the matching gap on the GC delete sweep —
   `runAttachmentGc` is now async (`fsp.readdir`/`stat`/`rm` on the libuv threadpool)
   and yields every 500 blobs, so sweeping thousands of orphans can't block the loop.
   The snapshot/backup dump+gzip is an opaque `db.dumpDataDir('gzip')` PGLite/WASM
   call (~150–400 ms in the incident logs, never a heartbeat blocker) — it can't be
   chunked and can't be offloaded without the DB living in the worker.
   **HS-8728 (2026-06-04) — attachment-hashing worker shipped:** `src/hashWorker.ts`
   moves SHA-256 hashing fully off the main thread via a single long-lived
   `worker_threads` worker (spawned with `{ eval: true }` from an inline source
   string, so there's no separate bundler entry / path-resolution concern), with an
   in-process streaming fallback when no worker is available + a crash-counter that
   gives up on the worker after 3 failures. `attachmentBackup.ts::hashFile`
   delegates to it; terminated in `gracefulShutdown`. The **PGLite dump/gzip** half
   stays deferred under HS-8728 (needs the DB inside the worker — a larger change;
   not a heartbeat blocker in practice).

### 75.6.1 Follow-up — startup project-restore on the scheduler (2026-06-04)

A post-epic regression surfaced the one heavy fan-out the epic never migrated:
**startup restoration of the previous session's projects**. `restorePreviousProjects`
(`src/cli.ts`) registered each saved project with a bare serial `await` loop, and
each `registerProject` now does substantial partly-synchronous work (PGLite WASM
init + the §73 snapshot integrity probe + per-project backup/snapshot schedulers +
git watchers + eager terminals). A user with 9 saved projects saw every launch hang
for ~3 minutes (`post-startup: restoring previous projects` measured at 171 s in the
startup log) — the server was already listening, but the serial blast saturated the
event loop so the UI never became reachable. Same failure class as §75.1, on the
startup path.

Fix: the restore loop now submits each project's registration to the **P2 background
scheduler** (`PRIORITY.PROJECT_RESTORE`, highest tier so tabs lead, `deferUnderLag`
on so it yields to the loop). Concurrency is bounded (cap 2) and lag-gated, so the
fan-out can't saturate the loop — the server stays responsive (verified: HTTP 200 in
~9 ms during a 3-project restore) while tabs fill in progressively (`notifyChange`
per project as it lands). The surviving list is rebuilt in original order, since
scheduler jobs complete out of order. Tests: `src/cli.restorePreviousProjects.test.ts`.

## 75.7 Honest limitations

This does not make a single overloaded machine *fast* — it makes Hot Sheet *stay
responsive while it's slow*, by doing less background work and doing it off-loop.
Phases 1 and 3 alone would have prevented the reported incident; Phases 2 and 4 are
what make it scale to 20+ tabs and survive sustained load gracefully; Phase 5 removes
the last loop-blocking paths at extreme data sizes.

## 75.8 Backstop — the event-loop watchdog (2026-06-19)

The principles above keep heavy work off the loop, but a *bug* can still wedge it
(e.g. the HS-8874 row-by-row telemetry migration spun the loop at 100% CPU for
minutes during startup — a single unbounded synchronous-ish pass the scheduler's
backpressure couldn't preempt mid-job). A wedged loop can't run its SIGTERM
handler, so the process survived holding the HTTP port + every project lock, and
the next launch FATAL-exited on the live lock — a permanent lockout requiring a
manual kill.

`src/diagnostics/watchdog.ts` is the backstop. The `freezeLogger` heartbeat
(§75 P2 lag signal) runs on the main loop, so it can only *log* a block after the
loop frees up — useless for a loop that never frees. The watchdog runs its checker
on a **worker thread**: the main thread bumps a `SharedArrayBuffer` heartbeat each
tick, and the worker `process.kill(pid, 'SIGKILL')`s the shared process once the
heartbeat is stale past a timeout (default 60 s). That converts a permanent hang
into a clean crash the lock layer reclaims as stale + a relaunch recovers from. A
large checker self-gap is treated as a system suspend/resume (wake), never a wedge
(same `WAKE_GAP_THRESHOLD_MS` guard as the heartbeat), so a laptop sleep can't
false-fire. Armed first in `cli.ts::main` (covers startup); disarmed at the start
of `gracefulShutdown` so a legitimately-slow snapshot/close isn't mistaken for a
wedge (a shutdown that genuinely wedges is covered by the Tauri-side SIGKILL
escalation). Tunable via `HOTSHEET_WATCHDOG_TIMEOUT_MS`; disable with
`HOTSHEET_DISABLE_WATCHDOG=1`.
