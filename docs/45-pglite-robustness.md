# 45. PGLite Robustness — Cleaner Shutdown (Design)

HS-7902. Audit + design for making the PGLite cluster more robust against the failure classes that drove the HS-7888..7894 incident chain.

> **Status:** §45.3 graceful-close pipeline **shipped** (HS-7931). §45.5 fsync gap **mitigated by wrapping our application boundaries** with explicit `fs.fsyncSync` (HS-7935) — upstream PGLite still no-ops `fsync` per the HS-7932 spike. §45.6 checkpoint-timeout benchmark **infeasible** until PGLite exposes a config-passing API (HS-7933 spike + HS-7936 upstream ask). §45.9 e2e harness **shipped** (HS-7934) covering 3 of 4 scenarios; the double-signal escalation case is covered by a focused unit test (HS-7939 follow-up for the e2e variant).
>
> **HS-8040 (2026-04-30) — kill button-launched shell commands.** The pipeline gained a `killShellCommands()` step between `closeHttpServer()` and `destroyTerminals()` that lazy-imports `routes/shell.ts::killAllRunningShellCommands()`, sends SIGTERM to every entry in the module-private `runningProcesses` map (also adding each id to `killedProcesses` so the close-handler logs "Canceled" instead of "Killed by SIGTERM"), waits a 1 s grace period for them to exit cleanly, then SIGKILLs anything still alive. Pre-fix shell-target custom-command buttons (`target: 'shell'` in `settings.json::custom_commands`) outlived Hot Sheet's exit because no shutdown path ever walked the running-processes map — a long-running `npm run dev` fired from a button kept running in the background indefinitely. The grace-period bound means the pipeline never blocks more than ~1 s on misbehaving children; 5 new unit tests in `src/routes/shell.test.ts` (no-ops on empty map / SIGTERM count / Canceled summary / SIGKILL escalation / unblockable-child timeout bound) plus an updated ordering test + a new error-resilience test in `src/lifecycle.test.ts` (35 / 35 green).
>
> **HS-8828 (2026-06-17) — per-step + overall shutdown timeouts.** The pipeline tolerated a step that *throws* (each step has its own try/catch) but NOT a step that *hangs* — a cleanup promise that never settles (a blocked PGLite CHECKPOINT, a PTY destroy waiting on a wedged child, an Announcer generator promise that never resolves) left `gracefulShutdown` pending forever. Because the SIGINT/SIGTERM handler (and `/api/shutdown`) `await gracefulShutdown()` BEFORE `process.exit(0)`, one hung step meant the Node process never exited — the reported symptom was that quitting Hot Sheet under `npm run tauri:dev` "never actually quits" (the Tauri window closes after its 300 ms SIGTERM grace, but the orphaned sidecar lives on holding the port + lockfile). Fix: every step now runs through `runStep()` under a per-step timeout (`STEP_TIMEOUT_MS = 3000`) so one hung step is abandoned and the rest of the pipeline still runs, and the whole pipeline runs under a hard wall-clock ceiling (`OVERALL_TIMEOUT_MS = 8000`) via `runWithOverallDeadline()` so a pathological cascade can never exceed the ceiling. On timeout we log and resolve — the caller's `process.exit(0)` tears down whatever is still pending, and the synchronous `process.on('exit')` handler in `cli.ts` remains the lockfile-removal safety net for steps the deadline skipped. Timeouts are test-overridable via `_setShutdownTimeoutsForTests()`; 2 new unit tests in `src/lifecycle.test.ts` (hung step → abandoned + rest runs; overall deadline pre-empts a step that outlasts its per-step budget) — 11 / 11 green.
>
> **HS-9028 (2026-06-25) — longer budgets for the heavy steps.** The flat 3 s/step was too tight for the steps that genuinely take a while — `closeHttpServer` (draining keep-alive sockets) and the DB work (`snapshotDatabases` + `closeDatabases`: CHECKPOINT + close + fsync, multiplied when several projects are handled in one step) — which were being cut off ("step … failed after 3000ms"). Now that the quit has clear per-step feedback (the `[lifecycle:progress]` markers → the §37 overlay), those three **heavy steps** get `HEAVY_STEP_TIMEOUT_MS = 90_000` each (via the pure, unit-tested `stepTimeoutFor(label)` selector); light steps keep `STEP_TIMEOUT_MS = 3000`; and `OVERALL_TIMEOUT_MS` was raised `8000 → 300_000` so the overall ceiling can't pre-empt a heavy step still within its own budget. The Tauri-side graces were raised in lockstep (`src-tauri/src/lib.rs`): the `confirm_quit` safety timer `12 s → 95 s` and the `RunEvent::Exit` TERM grace `10 s → 95 s` (one 90 s heavy step + buffer) so the desktop shell doesn't force-exit / SIGKILL a slow-but-legitimate drain mid-write. 3 new `stepTimeoutFor` unit tests.
>
> **HS-9114 (2026-06-28) — `closeHttpServer` no longer waits out its 90s budget.** HS-9028 gave `closeHttpServer` the 90 s heavy budget — but it turned out to consume the *whole* 90 s on **every** quit, even right after launch. Root cause: `server.close()` waits for all existing connections to drain, and right after launch the client always holds long-lived ones — an open **`/ws/sync`** WebSocket (docs/93), a 30 s **`/api/poll`** long-poll, and a **terminal WS** per configured terminal — none of which are "idle", so `closeIdleConnections()` can't free them. The pre-existing wsSync close-on-`'close'` handler was inert (the `'close'` event only fires *after* `close()` has drained, the very thing it was meant to unblock). Fix: `closeHttpServer` now **proactively** releases those connections at the top of the step — `closeAllSyncSockets()` (`routes/wsSync.ts`), `closeAllTerminalSockets()` (`terminals/websocket.ts`), `wakeAllWaitersForShutdown()` (`routes/notify.ts`) — then races `server.close()` against a short `HTTP_CLOSE_GRACE_MS = 1200` grace, after which `server.closeAllConnections()` force-closes any straggler so the step can't hang. `closeHttpServer` was dropped from `HEAVY_STEPS` (it's self-bounding now); only `snapshotDatabases` / `closeDatabases` keep the 90 s budget. Tests: 2 new `lifecycle.test.ts` cases (proactive release fires; a never-draining `close()` is unblocked by the grace backstop) + a `lifecycle.e2e.test.ts` case (shutdown stays < 15 s with an open `/ws/sync` WS + in-flight long-poll, vs the old ~90 s).
>
> **HS-8828 — the actual reported symptom was a Tauri 2.11 ACL regression, NOT a shutdown bug.** The reported symptom ("Quit Anyway" leaves the window open, app fully functional) was finally traced to the console error `confirm_quit not allowed. Plugin not found`. The 2026-06-16 Dependabot bump (tauri 2.10.3→2.11.2 / wry 0.54.3→0.55.1) stopped treating Hot Sheet's remote-origin WebView (the frontend is served by the Node server over `http://localhost`, and the window navigates there) as a trusted "app window", so the app's own `#[tauri::command]`s — allowed there by default pre-2.11 — were rejected by the ACL. The same regression broke Quick Look (HS-8826: `quicklook` rejected → broken-image fallback). Fix: register the app commands in `src-tauri/build.rs` via `tauri_build::AppManifest::new().commands([...])` (generates `allow-<cmd>` permissions) and grant them to the `http://localhost:*` origin in `src-tauri/capabilities/remote-localhost.json` (mirrored in `default.json`). See `docs/tauri-architecture.md`. The two notes below were earlier, WRONG diagnoses of this same ticket — kept for the record because each fixed a real *latent* bug (a hang-tolerant pipeline; a dev-spawn that orphaned the server *if* the window ever did close), just not the reported symptom.
>
> **HS-8828 earlier diagnosis #2 (latent fix, not the symptom) — the dev quit never reached the Node handler.** The timeout work above fixed a real latent hang, but this theory was that under `npm run tauri:dev` the graceful pipeline **was never invoked**. The Tauri dev block spawned the server as `npx tsx … src/cli.ts` and stored `child.id()` (the `npm exec` wrapper PID) in `SidecarPid`; the real `cli.ts` process — the one carrying the SIGINT/SIGTERM handler — was its **grandchild** (npx → tsx CLI → node cli.ts). `RunEvent::Exit`'s `kill(pid)` therefore only killed the wrapper, and `kill(-pid)` targeted a non-existent process group (the child shared the `npm run tauri:dev` group, so it was never a group leader) → ESRCH no-op. The server orphaned, kept the port + lockfile, and the app "never actually quit." Fix (`src-tauri/src/lib.rs`): the dev block now launches `node --import tsx src/cli.ts …` (single-process, via `build_dev_server_args` + `TSX_TSCONFIG_PATH`), so `child.id()` **is** the server and the quit-time SIGTERM lands on its handler — with no process-group change, so terminal Ctrl+C still delivers SIGINT to the server directly. The production sidecar path was always correct (the sidecar binary is the server). Added shutdown/quit logging on both sides: a Rust `shutdown_log()` (stderr + `~/.hotsheet/shutdown.log`) tracing `CloseRequested` → `confirm_quit` → `ExitRequested` → `Exit` (with the kill targets + return codes), per-step start/done timing in `lifecycle.ts::runStep`, and start/finish timing in `cli.ts`'s signal handler. `cli.ts` also guards `process.stdout`/`stderr` against EPIPE so a graceful shutdown that's still logging when the Tauri parent's pipe closes (~300 ms after SIGTERM) finishes instead of crashing mid-checkpoint. 2 new Rust unit tests (`dev_server_args_tests`) pin the `node --import tsx` launch form against a regression to the wrapper.
>
> The design below is preserved verbatim.

## 45.1 Why this ticket exists

The HS-7891 incident retro identified two interacting root causes:

1. **No CHECKPOINT before `dumpDataDir()`** — fixed in HS-7891 for the backup writer specifically. But the *live* cluster has the same exposure: WAL pages that haven't been checkpointed at the moment of process exit can leave a half-applied state on disk.
2. **Stale `postmaster.pid`** — fixed reactively in HS-7888 by deleting the file + retrying open. But the file is stale in the first place because we never gave PGLite a clean shutdown.

Today every shutdown path is "kill PTYs, `process.exit(0)`". The DB instance is never closed. PGLite has its own internal `await db.close()` which writes a final CHECKPOINT, releases the WAL, and removes `postmaster.pid` — but we never call it.

The HS-7888 mitigation papers over the symptom; HS-7902 asks if we can make the symptom less common.

## 45.2 Audit of every shutdown path

Surveyed in `src/cli.ts` + `src/server.ts`:

| # | Path | Trigger | Calls `db.close()`? | Notes |
|---|------|---------|---------------------|-------|
| 1 | `/api/shutdown` | `hotsheet --close`, stale-instance auto-cleanup, Tauri quit-confirm | ❌ | Kills PTYs, then `setTimeout(process.exit, 500)` — never closes DB |
| 2 | `process.on('SIGINT')` | Ctrl-C in CLI mode | ❌ | Calls `cleanupInstance` → `destroyAllTerminals` + `removeInstanceFile`, then `process.exit(0)` |
| 3 | `process.on('SIGTERM')` | Sent by `kill`, OS shutdown | ❌ | Same as SIGINT |
| 4 | `process.on('exit')` | Synchronous; runs at the end of every other path | ❌ | Synchronous handler — can't `await db.close()` even if we wanted to |
| 5 | Tauri `WindowEvent::CloseRequested` | Cmd-Q, traffic-light close | ❌ | Routes through §37 quit-confirm flow → `confirm_quit` Tauri cmd → `/api/shutdown` (#1 above) |
| 6 | Tauri sidecar process death | Sidecar parent crashes | ❌ | OS-level termination; nothing we can do beyond `postmaster.pid` retry |
| 7 | `recoverFromOpenFailure` rename + recreate | DB open failed at startup | ✅ (sort of) | Original DB is renamed; the *new* empty DB is opened and used. Indirectly clean because the bad DB never gets closed |

Of those, paths 1–5 are the ones that touch a healthy live DB. None of them gracefully close PGLite. Path 6 is unrecoverable by definition.

## 45.3 Design: graceful close pipeline

A single async helper `gracefulShutdown(reason: string): Promise<void>` is shared by every shutdown path:

```ts
// src/lifecycle.ts (new)
export async function gracefulShutdown(reason: string): Promise<void> {
  // 1. Stop accepting new HTTP requests so we don't race a CHECKPOINT against
  //    in-flight writes.
  await closeHttpServer();

  // 2. Kill PTYs (existing destroyAllTerminals path).
  try { destroyAllTerminals(); } catch { /* already torn down */ }

  // 3. Issue an explicit CHECKPOINT and close every cached PGLite instance.
  //    Mirrors what `db.close()` does internally but explicit so failures
  //    surface in the log.
  await closeAllDatabases();   // wraps `getCachedInstances()` + `await db.close()` per entry

  // 4. Remove the instance lockfile (cleanupInstance today).
  removeInstanceFile();
}
```

Wired into:
- **#1 `/api/shutdown`** — replace `setTimeout(process.exit, 500)` with `await gracefulShutdown('http')` then `process.exit(0)`. The 500 ms grace is no longer needed because the helper awaits everything explicitly.
- **#2/#3 SIGINT / SIGTERM** — Node lets the handler return a Promise; signal handlers register `void gracefulShutdown(signal).then(() => process.exit(0))`. Caveat: a second signal during the await must `process.exit(1)` immediately so a hung close can't trap the user.
- **#4 `process.on('exit')`** — kept as a synchronous "best-effort" cleanup. It can only call sync APIs; it stays as the lockfile-removal safety net for paths the async helper didn't get to.
- **#5 Tauri close** — already routes through `/api/shutdown`, picks up the fix automatically.

**No new "graceful=false" force path.** If the user wants to nuke the instance, they can `kill -9` — at that point the existing HS-7888 stale-`postmaster.pid` mitigation catches it on next launch. We don't need to add a force-close inside Hot Sheet.

## 45.4 Periodic CHECKPOINT for long-idle clusters

The backup writer issues `CHECKPOINT` before every dump (HS-7891). The *live* cluster between backups still accumulates WAL pages that could be lost if the process crashes (path #6). Two options:

**Option A: rely on the existing 5-minute backup tier.** `createBackup` already runs `CHECKPOINT` first. As long as the 5-minute tier is firing, the worst-case data loss on crash is the writes since the last 5-min backup — which is already the user's exposure window. **Recommended.** No new code.

**Option B: add a standalone CHECKPOINT timer** (e.g. every 60s). Independent of backups. **Rejected** — would write to disk every minute on machines that don't actually have writes, and the 5-min tier already gives us the same property in the realistic case.

The recommendation is therefore: **keep the existing 5-min CHECKPOINT cadence, document it as the live-cluster checkpoint guarantee in §7.7**, and don't add a new timer.

## 45.5 `fsync = on` audit

PGLite ships with PostgreSQL's `fsync = on` default. The risk is that the WASM ↔ host-fs bridge collapses `fsyncSync` into a no-op when running atop certain virtual filesystems. Worth verifying:

1. Drop a test that writes a row, awaits a CHECKPOINT, simulates a crash, re-opens — assert the row is present.
2. Confirm that PGLite's `dumpDataDir`'s underlying syscall path actually calls `fsync` on the host filesystem. Verifiable by `strace`-ing a Hot Sheet integration test on Linux CI. (Out of scope for this design — punt to the implementation ticket.)

If `fsync` turns out to be a no-op, the answer is to wrap the host-fs bridge so writes flush explicitly. Tracked separately under HS-7932.

## 45.6 WAL retention + checkpoint sizing

PGLite uses PostgreSQL's defaults: `checkpoint_timeout = 5min`, `max_wal_size = 1GB`, `min_wal_size = 80MB`. For Hot Sheet's workload (small writes, bursty during ticket batch ops, otherwise mostly idle) those are conservative. Two tweaks worth considering in the implementation ticket — *NOT* now without a benchmark to point at:

- Lower `max_wal_size` to 256 MB so WAL doesn't grow unboundedly between checkpoints. Defensive against pathological workloads (e.g. the user mass-importing a backup).
- Lower `checkpoint_timeout` to 60s. More frequent CHECKPOINTs = smaller crash-recovery window, at the cost of more disk writes.

Both are tunable via `db.exec("ALTER SYSTEM SET checkpoint_timeout = '60s'")` after open. The implementation ticket should benchmark on a representative dataset before committing.

## 45.7 Open Hot Sheet windows on the same project

Two Hot Sheet instances on the same `dataDir` is forbidden by the existing `hotsheet.lock` mechanism. PGLite itself rejects a second open of the same DB cluster, so this is already covered. No design work needed; just call out for the implementation ticket that the lockfile + PGLite's own exclusivity together make double-open impossible.

## 45.8 Recovery-marker integration

When `recoverFromOpenFailure` falls through to the rename path (HS-7888 last-resort), it writes `.db-recovery-marker.json` (HS-7899) so the launch-time banner can prompt the user. The graceful-close pipeline above shouldn't ever land in that path — but if it does, the marker correctly captures the underlying error. No changes required.

## 45.9 Testing strategy

Each piece of the design is testable in isolation:

1. **Graceful close round-trip** — start the server, write some rows, POST `/api/shutdown`, re-start, assert row count. Today this passes only because PGLite happens to flush via `process.exit` write-back; the new test should also assert no `postmaster.pid` is present after shutdown (proves `db.close()` ran).
2. **Signal-handler awaitability** — fire SIGINT to a child Hot Sheet process; assert the cleanup completes within (say) 3 s and that the second SIGINT escalates to `process.exit(1)`.
3. **Concurrent shutdown calls** — `/api/shutdown` while SIGINT is in flight; assert the helper is idempotent.
4. **fsync proof** — already discussed in §45.5.

## 45.10 Implementation follow-ups

1. **HS-7931** — implement the §45.3 `gracefulShutdown` helper + wire all four shutdown paths. Includes the test plan from §45.9.
2. **HS-7932** — verify PGLite's `fsync` round-trips through to the host filesystem on macOS / Linux / Windows. Punt to a code-only spike, no design changes expected.
3. **HS-7933** — benchmark `checkpoint_timeout = 60s` + `max_wal_size = 256 MB` against a representative Hot Sheet dataset and commit if the disk-write delta is within budget.

Each of these is intentionally small + independently shippable.

## 45.11 Cross-references

- §7.7 — backup hardening from the same incident chain (CHECKPOINT before dump, startup catch-up, open-failure recovery).
- §7.9 — launch-time recovery banner (HS-7899) — orthogonal but kicks in if the graceful-close pipeline still lands in the rename path somehow.
- §41 — JSON co-save — orthogonal escape hatch.
- §42 — Database Repair — manual recovery for cases where the live cluster ends up unrecoverable despite all the prevention work in this doc.
- §44 — WASM `pg_resetwal` spike — automation of §42 if we ever ship our own resetwal.
