import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { ChannelInfo } from './channelPortFile.js';

/** HS-8460 — multi-channel registry. Pre-fix the channel-server design
 *  assumed exactly one server per dataDir, encoded as the single
 *  `<dataDir>/channel-port` file. Claude Code spawns one MCP child per
 *  Claude instance, so a user with two Claudes open in the same project
 *  had two channel servers fighting over the file: each one's HS-8455
 *  watcher would rewrite the file with ITS pid, the other one's next
 *  tick would notice the mismatch and write back, repeating until one
 *  hit the livelock cap. Whichever won the duel got the trigger; the
 *  other Claude saw nothing. From the user's POV, "click Play and
 *  nothing happens" — the trigger landed on a Claude they weren't
 *  looking at.
 *
 *  Fix: every channel-server registers an entry at
 *  `<dataDir>/channel-ports.d/<pid>.json` carrying its full
 *  `ChannelInfo`. The directory is the source of truth for "who's
 *  alive." The single-file `<dataDir>/channel-port` is preserved as a
 *  view onto the registry: it always holds the **leader** (the oldest
 *  alive channel-server by `startedAt`). When the leader exits, the
 *  next-oldest's watcher rewrites the channel-port file within the
 *  next poll interval. All existing readers of `channel-port`
 *  (triggerChannel, isChannelAlive, getChannelPort) keep working
 *  unchanged — they always see the FIFO leader.
 *
 *  Liveness is `process.kill(pid, 0)` (single-host, same-user
 *  assumption — Hot Sheet is local-only). Stale entries (dead pids) are
 *  GC'd lazily during `listAliveEntries` reads.
 */

/** Path to the per-pid registry directory inside `<dataDir>`. */
export function registryDir(dataDir: string): string {
  return join(dataDir, 'channel-ports.d');
}

/** Path to this pid's entry file. */
export function entryPath(dataDir: string, pid: number): string {
  return join(registryDir(dataDir), `${String(pid)}.json`);
}

/** Default liveness check — `process.kill(pid, 0)` throws ESRCH when no
 *  process exists with that pid, returns silently otherwise. Same-host
 *  + same-user only; that's fine for Hot Sheet (always local). */
export function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/** Register THIS process. Idempotent — overwrites our existing entry
 *  if present (e.g. self-heal after the file got nuked). Best-effort
 *  mkdirSync; throws only on filesystem errors that wouldn't be
 *  recoverable anyway (read-only fs, permission denied). */
export function registerSelf(dataDir: string, info: ChannelInfo): void {
  if (info.pid === null) return;
  mkdirSync(registryDir(dataDir), { recursive: true });
  const path = entryPath(dataDir, info.pid);
  const body = JSON.stringify({
    port: info.port,
    pid: info.pid,
    slug: info.slug,
    startedAt: info.startedAt,
    worktree: info.worktree ?? null, // HS-9038 — worker (follower-worktree) connection marker
  });
  writeFileSync(path, body, 'utf-8');
}

/** Remove THIS process's entry. Swallows errors — by the time we're
 *  unregistering we're in cleanup and the dataDir may already be gone. */
export function unregisterSelf(dataDir: string, pid: number): void {
  try { unlinkSync(entryPath(dataDir, pid)); }
  catch { /* missing or unwritable — fine */ }
}

/** Read a single entry file. Returns null on any read / parse error so
 *  callers can treat "unparseable entry" identically to "missing
 *  entry" (lazy GC removes it from the live set). */
export function readEntry(path: string): ChannelInfo | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf-8'); }
  catch { return null; }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.port !== 'number' || !Number.isInteger(obj.port)) return null;
    if (typeof obj.pid !== 'number' || !Number.isInteger(obj.pid)) return null;
    return {
      port: obj.port,
      pid: obj.pid,
      slug: typeof obj.slug === 'string' && obj.slug !== '' ? obj.slug : null,
      startedAt: typeof obj.startedAt === 'string' && obj.startedAt !== '' ? obj.startedAt : null,
      worktree: typeof obj.worktree === 'string' && obj.worktree !== '' ? obj.worktree : null, // HS-9038
    };
  } catch { return null; }
}

/** Enumerate alive channel-server entries for this dataDir. Sorted by
 *  `startedAt` ascending (oldest first) so `[0]` is the leader. Dead-pid
 *  + unparseable entries are GC'd from disk as a side effect — keeps
 *  the registry self-cleaning over time without a separate sweep job.
 *
 *  Caller can inject a custom `isPidAlive` for tests. */
export function listAliveEntries(
  dataDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): ChannelInfo[] {
  const dir = registryDir(dataDir);
  if (!existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); }
  catch { return []; }
  const alive: ChannelInfo[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    const entry = readEntry(path);
    if (entry === null || entry.pid === null || !isPidAlive(entry.pid)) {
      // Stale entry — GC. Swallow errors (race with another GC pass).
      try { unlinkSync(path); } catch { /* ignore */ }
      continue;
    }
    alive.push(entry);
  }
  // Sort oldest-startedAt first. Entries without startedAt sink to
  // the end so a legitimate entry always wins over a malformed one.
  alive.sort((a, b) => {
    if (a.startedAt === null && b.startedAt === null) return a.pid! - b.pid!;
    if (a.startedAt === null) return 1;
    if (b.startedAt === null) return -1;
    return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
  });
  return alive;
}

/** Pick the leader (oldest alive entry). Returns null when no entries
 *  exist. Pure — callers pass in the list from `listAliveEntries`. */
export function pickLeader(entries: ChannelInfo[]): ChannelInfo | null {
  if (entries.length === 0) return null;
  // HS-9038 — prefer the oldest MAIN (non-worktree) connection so triggers / the
  // play button route to the main agent, never a distributed worker. `entries` is
  // sorted oldest-first; fall back to the oldest overall if (somehow) only worker
  // connections exist.
  return entries.find(e => e.worktree == null) ?? entries[0];
}

/**
 * HS-8948 / HS-9225 — terminate EVERY alive MAIN channel-server for this
 * dataDir (including the leader) and remove their registry entries. Returns the
 * pids it signaled.
 *
 * The "N Claude connections active" warning fires whenever more than one MAIN
 * channel-server is alive for the project. The extras are usually ORPHANS: a
 * Claude Code instance exited but its spawned MCP channel-server child kept
 * running (not reaped), so its pid stays alive and `listAliveEntries` keeps
 * counting it. Pre-HS-9225 this kept the FIFO leader (oldest) and killed the
 * rest — but the leader the user wants to keep is NOT necessarily the oldest, so
 * cleanup "didn't always land on the right one": triggers could keep routing to
 * a connection the user wasn't looking at. There's no reliable way for the
 * server to know which Claude the human is actually in. So instead of guessing,
 * we disconnect ALL of them and the caller tells the user to run `/mcp` in the
 * Claude instance they want — that reconnect spawns a fresh server that becomes
 * the sole (correct) connection.
 *
 * Distributed-worker connections (`worktree` set) are EXEMPT — they're expected
 * (one per worktree) and killing one would disrupt in-progress worker work
 * (mirrors the "never kill a worker mid-ticket" principle). Only MAIN
 * connections are torn down.
 *
 * `kill` + `isPidAlive` are injectable for tests. Best-effort: a kill that
 * fails (process already gone, permission) is swallowed; the entry is still
 * unlinked so the count drops.
 */
export function disconnectMainConnections(
  dataDir: string,
  opts: { kill?: (pid: number) => void; isPidAlive?: (pid: number) => boolean } = {},
): number[] {
  const kill = opts.kill ?? ((pid: number) => { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } });
  const entries = listAliveEntries(dataDir, opts.isPidAlive);
  const killed: number[] = [];
  // Tear down EVERY main connection (no leader survivor); workers are spared.
  const mains = entries.filter(e => e.worktree == null);
  for (const entry of mains) {
    if (entry.pid === null) continue;
    try { kill(entry.pid); } catch { /* process already gone / not killable — entry is still removed below */ }
    try { unlinkSync(entryPath(dataDir, entry.pid)); } catch { /* race with GC / already gone */ }
    killed.push(entry.pid);
  }
  return killed;
}
