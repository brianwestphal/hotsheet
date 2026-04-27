# 45-fsync-spike — PGLite `fsync` round-trip verification

HS-7932 spike result. Companion to [45. PGLite Robustness](45-pglite-robustness.md) §45.5.

> **Verdict:** PGLite does **NOT** flush writes to disk via `fsync` on any platform. Emscripten's NODEFS backend (which PGLite uses for host-fs persistence) doesn't define a `fsync` stream operation, so PostgreSQL's internal `fsync()` calls are silently no-ops. Recommend a follow-up implementation ticket to wrap our application boundaries (post-CHECKPOINT, pre-close) with explicit `fs.fsyncSync` calls. Filed as **HS-7935**.

## Method

Two-pronged verification, both run on macOS arm64 / Node 22.14.0 / PGLite `0.3.16`:

1. **Code-level analysis** of the PGLite WASM JS bundle (`node_modules/@electric-sql/pglite/dist/index.js`).
2. **Behavioral probe** — spy on `fs.fsyncSync` / `fs.fsync` / `fs.fdatasyncSync` and run a round-trip (open → INSERT → CHECKPOINT → close) against PGLite.

## Findings

### 1. Code-level — NODEFS has no `fsync` stream op

PGLite's bundled NODEFS (the Emscripten file-system backend that bridges the WASM virtual FS to the host filesystem) defines this `stream_ops` set:

```
open, close, dup, read, write, llseek, mmap, msync
```

There is no `fsync`. The Emscripten FS layer's syscall handler routes `fsync` through `t.stream_ops?.fsync ? t.stream_ops.fsync(t) : 0` — when the stream's ops don't define `fsync`, the call returns `0` (success) without doing anything. PostgreSQL's `fsync_fname()` therefore always succeeds without touching the host filesystem.

PGLite *does* expose `_fd_fsync_fname` from the WASM module (it's part of the postgres core), but that symbol is the postgres-side function — its actual `fsync()` call inside the WASM bottoms out in the no-op stream op.

The WASM's other persistence path is `FS.syncfs(true, cb)`, used by IDBFS for browser-side persistence. That's irrelevant for our Node/Tauri shipping target.

### 2. Behavioral probe — zero fsync calls during a full round-trip

```js
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const fs = require('fs');

let fsyncSyncCalls = 0;
let fsyncCalls = 0;
let fdatasyncCalls = 0;
const origFsyncSync = fs.fsyncSync;
fs.fsyncSync = function(...a) { fsyncSyncCalls++; return origFsyncSync.apply(this, a); };
// (same wrapping for fs.fsync and fs.fdatasyncSync)

const { PGlite } = await import('@electric-sql/pglite');
const db = new PGlite(dir);
await db.waitReady;
await db.exec('CREATE TABLE t (id int)');
await db.exec('INSERT INTO t VALUES (1), (2), (3)');
await db.exec('CHECKPOINT');
await db.close();
console.log({ fsyncSyncCalls, fsyncCalls, fdatasyncCalls });
// → { fsyncSyncCalls: 0, fsyncCalls: 0, fdatasyncCalls: 0 }
```

All three counters stay at **0** through the entire lifecycle — open, insert, CHECKPOINT, close. PGLite writes data with `fs.writeSync` but never asks the kernel to flush dirty pages to physical disk.

The probe was kept inside the Hot Sheet repo while running so Node could resolve `@electric-sql/pglite` (the temp file was deleted after the run).

### Why "code-level analysis is enough" — no need to repeat on Linux/Windows

NODEFS is a single shared JS object compiled into PGLite's bundle. The same bundle ships to every platform that runs Node. The `stream_ops` definition does not depend on `process.platform`. Linux / Windows would observe identical behavior because the JS source is identical.

The only platform-specific behavior in NODEFS is `staticInit()` setting `NODEFS.isWindows` — that affects mode-bit translation, not flushing. The fsync gap is platform-independent.

## Implications for HS-7891 incident class

The original HS-7891 incident retro identified missing CHECKPOINT before backup as the root cause. CHECKPOINT writes the WAL into the data files, so the captured tarball is internally consistent at the moment of `dumpDataDir()`. That fix doesn't depend on fsync.

But for the **live cluster**, the fsync gap means:
- Writes that haven't been flushed by the OS's natural dirty-page cycle are at risk during a power-loss / kernel-panic event.
- `db.close()` (HS-7931 graceful shutdown) writes the final CHECKPOINT, but those writes also stay in the kernel page cache without an explicit flush.
- A user who hard-powers-off their Mac immediately after Hot Sheet quits *might* lose the last few seconds of writes — the practical window is bounded by the OS dirty-page flush interval (~30s on macOS / Linux).

This is a moderate (not catastrophic) durability gap. It's also fixable from our side without forking PGLite.

## Recommended fix (filed as HS-7935)

After every CHECKPOINT in our code (currently `src/backup.ts` before `dumpDataDir`), and inside `closeAllDatabases()` after `db.close()` returns, walk every regular file in `<dataDir>/db/` and call `fs.fsyncSync(fd)` on it. Optional: `fs.fsyncSync` on the directory itself (Linux only — macOS doesn't fsync directories).

Cost: a few hundred milliseconds per checkpoint on a typical Hot Sheet dataset. Acceptable given the 5-min cadence.

Alternative: file an upstream issue + PR against PGLite to add an `fsync` stream op to NODEFS (`fs.fsyncSync(stream.nfd)`). That fixes every PGLite consumer at once. Worth doing in parallel.

## Probe artifact

The behavioral probe script is preserved as a comment block above. Re-run by saving to `<repo>/pglite-fsync-probe.mjs` and `node ./pglite-fsync-probe.mjs`. Counters remaining at zero confirms the gap; any non-zero value would indicate PGLite shipped a fix.
