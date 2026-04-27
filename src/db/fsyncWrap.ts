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
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Test seam: the system fsync function. Tests inject a wrapper to assert
 * call counts + simulate failures without trying to spy on the ESM `fs`
 * module's frozen exports.
 */
export type FsyncFn = (fd: number) => void;

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
