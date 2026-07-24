# 45-checkpoint-spike — PGLite checkpoint-tuning feasibility

HS-7933 spike result. Companion to [45. PGLite Robustness](45-pglite-robustness.md) §45.6.

> **Verdict (0.3.16):** Cannot ship. PGLite 0.3.16 exposes **no mechanism** for overriding `checkpoint_timeout` / `max_wal_size`.
>
> **⚠ SUPERSEDED for `max_wal_size` as of PGLite 0.4.6 — see the UPDATE at the bottom (HS-9424).** The `startParams` constructor option now forwards `-c` flags to the runtime, so `max_wal_size` / `min_wal_size` CAN be set at cluster creation. The rest of this spike (checkpoint_timeout, the benchmark) is still worth re-running. The benchmark question collapses to a configuration-availability question, and the answer is "the option doesn't exist". Recommend filing an upstream issue against `@electric-sql/pglite` and re-visiting once a config-passing API lands. Filed as **HS-7936** to track the upstream ask.

## What the design (§45.6) hoped for

`db.exec("ALTER SYSTEM SET checkpoint_timeout = '60s'")` followed by `pg_reload_conf()` to drop the live cluster's checkpoint cadence from 5min to 60s, with `max_wal_size = '256MB'` (default 1 GB) capping WAL growth. The expected cost was a small linear write-rate increase, comfortably under the 10x ceiling the ticket set as the ship/don't-ship line.

## What happens in practice

Three override paths were tested on macOS arm64 / Node 22.14.0 / PGLite 0.3.16:

### 1. `ALTER SYSTEM SET … ; SELECT pg_reload_conf()`

```js
await db.exec(`ALTER SYSTEM SET checkpoint_timeout = '60s'`);
await db.exec(`ALTER SYSTEM SET max_wal_size = '256MB'`);
await db.exec(`SELECT pg_reload_conf()`);

const r = await db.query(`SELECT name, setting FROM pg_settings
                          WHERE name IN ('checkpoint_timeout', 'max_wal_size')`);
// → checkpoint_timeout=300, max_wal_size=1024 (UNCHANGED)
```

`pg_reload_conf()` returns `t` but `pg_settings` shows the values stayed at defaults. PGLite's single-process WASM runtime doesn't honor SIGHUP-based reloads — the postmaster reload signal is a no-op, so even though `postgresql.auto.conf` (the file ALTER SYSTEM writes to) gets updated on disk, the running process never re-reads it.

### 2. `SET checkpoint_timeout = '60s'` (session-level GUC)

```
ERROR: parameter "checkpoint_timeout" cannot be changed now
```

Expected — `checkpoint_timeout` is a `sighup`-only GUC, not session-mutable. Same for `max_wal_size`.

### 3. Append to `<dataDir>/postgresql.conf`, close, reopen

```js
appendFileSync(join(dir, 'postgresql.conf'),
  `\ncheckpoint_timeout = '60s'\nmax_wal_size = '256MB'\n`);
await db.close();
const db2 = new PGlite(dir);
await db2.waitReady;
// pg_settings → checkpoint_timeout=300, max_wal_size=1024 (UNCHANGED)
```

The conf file is preserved on disk (`HS-7933 tweaks` line still there after re-open), but the values don't take effect. PGLite must hard-code its config via the postgres `-c` command-line override pattern, which beats `postgresql.conf` per the postgres documentation. Whatever `-c` flags the WASM runtime starts with are baked into the bundle.

### 4. `PGliteOptions` constructor argument

The TypeScript definition for PGLite 0.3.16 (`node_modules/@electric-sql/pglite/dist/pglite-CntadC_p.d.ts:468`):

```ts
interface PGliteOptions<TExtensions extends Extensions = Extensions> {
    dataDir?: string;
    username?: string;
    database?: string;
    fs?: Filesystem;
    debug?: DebugLevel;
    relaxedDurability?: boolean;
    extensions?: TExtensions;
    loadDataDir?: Blob | File;
    initialMemory?: number;
    wasmModule?: WebAssembly.Module;
    fsBundle?: Blob | File;
    parsers?: ParserOptions;
    serializers?: SerializerOptions;
}
```

No `pgConfig`, no `commandLineArgs`, no `gucOverrides`. The closest field is `relaxedDurability` — a boolean that is **the opposite of what we want** (it relaxes fsync for write throughput; useless to us anyway since fsync is already a no-op per HS-7932).

## Why this kills the benchmark

The methodology in §45.6 assumes there's a way to apply the tweak. With every override path silently dropped, there's nothing to measure — every "tightened" run is identical to the default run. An earlier 15-second synthetic-write benchmark gave a 1.06x ratio between "default" and "tight" configs, well within noise floor. That's because the runs were actually default-vs-default; the ALTER SYSTEM call had no effect.

## Recommendation

1. **File an upstream issue** (HS-7936) against `electric-sql/pglite` asking for either:
   - A `pgConfig: { checkpoint_timeout?: string; max_wal_size?: string; … }` constructor argument that PGLite forwards to the postgres runtime as `-c` flags, OR
   - Honoring `pg_reload_conf()` so ALTER SYSTEM works in the single-process WASM model.
2. **Document defaults as load-bearing.** Until upstream support lands, the live cluster's worst-case crash-recovery window is bounded by the default `checkpoint_timeout = 5min`. The 5-min backup tier (HS-7891 CHECKPOINT-before-dump) provides a bound from a different angle, so the practical exposure isn't worse than the user's existing backup window — design the rest of the system around that.
3. **Re-evaluate post-upstream.** When PGLite exposes a config-passing API, run the §45.6 benchmark with real before/after measurements and decide ship/don't-ship per the original 10x criterion.

## Probe scripts

The three probe scripts (`ALTER SYSTEM verify`, `SET try`, `postgresql.conf round-trip`) are preserved as code blocks above. Re-run any of them by saving the relevant block to `<repo>/probe.mjs` and `node ./probe.mjs`. Identical results (no values change) confirm the gap; any value that flips would indicate PGLite has shipped a fix.

---

## UPDATE 2026-07-24 (HS-9424): the config-passing API landed — `startParams`

The verdict above ("the option doesn't exist") was correct for **0.3.16**. Re-probed on **PGLite 0.4.6**
while investigating the telemetry WAL bloat (HS-9422/9424), and the gap the recommendation was waiting
on has closed. `PGliteOptions` now includes:

```ts
startParams?: string[];        // extra postgres `-c` args
initDbStartParams?: string[];
postgresqlconf?: string[] | string;
```

`startParams` with `-c` flags **works** — it is the "config-passing API" recommendation #1 above asked
upstream for. Verified: a cluster created with

```ts
await PGlite.create(dbDir, { startParams: [...DEFAULT_START_PARAMS, '-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB'] });
```

reports `max_wal_size=64MB` from `SHOW`, and its WAL directory settles to ~48–64 MB across a
close/reopen cycle instead of the default 176 MB+ (default budget is 1 GB / 80 MB).

### Four traps that cost real time — record them

1. **`startParams` REPLACES PGLite's `defaultStartParams`, it does not append.** Passing only your
   `-c` flags drops `--single -F -O -j` and the `search_path` / `max_*_workers` defaults, and the
   cluster **fails to initialize** (`PGlite failed to initialize properly`). You must prepend the full
   default array. That array is an internal PGLite constant **not exported** from the package:
   ```
   ["--single","-F","-O","-j","-c","search_path=public","-c","exit_on_error=false",
    "-c","log_checkpoints=false","-c","max_worker_processes=0","-c","max_parallel_workers=0",
    "-c","max_parallel_workers_per_gather=0"]
   ```
   Hard-coding it means it can **drift on a PGLite upgrade** — the single biggest risk in adopting
   this. Any implementation must pin this with a startup assertion/test that fails loudly if the
   bundled defaults change (grep the dist for `defaultStartParams`).

2. **`postgresqlconf` OVERWRITES the whole `postgresql.conf`** (it is not a delta). PGLite writes your
   array/string as the entire file, so a two-line override drops every other required setting and
   bricks the cluster — exactly the "postgresql.conf editing bricks the cluster" symptom in HS-9424.
   Use `startParams`, not `postgresqlconf`.

3. **`min_wal_size` has a floor.** `16MB` fails init; `32MB` works. Keep `min_wal_size ≥ 32MB`
   (≥ 2 × 16 MB segments).

4. **`max_wal_size` is a soft target, not a hard cap.** WAL still peaks to ~176 MB during a heavy
   write burst; the budget governs the STEADY-STATE size it recycles back down to on the next
   checkpoint/restart. Fine for telemetry (append-mostly, bursty), but don't promise a hard ceiling.

### The migration limit

Tuning only helps **new** clusters. Reopening an **existing** 176 MB-WAL cluster with the tuned
`startParams` does **not** reclaim the excess (measured: stays at 176 MB across reopen + explicit
CHECKPOINT + write + CHECKPOINT). Existing bloated telemetry clusters must be **recreated** from the
JSONL raw store, not repaired in place.

### So the §45.6 benchmark is now runnable

Recommendation #3 above — "re-evaluate post-upstream" — is unblocked. The checkpoint-cadence /
WAL-budget tuning the original spike wanted can now be applied and measured for real. Tracked for the
live-cluster case as a fresh evaluation; the telemetry-cluster tuning is HS-9426, and reclaiming existing bloat by recreation is HS-9427.
