# 72. Memory-Primary Snapshot Persistence (Design Spike)

HS-8575. Investigation into the user's standing ask: *"DB gets corrupted fairly
regularly, even when the app appears to shut down cleanly. Is there a way to make
it more atomic — updated in-memory in real time and only persisted to disk
atomically?"*

> **Status: Design only.** No code shipped under this doc. The recommendation is
> to prototype the memory-primary mode behind a setting (Phase 1) and measure
> before committing. Phased implementation follow-ups are filed but **not** Up
> Next — the user decides whether to prioritize. The current file-backed mode +
> its mitigation stack (§7, §41, §42, §45) stays the default until a snapshot
> mode is proven on a representative dataset.

## 72.1 Why the corruption keeps happening

Today Hot Sheet opens PGLite in **file-backed mode** (`new PGlite('<dataDir>/db')`
in `src/db/connection.ts`). That keeps a full PostgreSQL on-disk cluster live in
`<dataDir>/db/` — many interdependent files: `base/`, `global/`, `pg_wal/`,
`pg_control`, `postmaster.pid`, etc. The cluster is corruption-prone precisely
*because it is many files that must stay mutually consistent on disk*:

- `pg_control` can point at a WAL position that hasn't been flushed into the data
  files (the exact failure HS-7891 hit: "could not locate a valid checkpoint
  record").
- A CHECKPOINT can be half-applied across data files when the process exits.
- The WASM ↔ host-fs bridge **silently no-ops `fsync`** (HS-7932 spike), so even a
  clean CHECKPOINT lands in the host kernel page cache, not physical disk —
  power-loss / kernel-panic inside the OS's ~30 s dirty-page flush window loses it.
- A stale `postmaster.pid` from an unclean exit blocks the next open (HS-7888).

Every mitigation we've shipped is a **defensive patch around an inherently fragile
multi-file format**:

| Mitigation | Ticket | What it does |
|---|---|---|
| Graceful close pipeline | HS-7931 (§45.3) | `db.close()` → internal CHECKPOINT before exit |
| Explicit fsync wrap | HS-7935 (§45.5) | walk `<dataDir>/db/` and `fsync` every file ourselves |
| Stale-pid removal + retry | HS-7888 | delete `postmaster.pid`, reopen |
| Preserve-aside + recreate | HS-7889 (`recoverFromOpenFailure`) | rename corrupt cluster, start fresh |
| Recovery marker + banner | HS-7899 | prompt user to restore instead of silent-empty |
| Backup tiers + JSON co-save | §7, §41 | out-of-band tarball / JSON copies |
| Database Repair UI | §42 | `pg_resetwal`, find-a-working-backup |

These reduce the *frequency* and *blast radius* but cannot eliminate the class:
there is always an irreducible window where the on-disk cluster is mid-update
across multiple files, and a crash inside that window leaves them inconsistent.
The user's report — "corrupted fairly regularly, even when it appears to shut
down cleanly" — is the residue this approach can't remove.

## 72.2 The proposed architecture (memory-primary + atomic snapshot)

The user's intuition is correct and maps onto a first-class PGLite usage pattern.

1. **Run the live cluster in memory.** Open PGLite with no data dir
   (`new PGlite()` / `new PGlite('memory://')`). Postgres still runs its full WAL
   + checkpoint machinery, but entirely inside the WASM MEMFS — **nothing touches
   the host disk during operation.** No `pg_wal/` on disk, no `pg_control` on disk,
   no `postmaster.pid` on disk.
2. **Seed at boot from the last-good snapshot.** `new PGlite('memory://', {
   loadDataDir: blob })` where `blob` is the canonical snapshot tarball read from
   disk. (Empty/first-run → start blank, run `initSchema`.)
3. **Persist by snapshotting the whole cluster atomically.**
   `CHECKPOINT` → `db.dumpDataDir('gzip')` → one tarball → write it to disk
   **atomically**: `tmp` + `fsync` + `rename` over the canonical path + fsync the
   directory. POSIX `rename` is atomic, so a crash mid-write leaves either the
   complete previous snapshot or the complete new one at the canonical path —
   **never a partial or internally-inconsistent artifact.**

The corruption class from §72.1 becomes **structurally impossible**: there is no
multi-file on-disk cluster to leave half-updated, and the one on-disk artifact is
only ever swapped atomically. The HS-7888 stale-pid class disappears entirely
(no pid file on disk).

### We already ship every primitive this needs

This is not a from-scratch build. The dump/load/atomic-write machinery is in the
tree today and is **proven in production** — the 2026-04-27 incident restored
639/639 tickets through exactly this path:

- `db.dumpDataDir('gzip')` — `src/backup.ts:185` (with the HS-7891 CHECKPOINT-first
  guard at `:167`).
- `new PGlite(dir, { loadDataDir: blob })` — `src/backup.ts:407`, `src/db/repair.ts:49`,
  `src/routes/db.ts` find-a-working-backup loop.
- Atomic `tmp` + `handle.sync()` + `rename` write — `writeJsonExportAtomically`
  in `src/dbJsonExport.ts:71` (reuse verbatim for the tarball; it already runs the
  fsync on libuv's threadpool per HS-8178).

The proposal **promotes the backup path from a sidecar to the primary store.** The
fragile part (the live file-backed cluster) is the part we delete.

### Snapshot triggers

- **Debounced after writes** — a post-write hook schedules a snapshot ~1–2 s after
  the last mutation, coalescing bursts (batch ops, plugin sync) into one dump.
- **On graceful shutdown** — `gracefulShutdown` (§45.3) already has the hook point
  (`closeDatabases`); swap "close the file cluster" for "final snapshot". Clean
  shutdown → **zero** data loss.
- **Periodic safety timer** — a low-frequency floor (e.g. every 60–120 s while
  dirty) bounds loss on a hard crash even if the debounce never fired.

## 72.3 Trade-offs (the honest list)

1. **Crash data-loss window.** Anything written since the last snapshot is lost on
   a hard crash (SIGKILL, power loss, panic). Clean shutdown loses nothing. A 1–2 s
   debounce bounds the realistic window to seconds. **This is strictly better than
   today**, whose worst case is the 5-min backup tier *and* whose failure mode is
   silent corruption of *everything* rather than the loss of the last few seconds.
2. **Memory footprint.** The whole DB lives in RAM. Ticketing data is tiny
   (hundreds of tickets = low single-digit MB). The real variable is the **§67
   telemetry tables** (`otel_metrics` / `otel_events` / `otel_spans`), which are
   high-volume. With 30-day retention they're still modest, but this must be
   *measured per project* — and multiplied by the number of registered projects,
   since each gets its own in-memory instance. **Mitigation if it's too big:** keep
   telemetry in a *separate, file-backed, disposable* DB (corruption of telemetry is
   acceptable — it's analytics, not user data) and run only the ticket tables
   memory-primary. This split also fixes trade-off #4.
3. **Snapshot latency.** `dumpDataDir` serializes the whole cluster. Sub-100 ms for
   a small DB; potentially 100s of ms once telemetry is large. Already runs async on
   the threadpool today (HS-8351), and the debounce keeps it off the keystroke path
   — but it grows with data, so **measure** (and see #2's split).
4. **Write amplification.** Every snapshot rewrites the entire tarball. Fine for
   bursty ticket edits (debounce coalesces). **Telemetry ingestion is continuous
   and high-volume** — snapshotting the whole cluster on every telemetry write would
   thrash. This is the strongest argument for the §72.3-#2 telemetry split.
5. **No host-side WAL means no PITR.** We give up Postgres's own crash recovery /
   point-in-time replay (which we don't use anyway) in exchange for atomicity. The
   snapshot tarball *is* the recovery point. Acceptable.
6. **Concurrent access.** In-memory means the DB lives only in the server process.
   That's already true today (one server per `dataDir`, gated by `hotsheet.lock` +
   PGLite's own single-open exclusivity, §45.7). The §46 service/client decoupling
   already assumes one service owns the data. **No regression**, and snapshot mode
   actually simplifies §46 (the on-disk artifact is a single file to ship/replicate).

## 72.4 Interaction with the existing backup + repair stack

- **Backups (§7) get simpler.** A backup becomes "copy the canonical snapshot
  tarball into the tier directory" — no live-cluster CHECKPOINT race, no fsync walk
  of a multi-file dir. The §41 JSON co-save and §43 attachment store are unchanged.
- **Database Repair (§42) shrinks.** The `pg_resetwal` path exists for corrupt
  *file clusters*; a snapshot tarball either loads or it doesn't, and "find a working
  backup" already iterates tarballs. The §44 WASM `pg_resetwal` spike can stay
  deferred indefinitely.
- **Recovery marker (§45.8 / HS-7899)** still applies: if the canonical snapshot
  fails to `loadDataDir`, fall back to the newest backup tarball that does, and write
  the marker so the user is told.

## 72.5 Recommendation

**Pursue it — phased, behind a setting, measure first.** This is the
highest-leverage robustness change available: it converts corruption from "regular,
occasionally total" to "structurally impossible," and it reuses machinery we already
trust. The only genuine risk is the telemetry memory/write-amplification axis
(§72.3 #2/#4), which the prototype must measure before any default flip — and which
the telemetry-DB split neutralizes if the numbers are bad.

### Phased follow-ups (filed, not Up Next)

- **Phase 1 — prototype + benchmark.** Add `db_persistence_mode: 'file' | 'snapshot'`
  (default `'file'`). Implement the memory-primary open + atomic snapshot writer
  reusing `dumpDataDir` / `loadDataDir` / `writeJsonExportAtomically`. Benchmark RAM
  + snapshot latency on a representative dataset **including a realistically large
  telemetry set**, single- and multi-project.
- **Phase 2 — snapshot triggers.** Debounced post-write hook + `gracefulShutdown`
  final snapshot + periodic safety timer. Measure the real crash-loss window with a
  SIGKILL test harness.
- **Phase 3 — telemetry split decision.** Based on Phase 1 numbers, decide whether
  telemetry tables move to a separate file-backed disposable DB so the memory-primary
  store holds only durable user data.
- **Phase 4 — migration + cutover.** One-time import of an existing `<dataDir>/db/`
  cluster into the first snapshot; rewire the backup tiers to copy the canonical
  snapshot; default-flip gated on Phase 1/2 results.

## 72.6 What PGLite actually supports, and the RAM question (HS-8575 follow-up)

The user's follow-up: *"fully in-memory might use too much valuable RAM — does
PGLite support journaling or some other approach?"* Audited against the installed
**PGLite 0.3.16** type defs + bundle (`node_modules/@electric-sql/pglite/dist`).

### Key clarification: our current mode is *already* the low-RAM one

`NodeFS extends EmscriptenBuiltinFilesystem` (`dist/fs/nodefs.d.ts`) — i.e. our
`new PGlite('<dataDir>/db')` uses Emscripten's **NODEFS, which writes through to the
real host files**. Postgres pages data in/out of those files on demand; only
`shared_buffers` worth of pages live in WASM memory. So today's file-backed mode does
**not** hold the whole DB in RAM — which is exactly why §72's full `memoryfs` proposal
would *increase* RAM (the whole PGDATA moves into WASM memory). The user's instinct is
correct, and it reframes the choice: today = low-RAM + corruption-prone; full-memory =
high-RAM + corruption-proof. The interesting designs live in between.

### The four PGLite filesystem backends (`FsType`)

| Backend | Where it runs | RAM | Durability model |
|---|---|---|---|
| `nodefs` (**us**) | Node | **Low** (pages to disk) | write-through to real files; multi-file cluster; corruption-prone |
| `memoryfs` | Node + browser | **High** (whole PGDATA in WASM mem) | none until `dumpDataDir` (§72's proposal) |
| `idbfs` | **Browser only** | High (MEMFS) | `syncToFs` → `FS.syncfs` flush to IndexedDB |
| `opfs-ahp` | **Browser only** | Low | **journaled** — maintains a `WALEntry` op-log + sync-access-handle pool |

**The journaling backend exists — but it's browser-only.** `opfs-ahp`
(`dist/fs/opfs-ahp.d.ts`) literally keeps an operation WAL (`interface WALEntry {
opp; args }`) over a `FileSystemSyncAccessHandle` pool. It is the crash-resilient
low-RAM VFS — but it's built on the browser **OPFS** API (`navigator.storage`), and
`idbfs` needs IndexedDB. **Neither can run in our Node / Tauri-sidecar server.** So
PGLite's own journaling answer is off the table for our deployment.

### The two durability knobs PGLite *does* expose to Node

- **`relaxedDurability?: boolean`** (top-level option). After every mutating
  `execProtocol`, PGLite calls `fs.syncToFs()`. With `relaxedDurability: false`
  (**default**) it `await`s that sync before the query returns; with `true` it fires
  the sync **without awaiting** (faster, weaker). This is a *speed-over-safety* knob —
  the wrong direction for us. If anything we want it left **off**, and for `nodefs`
  it's nearly moot anyway (see next).
- **`syncToFs()`** (manual flush). For the custom VFSes this flushes their WAL/pool;
  for `nodefs`/`EmscriptenBuiltinFilesystem` it's effectively a **no-op** because
  NODEFS already wrote through to the host files. This is precisely why the HS-7932
  spike found PGLite never issues `fsync` in our mode — the bytes reach the kernel
  page cache and nothing flushes them (which HS-7935's explicit `fsyncDir` wrap now
  papers over).

**Bottom line:** there is no Node-side PGLite flag or alternate VFS that gives us
journaled, low-RAM, crash-atomic durability out of the box. The middle ground has to
be built at our layer.

### The realistic middle-ground designs (Node-side)

**Option D — NodeFS live + atomic snapshot as the *trusted* artifact (low RAM,
self-healing).** *Greenlit + designed in full in `docs/73-snapshot-protection.md`
(HS-8583).* Keep today's low-RAM `nodefs` live cluster, but stop treating the
live multi-file directory as the source of truth. Take the atomic gzipped
`dumpDataDir` snapshot on the same debounce + graceful-shutdown triggers as §72
(`dumpTar` works fine in `nodefs` — backups already prove it), and on startup, **if
the live cluster fails to open OR fails a cheap integrity probe, automatically
`loadDataDir` from the newest good snapshot** into a fresh dir — no manual Repair UI,
loss bounded to "since last snapshot." This is the existing preserve-aside +
recovery-banner flow (HS-7889 / HS-7899) **promoted to automatic, with the snapshot as
the trusted recovery source.** Honest limitation: it does **not** make corruption
*impossible* (the live files are still the fragile format) — it makes it **non-fatal
and self-healing at zero extra RAM.** Cheapest meaningful win.

**Option B′ — `memoryfs` for the durable set *only* (corruption-proof AND low RAM).**
The reason full-memory is RAM-heavy is the §67 telemetry tables. Split them out: keep
the **small** durable set (tickets / attachments / settings / sync state) in
`memoryfs` + atomic snapshot (corruption **impossible**, and the RAM cost is tiny
because the set is small), and keep the **large** disposable set (telemetry) in
`nodefs` (low RAM, corruption acceptable — it's analytics, not user data). This is
§72.3 #2's telemetry split promoted from "contingency if the numbers are bad" to **the
recommended end-state** — it resolves the RAM objection directly and still gives the
corruption-proof guarantee where it matters. (This is what Phase 3 / HS-8579 should
decide in favor of, pending Phase 1's numbers.)

### Updated recommendation given the RAM constraint

1. **Ship Option D first** (filed as a new follow-up) — biggest robustness gain per
   unit of effort, **no extra RAM**, reuses backup machinery, and is independently
   valuable even if we never adopt `memoryfs`.
2. **Target Option B′ as the end-state** — `memoryfs` for the small durable set +
   `nodefs` for telemetry — which is corruption-proof for user data *and* RAM-bounded,
   neutralizing the user's concern. Phases 1/3 of §72 feed this decision.

## 72.7 Phase 1 benchmark results (HS-8577, 2026-05-25)

Measured with `scripts/bench-memory-primary.ts` (PGLite 0.4.5 / PG 17.5, macOS). Each
row is a **fresh process** (no cross-run WASM-memory accumulation), built via the real
`createPglite` helper + the real §67 telemetry DDL. `RSS` = total resident growth over
an empty-process baseline (Node + WASM + data); `External` = WASM linear memory +
ArrayBuffers (the "PGDATA-in-RAM" signal). 200k events ≈ one month of heavy use
(events every ~5 s) + proportional metrics + spans.

| mode | events | projects | RSS (MB) | External (MB) | dump (ms) | snapshot (MB) |
|---|---|---|---|---|---|---|
| file | 0 | 1 | 840 | 247 | 376 | 4.1 |
| memory | 0 | 1 | 843 | 324 | 336 | 4.1 |
| file | 50k | 1 | 1065 | 627 | 1961 | 22.0 |
| memory | 50k | 1 | 1306 | 1003 | 1802 | 22.0 |
| file | 200k | 1 | 1962 | 958 | 6188 | 76.2 |
| memory | 200k | 1 | **2877** | **3085** | 6087 | 76.2 |
| file | 50k | 3 | 1473 | 1020 | — | — |
| memory | 50k | 3 | 2046 | 2141 | — | — |
| file | 50k | 5 | 1813 | 1412 | — | — |
| memory | 50k | 5 | **2813** | **3080** | — | — |

**Findings.**

1. **The WASM Postgres baseline is large and mode-independent (~840 MB RSS for one
   empty instance).** This is the compiled-Postgres WASM image + reserved memory, paid
   once per open instance in BOTH modes — so multi-project is already RAM-heavy today,
   before any memory-primary change.
2. **Telemetry volume is what makes memory-primary expensive.** With no telemetry the
   two modes are within noise (durable set is ~4 MB). At 200k events single-project,
   memory-primary costs **+915 MB RSS / +2.1 GB WASM memory** over file-backed — that is
   the entire telemetry set held resident in WASM memory instead of paged to disk by
   `nodefs`. Across 5 projects (50k each) the gap is ~+1 GB RSS / +1.7 GB WASM.
3. **Snapshot (dump) latency + write-amplification scale brutally with telemetry, and
   are mode-independent** (`dumpDataDir` serializes the whole cluster regardless of
   backend): 376 ms empty → ~1.9 s @ 50k → **~6.2 s @ 200k**, rewriting a **76 MB**
   tarball each time. Telemetry ingestion is continuous, so snapshotting the whole
   cluster on every debounce would thrash — exactly the §72.3 #3/#4 concern, now
   quantified.
4. **The durable set alone is trivially viable** for memory-primary: ~4 MB snapshot,
   ~336 ms dump, negligible RAM delta vs file.

**Verdict → confirms Option B′ (the §72.6 telemetry split), and shapes the remaining
phases.** Naive *whole-cluster* memory-primary (a global `db_persistence_mode:
'snapshot'`) is **not viable** with telemetry on: the RAM cost and the 6 s / 76 MB
write-amplification are prohibitive. The viable shape is **memory-primary for the small
durable set only (tickets / attachments / settings / sync state), telemetry stays
`nodefs`** — RAM-bounded AND corruption-proof where it matters. So:

- **Phase 3 (HS-8579) telemetry-split decision: GO.** These numbers are the evidence.
- **The production open-path + setting (originally scoped into Phase 1) was deliberately
  NOT built** — the benchmark's job was to decide the shape, and it shows the naive
  global mode is the wrong shape. Phase 2 (HS-8578) should wire the snapshot triggers for
  the *durable-set* store, and Phase 4 (HS-8580) the migration/cutover, both in the
  Option B′ shape rather than the original whole-cluster shape.
- **Urgency is low.** §73 (Option D) shipped and already makes corruption non-fatal +
  self-healing at zero extra RAM. Option B′ upgrades the *durable set* from
  corruption-resilient to corruption-proof — a worthwhile but non-urgent enhancement
  on top of §73.

Re-run anytime: `node --import tsx --expose-gc scripts/bench-memory-primary.ts [eventCounts...]`.

## 72.8 Phase 3 — telemetry-split decision + implementation sketch (HS-8579, 2026-05-25)

**Decision: GO** (conditional on the memory-primary track being pursued at all — see urgency note below). If the durable set is ever moved memory-primary, the §67 telemetry tables MUST be split into a separate file-backed DB; §72.7's numbers make whole-cluster memory-primary non-viable, and the split is the shape that resolves it. An architecture audit of the current telemetry access path confirms the split is low-risk.

**Why GO (the evidence):**

- **§72.7 numbers:** telemetry is the entire cost. At 200k events memory-primary adds +915 MB RSS / +2.1 GB WASM and the whole-cluster dump hits ~6.2 s / 76 MB. The durable set alone is ~4 MB / ~336 ms. Keeping telemetry `nodefs` (paged to disk) while the small durable set goes memory-primary removes both the RAM blow-up and the dump/write-amplification.
- **Zero cross-DB coupling to break.** A full search found **no JOINs** between the `otel_*` tables and the durable tables (tickets / attachments / settings / sync). Telemetry queries only self-join `otel_*`; the `project_secret` column is used for filtering, never for cross-DB joins. So separate PGlite instances cannot break any query.
- **Tiny blast radius.** All telemetry access already resolves its handle through the context-based `getDb()` (AsyncLocalStorage per `runWithDataDir`). Only three modules touch the tables: `src/db/otelWriters.ts` (ingest), `src/db/otelQueries.ts` (~19 dashboard read fns), and `src/cleanup.ts::cleanupTelemetryRows` (retention). Routing them to a second handle is a localized change — no query rewrites.
- **The durable/disposable boundary is already drawn.** `src/dbJsonExport.ts`'s `TABLES` list already excludes the `otel_*` tables (telemetry is explicitly not part of the durable JSON co-save). The split just makes physical what the codebase already treats as logical.

**Implementation sketch (the shape Phases 2 + 4 should build):**

1. **Second instance per project, lazily opened.** Add `getOtelDb()` mirroring `getDb()`/`getDbForDir` in `src/db/connection.ts` — a `databases`-style map keyed on a separate path `<dataDir>/db-otel/`, constructed via `createPglite` (template1 pin, HS-8585), AsyncLocalStorage-resolved like `getDb()`. The telemetry DB stays **`nodefs`** (file-backed, low RAM, disposable) even after the durable DB goes memory-primary. **Open it lazily — only when `telemetry_enabled` is set for the project** — so projects without telemetry never pay the second instance's baseline. (§72.7 measured each additional PGlite instance at ~+243 MB RSS; lazy-open keeps that off the books for the common telemetry-off project.)
2. **Schema split.** Move the `otel_*` DDL (the `CREATE TABLE` + index block currently in `connection.ts::initSchema`) into a new `initOtelSchema(db)` run when `getOtelDb()` first opens the telemetry cluster. The durable `initSchema` keeps everything else.
3. **Route the three modules.** `otelWriters.ts`, `otelQueries.ts`, and `cleanupTelemetryRows` call `getOtelDb()` instead of `getDb()`. No SQL changes (no JOINs to fix).
4. **Snapshot/backup.** The durable DB gets the memory-primary atomic snapshot (the §72 mechanism). The telemetry DB is **disposable — not snapshotted** (corruption of analytics is acceptable; that's the whole premise). Backups (§7) dump only the durable cluster; the JSON co-save already excludes telemetry. This is what makes the durable snapshot small + fast again (~4 MB / ~336 ms per §72.7).
5. **Migration (Phase 4) is "start fresh," not "copy."** Because telemetry is disposable, the cutover does NOT need a cross-DB row copy (which separate PGlite instances can't do via SQL anyway). On first boot in split mode, the new `db-otel` cluster starts empty and the `otel_*` tables in the old durable cluster are simply dropped (or left behind and ignored when the durable set is dumped→reloaded memory-primary). Losing pre-split telemetry history on cutover is acceptable; if we ever want to preserve it, a one-time read-rows-from-durable → write-to-otel loop is the fallback, but it's not required.
6. **Lifecycle.** `closeAllDatabases` / recovery / fsync iterate the otel instance alongside the durable one (it's just another entry in the instances map). The §45 graceful-shutdown + §73 recovery paths apply to the durable DB; the telemetry DB needs no recovery (disposable → on corrupt open, drop + recreate empty).

**Honest cost.** The split is not free: it adds one extra PGlite instance per telemetry-enabled project (~+243 MB RSS baseline, §72.7), and the telemetry data itself stays paged to disk via `nodefs` rather than resident. That is a clear win over naive whole-cluster memory-primary (which paid +2.1 GB to hold telemetry in WASM memory) — but it is strictly *more* overhead than today's single-DB file-backed mode. The split only earns its keep as the enabler for durable-set memory-primary; it has no standalone value.

**Outcome: track DROPPED — Phases 2 & 4 closed WON'T FIX (2026-05-25).** §72.8's "do not build yet without re-confirmation" recommendation went to the user, who chose to drop the memory-primary track entirely. The reasoning held: §73 (Option D) already shipped and makes corruption non-fatal + self-healing at zero extra RAM, so the telemetry split + durable-set memory-primary (Phases 2 + 4) would only upgrade the durable set from corruption-*resilient* to corruption-*proof* — a real but incremental gain not worth the ~+243 MB/project second-instance cost above. **HS-8578 (Phase 2) and HS-8580 (Phase 4) are closed WON'T FIX; the implementation sketch above is retained as the design record only, in case the decision is ever revisited.** Phases 1 (HS-8577 benchmark) and 3 (HS-8579 split decision) remain the completed, valuable output of the §72 investigation: they proved whole-cluster memory-primary is non-viable and that §73 is the right place to have stopped.

## 72.9 Cross-references

- §7 — backup / restore (the dump/load path this proposal promotes to primary).
- §41 — JSON co-save escape hatch (kept as-is).
- §42 — Database Repair (shrinks under snapshot mode).
- §44 — WASM `pg_resetwal` spike (can stay deferred indefinitely under snapshot mode).
- §45 — PGLite cleaner-shutdown (the mitigation stack this proposal makes largely
  redundant; §45.3's `gracefulShutdown` hook point is reused for the final snapshot).
- §46 — service/client decoupling (snapshot mode simplifies the single-owner story).
