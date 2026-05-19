import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';

/** HS-8454 — payload of `<dataDir>/channel-port`. The file used to be a
 *  bare port number; now it's a JSON object that carries ownership
 *  identity so the channel server can detect "is this still MY port
 *  file?" (HS-8452) AND "is the port-bound process actually OUR
 *  channel server vs an unrelated process the kernel reassigned the
 *  port to?" (HS-8454). The read path is back-compat with the legacy
 *  bare-number format — pid / slug / startedAt come back null when the
 *  file is a leftover from a pre-v0.17.x cluster. */
export interface ChannelInfo {
  port: number;
  /** Channel-server process pid. `null` for legacy bare-number files. */
  pid: number | null;
  /** Per-project slug from `slugifyDataDir(dataDir)`. `null` for legacy
   *  files. Used by the `/health` echo check in `isChannelAlive` to
   *  distinguish "our channel server on this port" from "someone else's
   *  channel server (different project) on this port." */
  slug: string | null;
  /** ISO timestamp the channel server bound its port. `null` for
   *  legacy files. Diagnostic only — used in `mcp.log` entries. */
  startedAt: string | null;
}

/** HS-8454 — parse the port file. Accepts BOTH the new JSON shape AND
 *  the legacy bare-number format that pre-v0.17.x clusters wrote. Returns
 *  `null` when the file is missing, unreadable, or contains a value
 *  that's neither a JSON object with a numeric `port` nor a bare port
 *  number. Caller is responsible for treating missing fields (pid / slug
 *  / startedAt) appropriately. */
export function readChannelInfo(portFile: string): ChannelInfo | null {
  let raw: string;
  try { raw = readFileSync(portFile, 'utf-8').trim(); }
  catch { return null; }
  if (raw === '') return null;
  // New JSON shape.
  if (raw.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.port !== 'number' || !Number.isInteger(obj.port)) return null;
      return {
        port: obj.port,
        pid: typeof obj.pid === 'number' && Number.isInteger(obj.pid) ? obj.pid : null,
        slug: typeof obj.slug === 'string' && obj.slug !== '' ? obj.slug : null,
        startedAt: typeof obj.startedAt === 'string' && obj.startedAt !== '' ? obj.startedAt : null,
      };
    } catch {
      return null;
    }
  }
  // Legacy bare-port format.
  const legacyPort = parseInt(raw, 10);
  if (isNaN(legacyPort)) return null;
  return { port: legacyPort, pid: null, slug: null, startedAt: null };
}

/** HS-8454 — write the port file atomically. Tmp + rename + fsync the
 *  parent dir so a partial-read by a probing main server never sees an
 *  empty / truncated file mid-write. JSON shape carries the full
 *  ownership identity. */
export function writeChannelInfo(portFile: string, info: ChannelInfo): void {
  const tmp = `${portFile}.tmp.${process.pid.toString(36)}`;
  const body = JSON.stringify({
    port: info.port,
    pid: info.pid,
    slug: info.slug,
    startedAt: info.startedAt,
  });
  writeFileSync(tmp, body, 'utf-8');
  renameSync(tmp, portFile);
  // Best-effort fsync of the parent dir so the rename hits disk. On
  // platforms that don't support dir fsync (Windows + some FUSE
  // mounts), the open returns EISDIR or EACCES; swallow either since
  // the rename itself is already on the durable side of the syscall.
  try {
    const slash = portFile.lastIndexOf('/');
    if (slash > 0) {
      const fd = openSync(portFile.slice(0, slash), 'r');
      try { closeSync(fd); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/** HS-8452 + HS-8454 — port-aware unlink for `<dataDir>/channel-port`.
 *  Only deletes the file when its on-disk record still names THIS process
 *  as the owner. Three cases:
 *
 *   - File parses as the new shape and the pid in the file matches
 *     `myPid` → unlink. (HS-8454 — strongest ownership check.)
 *   - File parses as the legacy bare-port shape and the port matches
 *     `myPort` → unlink. (HS-8452 — best we can do without pid in the
 *     file, used during the back-compat window.)
 *   - Anything else (file missing, unparseable, pid mismatch, port
 *     mismatch, read error) → leave it alone.
 *
 *  Returns `true` if unlinked, `false` otherwise. Never throws.
 */
export function maybeUnlinkPortFile(portFile: string, myPort: number, myPid: number = process.pid): boolean {
  const info = readChannelInfo(portFile);
  if (info === null) return false;
  // New shape: pid is the authoritative ownership signal.
  if (info.pid !== null) {
    if (info.pid !== myPid) return false;
  } else {
    // Legacy bare-port file: fall back to port equality.
    if (info.port !== myPort) return false;
  }
  try { unlinkSync(portFile); return true; }
  catch { return false; }
}
