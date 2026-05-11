/**
 * HS-7935 — wrap our PGLite write boundaries with explicit `fs.fsyncSync`
 * calls so durability isn't gated on the OS's natural dirty-page flush
 * cycle.
 *
 * Background. The HS-7932 spike confirmed PGLite NEVER calls `fs.fsyncSync` /
 * `fs.fsync` / `fs.fdatasyncSync` during the full open → INSERT →
 * CHECKPOINT → close lifecycle. Emscripten's NODEFS backend doesn't define
 * an `fsync` stream operation, so PostgreSQL's internal `fsync()` calls
 * bottom out as no-ops at the WASM↔host-fs boundary. Writes do reach
 * `fs.writeSync` (host kernel page cache) but never get flushed.
 *
 * Practical risk window: ~30s (the OS's natural dirty-page flush interval
 * on macOS/Linux). Power-loss / kernel-panic during that window can lose
 * recent writes. The fix is to hold a tighter durability guarantee at the
 * application boundary by walking `<dataDir>/db/` and fsyncing every
 * regular file ourselves after CHECKPOINT + close.
 *
 * Best-effort. Per-file failures are logged but don't fail the helper.
 */
import { closeSync, existsSync, fsyncSync, openSync, promises as fsp, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Test seam: the system fsync function. Tests inject a wrapper to assert
 * call counts + simulate failures without trying to spy on the ESM `fs`
 * module's frozen exports.
 */
export type FsyncFn = (fd: number) => void;

/**
 * Async counterpart of `FsyncFn` — HS-8351 added async variants of `fsyncDir`
 * / `fsyncDbDir` so the fsync syscalls run on libuv's threadpool instead
 * of the main event loop. Tests inject a stub of this shape.
 */
export type AsyncFsyncFn = (handle: fsp.FileHandle) => Promise<void>;
const defaultAsyncFsyncFn: AsyncFsyncFn = (handle) => handle.sync();

/**
 * Recursively fsync every regular file under `path` to flush pending
 * writes from the kernel page cache to physical disk. Symlinks + special
 * files are skipped. Per-file errors are logged + swallowed so a single
 * bad file doesn't abort the whole flush.
 *
 * Returns `{ filesFlushed, errors }` so callers can surface a summary
 * (e.g. graceful-shutdown logging).
 *
 * `fsyncFn` is injectable for tests — production callers omit it and get
 * `fs.fsyncSync`.
 */
export function fsyncDir(path: string, fsyncFn: FsyncFn = fsyncSync): { filesFlushed: number; errors: number } {
  if (!existsSync(path)) return { filesFlushed: 0, errors: 0 };
  const counters = { filesFlushed: 0, errors: 0 };
  walkAndFsync(path, counters, fsyncFn);
  return counters;
}

function walkAndFsync(dir: string, counters: { filesFlushed: number; errors: number }, fsyncFn: FsyncFn): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    console.error(`[fsyncWrap] readdir ${dir} failed:`, err);
    counters.errors++;
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let stats;
    try {
      stats = statSync(p);
    } catch (err) {
      // The file may have been deleted between the readdir and the stat.
      // Treat as transient — log + skip.
      console.error(`[fsyncWrap] stat ${p} failed:`, err);
      counters.errors++;
      continue;
    }
    if (stats.isDirectory()) {
      walkAndFsync(p, counters, fsyncFn);
    } else if (stats.isFile()) {
      let fd: number | null = null;
      try {
        fd = openSync(p, 'r');
        fsyncFn(fd);
        counters.filesFlushed++;
      } catch (err) {
        console.error(`[fsyncWrap] fsync ${p} failed:`, err);
        counters.errors++;
      } finally {
        if (fd !== null) {
          try { closeSync(fd); } catch { /* fd already invalid */ }
        }
      }
    }
    // Symlinks, sockets, fifos: skip silently. Postgres only writes
    // regular files + uses subdirectories, so anything else is foreign and
    // not our problem to flush.
  }
}

/**
 * Convenience wrapper for the common case: fsync every regular file under
 * `<dataDir>/db/`. Used by the HS-7929 backup CHECKPOINT path and the
 * HS-7931 graceful-close path.
 */
export function fsyncDbDir(dataDir: string, fsyncFn: FsyncFn = fsyncSync): { filesFlushed: number; errors: number } {
  return fsyncDir(join(dataDir, 'db'), fsyncFn);
}

/**
 * HS-8351 — async variant of `fsyncDir`. Same recursive walk, same per-file
 * error tolerance, same return shape — but every `fs.promises` call runs on
 * libuv's threadpool so the main event loop stays free during the fsync
 * train. Per HS-8330 freeze.log analysis, the sync `fsyncDbDir` was the #1
 * cause of event-loop blocking during backup cycles (94% of instrumented
 * sync stalls; p95 4579 ms across 118 events in 2.5 days). With 9
 * registered projects serialized through HS-8229's global mutex the chain
 * blocked the loop for 30-60 s every 5 minutes; the async version makes
 * that chain invisible to the loop while preserving wall-clock latency +
 * durability semantics.
 *
 * Same `AsyncFsyncFn` injection seam as the sync version's `FsyncFn` so
 * tests can spy on call counts + simulate failures without monkey-patching
 * `fs.promises`.
 */
export async function fsyncDirAsync(path: string, fsyncFn: AsyncFsyncFn = defaultAsyncFsyncFn): Promise<{ filesFlushed: number; errors: number }> {
  if (!existsSync(path)) return { filesFlushed: 0, errors: 0 };
  const counters = { filesFlushed: 0, errors: 0 };
  await walkAndFsyncAsync(path, counters, fsyncFn);
  return counters;
}

async function walkAndFsyncAsync(dir: string, counters: { filesFlushed: number; errors: number }, fsyncFn: AsyncFsyncFn): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    console.error(`[fsyncWrap] readdir ${dir} failed:`, err);
    counters.errors++;
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let stats;
    try {
      stats = await fsp.stat(p);
    } catch (err) {
      console.error(`[fsyncWrap] stat ${p} failed:`, err);
      counters.errors++;
      continue;
    }
    if (stats.isDirectory()) {
      await walkAndFsyncAsync(p, counters, fsyncFn);
    } else if (stats.isFile()) {
      let handle: fsp.FileHandle | null = null;
      try {
        handle = await fsp.open(p, 'r');
        await fsyncFn(handle);
        counters.filesFlushed++;
      } catch (err) {
        console.error(`[fsyncWrap] fsync ${p} failed:`, err);
        counters.errors++;
      } finally {
        if (handle !== null) {
          try { await handle.close(); } catch { /* handle already invalid */ }
        }
      }
    }
  }
}

/** HS-8351 — async counterpart of `fsyncDbDir`. */
export async function fsyncDbDirAsync(dataDir: string, fsyncFn: AsyncFsyncFn = defaultAsyncFsyncFn): Promise<{ filesFlushed: number; errors: number }> {
  return fsyncDirAsync(join(dataDir, 'db'), fsyncFn);
}
