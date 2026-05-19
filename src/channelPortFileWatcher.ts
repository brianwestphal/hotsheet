import type { ChannelInfo } from './channelPortFile.js';
import { readChannelInfo, writeChannelInfo } from './channelPortFile.js';
import {
  defaultIsPidAlive,
  listAliveEntries,
  pickLeader,
  registerSelf,
} from './channelRegistry.js';

/** HS-8455 + HS-8460 — self-heal watcher for the channel-server's port
 *  file. Reconciles three pieces of state every tick:
 *
 *   1. **Our per-pid registry entry** at
 *      `<dataDir>/channel-ports.d/<pid>.json` — self-heal if it
 *      vanished (e.g. user wiped `.hotsheet/`).
 *   2. **The shared `<dataDir>/channel-port` file** — the FIFO view onto
 *      the registry. Always holds the **leader** (oldest alive by
 *      `startedAt`). Only the leader's watcher writes it; followers
 *      leave it alone. When the leader exits, the next-oldest's
 *      watcher promotes itself within one tick.
 *   3. **Notification to the main server** when our actions might
 *      change what the dashboard sees — only on a leader-write or a
 *      leader-handoff. Steady-state ticks are silent.
 *
 *  Pre-HS-8460 the watcher's contract was "rewrite the port file if
 *  it doesn't match our identity." When two channel-servers ran for
 *  the same dataDir (multi-Claude workflow), they dueled — each
 *  process's tick would clobber the other's pid until the livelock
 *  guard fired. Triggers went to whichever won; the user's other
 *  Claude saw nothing. The HS-8460 fix replaces the duel with
 *  deterministic FIFO leader-selection. The livelock guard is gone —
 *  it can't happen now because followers don't try to claim the
 *  port file.
 *
 *  Why periodic poll instead of `fs.watch`: poll-based recovery works
 *  identically on every platform + filesystem (NFS, FUSE, Tauri
 *  sandbox), can't be defeated by `rm` happening before the watcher
 *  is reinstalled on the new inode, and has a tiny surface area.
 *  Worst-case 5 s lag before recovery is well below the user's
 *  "did the channel break?" attention threshold.
 */

export interface PortFileWatcherOptions {
  /** Absolute path to `<dataDir>/channel-port`. */
  portFile: string;
  /** Absolute path to the dataDir (parent of `channel-port` +
   *  `channel-ports.d/`). Used by the registry. */
  dataDir: string;
  /** Our identity. Captured at install-time; the watcher doesn't
   *  mutate it. */
  info: ChannelInfo;
  /** Poll interval in milliseconds. Default 5_000. Tests pass a tiny
   *  value via `setIntervalFn`. */
  intervalMs?: number;
  /** Diagnostic logger — same shape as `channelLog.ts`'s log function.
   *  Events emitted:
   *    - `port-file-leader-write` — we are the leader and (re)wrote
   *      `channel-port` with our identity (either because the file was
   *      missing OR because it carried a different pid — the previous
   *      leader exited and we just took over).
   *    - `port-file-follower-defer` — we are NOT the leader and the
   *      port file currently points to someone else; we left it alone.
   *      Logged on transitions only (we became a follower OR the
   *      leader changed) to keep steady-state silent.
   *    - `port-file-registry-heal` — our per-pid registry entry was
   *      missing and we re-wrote it.
   *    - `port-file-heal-error` — write threw (e.g. dataDir removed).
   *  Note: pre-HS-8460 events `port-file-heal-rewrite` and
   *  `port-file-heal-livelock` are gone. */
  log?: (event: string, details?: string) => void;
  /** Called after a leader-write so the main server's `isChannelAlive`
   *  poll wakes immediately. Not called on follower ticks. */
  notify?: () => void;
  /** Injection point for tests. Production callers pass `undefined`. */
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Injection point for the liveness probe. Defaults to
   *  `process.kill(pid, 0)`-based. */
  isPidAlive?: (pid: number) => boolean;
}

/** Install the watcher. Returns a dispose function the caller should
 *  invoke from `cleanup()` so the timer doesn't keep the process alive. */
export function installPortFileWatcher(opts: PortFileWatcherOptions): () => void {
  const intervalMs = opts.intervalMs ?? 5_000;
  const setIntervalFn: (cb: () => void, ms: number) => unknown = opts.setIntervalFn ?? setInterval;
  const clearIntervalFn: (handle: unknown) => void = opts.clearIntervalFn
    ?? ((handle: unknown) => { clearInterval(handle as ReturnType<typeof setInterval>); });
  const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;

  // Track our last role (leader / follower) so we only log on
  // transitions — steady-state ticks stay silent and `mcp.log` only
  // captures actual state changes.
  type Role = 'unknown' | 'leader' | 'follower';
  let lastRole: Role = 'unknown';
  let lastLeaderPid: number | null = null;

  const tick = (): void => {
    // 1. Self-heal our registry entry first. If it was deleted (user
    //    wiped `.hotsheet/`, race with another GC pass), re-register
    //    so the leader-selection below sees us.
    if (opts.info.pid !== null) {
      const allEntries = listAliveEntries(opts.dataDir, isPidAlive);
      const ourEntry = allEntries.find(e => e.pid === opts.info.pid);
      if (ourEntry === undefined) {
        try {
          registerSelf(opts.dataDir, opts.info);
          opts.log?.('port-file-registry-heal', `pid=${String(opts.info.pid)}`);
        } catch (err) {
          opts.log?.('port-file-heal-error', `registerSelf: ${String(err)}`);
          return;
        }
      }
    }

    // 2. Re-read the registry after the heal (so our entry is in the
    //    list when picking the leader).
    const alive = listAliveEntries(opts.dataDir, isPidAlive);
    const leader = pickLeader(alive);

    if (leader === null) {
      // No alive entries at all — nothing to do this tick. (Could
      //   happen during a wipe race; next tick's registry-heal will
      //   put us back.)
      return;
    }

    const weAreLeader = leader.pid === opts.info.pid;

    if (weAreLeader) {
      // 3a. Leader path: ensure channel-port matches our identity.
      const current = readChannelInfo(opts.portFile);
      const matches = current !== null
        && current.pid === opts.info.pid
        && current.port === opts.info.port
        && current.slug === opts.info.slug;

      if (!matches) {
        try {
          writeChannelInfo(opts.portFile, opts.info);
          const reason = current === null
            ? 'missing'
            : `previous-leader-pid=${String(current.pid)}`;
          opts.log?.('port-file-leader-write', reason);
          opts.notify?.();
        } catch (err) {
          opts.log?.('port-file-heal-error', `writeChannelInfo: ${String(err)}`);
          return;
        }
      }

      // Role transition: were we previously a follower (or unknown)?
      // The leader-write log above covers content changes; this is
      // just promotion bookkeeping.
      if (lastRole !== 'leader') {
        lastRole = 'leader';
        lastLeaderPid = opts.info.pid;
      }
    } else {
      // 3b. Follower path: leave channel-port alone. Log only on
      //     transition (we became a follower, OR a different leader
      //     emerged while we were already following).
      if (lastRole !== 'follower' || lastLeaderPid !== leader.pid) {
        opts.log?.('port-file-follower-defer', `leader-pid=${String(leader.pid)} ours=${String(opts.info.pid)}`);
        lastRole = 'follower';
        lastLeaderPid = leader.pid;
      }
    }
  };

  const handle = setIntervalFn(tick, intervalMs);

  return (): void => {
    clearIntervalFn(handle);
  };
}
