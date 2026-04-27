# 45-checkpoint-spike — PGLite checkpoint-tuning feasibility

HS-7933 spike result. Companion to [45. PGLite Robustness](45-pglite-robustness.md) §45.6.

> **Verdict:** Cannot ship. PGLite 0.3.16 exposes **no mechanism** for overriding `checkpoint_timeout` / `max_wal_size`. The benchmark question collapses to a configuration-availability question, and the answer is "the option doesn't exist". Recommend filing an upstream issue against `@electric-sql/pglite` and re-visiting once a config-passing API lands. Filed as **HS-7936** to track the upstream ask.

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
