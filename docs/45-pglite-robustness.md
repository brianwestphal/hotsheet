# 45. PGLite Robustness — Cleaner Shutdown (Design)

HS-7902. Audit + design for making the PGLite cluster more robust against the failure classes that drove the HS-7888..7894 incident chain.

> **Status:** §45.3 graceful-close pipeline **shipped** (HS-7931). §45.5 fsync gap **mitigated by wrapping our application boundaries** with explicit `fs.fsyncSync` (HS-7935) — upstream PGLite still no-ops `fsync` per the HS-7932 spike. §45.6 checkpoint-timeout benchmark **infeasible** until PGLite exposes a config-passing API (HS-7933 spike + HS-7936 upstream ask). §45.9 e2e harness **shipped** (HS-7934) covering 3 of 4 scenarios; the double-signal escalation case is covered by a focused unit test (HS-7939 follow-up for the e2e variant). The design below is preserved verbatim.

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
