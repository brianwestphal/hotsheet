import type { ChannelInfo } from './channelPortFile.js';
import { readChannelInfo, writeChannelInfo } from './channelPortFile.js';

/** HS-8455 — self-heal watcher for the channel-server's port file.
 *
 *  A live channel-server process pre-fix had no way to notice that its
 *  registration was wiped out from under it. Two captured failure modes:
 *
 *   1. **Sibling-process collateral damage.** A transient second
 *      channel-server (e.g. brief `/mcp` reconnect race, sub-agent
 *      spawn) writes its own pid to `<dataDir>/channel-port`, then dies.
 *      HS-8454's pid-aware `maybeUnlinkPortFile` correctly lets it
 *      unlink — the file IS still pointing at the dying sibling. But
 *      the first process (which was serving Claude Code over its still-
 *      open stdio pipe) now has NO registration. The main server's
 *      `isChannelAlive` returns false. UI flips to "not connected."
 *
 *   2. **Manual `rm` / `cleanupStaleChannel` race.** A user testing
 *      backup-restore wipes `.hotsheet/`, or `cleanupStaleChannel`'s
 *      `/health` probe times out (existing process slow under load) and
 *      decides to unlink. The file is gone but the channel server is
 *      still alive.
 *
 *  This module exports `installPortFileWatcher(...)` which runs a
 *  periodic check (default 5 s) of the on-disk port file. If the file is
 *  missing OR carries a pid that isn't ours, we re-write it with our
 *  identity and notify the main server. A livelock guard caps the
 *  rewrite rate at 5 per 60 s — if exceeded, the watcher logs and stops
 *  rewriting to avoid hot-spinning against another live process. In
 *  practice the cap should never fire (real parallel-server collisions
 *  resolve in seconds when the transient process exits); the cap exists
 *  for the paranoid case.
 *
 *  Why periodic poll instead of `fs.watch`: poll-based recovery works
 *  identically on every platform + every filesystem (NFS, FUSE, Tauri
 *  sandbox), can't be defeated by a `rm` that happens before the watcher
 *  is reinstalled on the new inode, and has a tiny surface area. The
 *  worst-case 5 s lag before recovery is well below the user's "did the
 *  channel break?" attention threshold.
 */

export interface PortFileWatcherOptions {
  /** Absolute path to `<dataDir>/channel-port`. */
  portFile: string;
  /** The ownership info we'd re-write with on a heal. Captured at
   *  install-time; the watcher doesn't mutate it. */
  info: ChannelInfo;
  /** Poll interval in milliseconds. Default 5_000. Tests pass a tiny
   *  value via `setIntervalFn`. */
  intervalMs?: number;
  /** Diagnostic logger — same shape as `channelLog.ts`'s log function.
   *  Events emitted: port-file-heal-rewrite (we re-wrote the file),
   *  port-file-heal-livelock (rewrite cap exceeded — watcher gave up). */
  log?: (event: string, details?: string) => void;
  /** Called after every successful re-write so the main server's
   *  `isChannelAlive` poll wakes immediately rather than waiting for
   *  the next dashboard refresh. */
  notify?: () => void;
  /** Injection point for tests so they can drive the interval
   *  synchronously. Production callers pass `undefined` and the watcher
   *  uses the platform `setInterval` + `clearInterval`. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

/** Cap: 5 rewrites in 60 seconds → suspect a livelock; stop trying. */
const REWRITE_BURST_MAX = 5;
const REWRITE_BURST_WINDOW_MS = 60_000;

/** Install the watcher. Returns a dispose function the caller should
 *  invoke from `cleanup()` so the timer doesn't keep the process alive. */
export function installPortFileWatcher(opts: PortFileWatcherOptions): () => void {
  const intervalMs = opts.intervalMs ?? 5_000;
  const setIntervalFn: (cb: () => void, ms: number) => unknown = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn: (handle: unknown) => void = opts.clearIntervalFn
    ?? ((handle: unknown) => { clearInterval(handle as ReturnType<typeof setInterval>); });

  // Rolling window of rewrite timestamps (ms since epoch). Pruned each
  // tick to drop entries older than `REWRITE_BURST_WINDOW_MS`.
  const rewriteTimestamps: number[] = [];
  let livelocked = false;

  const tick = (): void => {
    if (livelocked) return;
    const current = readChannelInfo(opts.portFile);
    // File OK + pid matches → no-op. (Slug + port mismatches treated as
    // healable too: if a different project's slug ended up in our
    // file somehow, the recovery is the same.)
    if (
      current !== null
      && current.pid === opts.info.pid
      && current.port === opts.info.port
      && current.slug === opts.info.slug
    ) {
      return;
    }

    // Livelock check before rewriting.
    const now = Date.now();
    while (rewriteTimestamps.length > 0 && now - rewriteTimestamps[0] > REWRITE_BURST_WINDOW_MS) {
      rewriteTimestamps.shift();
    }
    if (rewriteTimestamps.length >= REWRITE_BURST_MAX) {
      livelocked = true;
      opts.log?.('port-file-heal-livelock', `${String(REWRITE_BURST_MAX)} rewrites in ${String(REWRITE_BURST_WINDOW_MS)}ms — giving up to avoid hot-spin`);
      return;
    }
    rewriteTimestamps.push(now);

    const reason = current === null
      ? 'vanished'
      : `pid-mismatch on-disk=${String(current.pid)} ours=${String(opts.info.pid)}`;
    try {
      writeChannelInfo(opts.portFile, opts.info);
      opts.log?.('port-file-heal-rewrite', reason);
      opts.notify?.();
    } catch (err) {
      // writeChannelInfo throws if the dataDir was deleted underneath
      // us (uncommon — would mean the user wiped `.hotsheet/` mid-
      // session). Log + keep ticking; the next interval will retry.
      opts.log?.('port-file-heal-error', String(err));
    }
  };

  const handle = setIntervalFn(tick, intervalMs);

  return (): void => {
    clearIntervalFn(handle);
  };
}
