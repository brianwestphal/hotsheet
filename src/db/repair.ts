import { cpSync, type Dirent, existsSync, mkdirSync, promises as fsp, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { listBackups } from '../backup.js';
import { execFileAsync } from '../utils/execAsync.js';
import { createPglite } from './pglite.js';

/** HS-7897: server-side repair helpers used by the Settings → Backups
 *  → Database Repair panel. Two flows:
 *
 *  1. **Find a working backup** — iterate every tarball newest-first,
 *     `loadDataDir` it into a temp PGLite instance, and return the
 *     first one that opens cleanly. Deals with the 2026-04-27 incident
 *     pattern where a run of consecutive backups are bad and the user
 *     can't tell from the filename which is recoverable.
 *  2. **Run pg_resetwal** — copy the corrupt directory aside, run the
 *     system `pg_resetwal -f` against the copy, then re-dump the
 *     repaired directory as a fresh tarball in the 5-min tier so the
 *     user can restore via the existing flow. Cross-platform: scans
 *     known install locations on macOS / Linux / Windows. Falls back
 *     to a platform-specific install dialog when the binary isn't
 *     reachable.
 */


export interface WorkingBackup {
  tier: string;
  filename: string;
  ticketCount: number;
  createdAt: string;
}

/** Iterate `listBackups(dataDir)` newest-first and return the first
 *  tarball whose `loadDataDir` succeeds + has a readable `tickets`
 *  table. Returns null if no tarball loads. */
export async function findWorkingBackup(dataDir: string): Promise<WorkingBackup | null> {
  const backups = await listBackups(dataDir);
  for (const backup of backups) {
    const filePath = join(dataDir, 'backups', backup.tier, backup.filename);
    if (!existsSync(filePath)) continue;
    const tempDir = join(tmpdir(), `hs-validate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const buffer = readFileSync(filePath);
      const blob = new Blob([buffer]);
      const db = createPglite(tempDir, { loadDataDir: blob });
      await db.waitReady;
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tickets WHERE status != 'deleted'`
      );
      const ticketCount = parseInt(result.rows[0]?.count ?? '0', 10);
      await db.close();
      return {
        tier: backup.tier,
        filename: backup.filename,
        ticketCount,
        createdAt: backup.createdAt,
      };
    } catch {
      // Tarball failed to load — try the next one.
    } finally {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return null;
}

export interface InstallInstructions {
  description: string;
  command: string;
  url: string;
}

/** Pure helper: produce the platform-appropriate install hint shown
 *  when `pg_resetwal` is not on PATH. Cross-platform per HS-7897
 *  feedback. Exported separately for unit tests so each branch is
 *  pinned. */
export function installInstructions(platform: NodeJS.Platform): InstallInstructions {
  if (platform === 'darwin') {
    return {
      description: 'macOS (via Homebrew)',
      command: 'brew install postgresql@17',
      url: 'https://www.postgresql.org/download/macosx/',
    };
  }
  if (platform === 'linux') {
    return {
      description: 'Linux',
      command: 'sudo apt install postgresql-17  # Debian/Ubuntu\n# or: sudo dnf install postgresql17  # Fedora/RHEL',
      url: 'https://www.postgresql.org/download/linux/',
    };
  }
  if (platform === 'win32') {
    return {
      description: 'Windows',
      command: 'Download the EnterpriseDB installer for PostgreSQL 17',
      url: 'https://www.postgresql.org/download/windows/',
    };
  }
  return {
    description: 'Other',
    command: 'Install PostgreSQL 17 — see download links',
    url: 'https://www.postgresql.org/download/',
  };
}

/** Candidate paths to probe for `pg_resetwal` on each platform.
 *  Exported for testing. The bare `pg_resetwal` entry relies on PATH
 *  and is tried first; the others cover the most common install
 *  layouts so users who installed via the platform's package manager
 *  don't have to hand-edit PATH. */
export function candidatePgResetwalPaths(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      'pg_resetwal',
      '/opt/homebrew/opt/postgresql@17/bin/pg_resetwal',
      '/usr/local/opt/postgresql@17/bin/pg_resetwal',
      '/Applications/Postgres.app/Contents/Versions/17/bin/pg_resetwal',
    ];
  }
  if (platform === 'linux') {
    return [
      'pg_resetwal',
      '/usr/lib/postgresql/17/bin/pg_resetwal',
      '/usr/pgsql-17/bin/pg_resetwal',
    ];
  }
  if (platform === 'win32') {
    return [
      'pg_resetwal.exe',
      'C:\\Program Files\\PostgreSQL\\17\\bin\\pg_resetwal.exe',
    ];
  }
  return ['pg_resetwal'];
}

export interface ResetwalAvailability {
  available: boolean;
  path: string | null;
  platform: NodeJS.Platform;
  installInstructions: InstallInstructions;
}

/**
 * The PostgreSQL major PGLite writes, and therefore the only `pg_resetwal`
 * major that can operate on one of our clusters. Only a FALLBACK: when a real
 * candidate directory is in hand, `getResetwalAvailability` reads that
 * cluster's own `PG_VERSION` instead, so a preserved directory written by an
 * older PGLite is still matched against the right binary. Bump alongside a
 * PGLite upgrade that changes `PG_VERSION`.
 */
export const PGLITE_PG_MAJOR = 17;

/** Major version out of `pg_resetwal --version` output, e.g.
 *  `pg_resetwal (PostgreSQL) 18.3 (Homebrew)` → 18. Null when unparseable. */
export function parsePgResetwalMajor(versionOutput: string): number | null {
  const m = /\)\s*(\d+)/.exec(versionOutput) ?? /(\d+)\.\d+/.exec(versionOutput);
  if (m === null) return null;
  const major = Number(m[1]);
  return Number.isFinite(major) ? major : null;
}

/** The version of the cluster we would be repairing. Falls back to the compiled
 *  constant when the directory is absent or unreadable — the guard exists to
 *  reject a KNOWN mismatch, not to refuse when it cannot tell. */
function clusterMajorFor(dataDir: string | undefined): number {
  if (dataDir === undefined) return PGLITE_PG_MAJOR;
  try {
    const raw = readFileSync(join(dataDir, 'PG_VERSION'), 'utf-8').trim();
    const major = Number(raw.split('.')[0]);
    return Number.isFinite(major) ? major : PGLITE_PG_MAJOR;
  } catch {
    return PGLITE_PG_MAJOR;
  }
}

/**
 * Probe each candidate path until one is BOTH runnable and the right major
 * version.
 *
 * HS-9578 — "the binary exists" was the wrong question. `pg_resetwal` refuses a
 * cluster written by a different major outright (`data directory is of wrong
 * version`), and the bare `pg_resetwal` entry is tried FIRST, so any machine
 * with a newer Postgres on PATH — the common case; Homebrew's `postgresql`
 * formula is 18 now — reported "available", pointed at a binary that can never
 * work, and then failed on every probe. The user saw candidates stuck on
 * "checking…" with no explanation, because `probeCorruptCluster` reports an
 * unopenable candidate as `null` rather than as an error.
 *
 * Falling through to the version-pinned paths fixes it on exactly the machines
 * that were broken: they usually have the right major installed too, just not
 * first on PATH.
 *
 * `corruptPath` is optional so callers that only want "is this possible at all"
 * still work; when given, the check is against that cluster's real `PG_VERSION`
 * rather than the constant.
 */
export async function getResetwalAvailability(corruptPath?: string): Promise<ResetwalAvailability> {
  const platform = process.platform;
  const wantedMajor = clusterMajorFor(corruptPath);
  for (const candidate of candidatePgResetwalPaths(platform)) {
    try {
      const { stdout } = await execFileAsync(candidate, ['--version'], { timeout: 5000 });
      const major = parsePgResetwalMajor(stdout);
      // An unparseable version is accepted: a binary we cannot classify is
      // better than none, and the repair itself will report the real error.
      if (major !== null && major !== wantedMajor) continue;
      return { available: true, path: candidate, platform, installInstructions: installInstructions(platform) };
    } catch {
      // Try the next candidate.
    }
  }
  return { available: false, path: null, platform, installInstructions: installInstructions(platform) };
}

export interface RepairResult {
  tier: string;
  filename: string;
  ticketCount: number;
  sizeBytes: number;
}

/** Copy `corruptPath` to a temp directory, run `pg_resetwal -f` on the
 *  copy, validate it opens, and dump it as a fresh `.tar.gz` into the
 *  dataDir's `backups/5min/` tier. Returns the new backup's metadata
 *  so the client can navigate the user straight to Restore. The
 *  original `corruptPath` is left untouched. */
export async function runResetwalAndDump(
  dataDir: string,
  corruptPath: string,
): Promise<RepairResult> {
  if (!existsSync(corruptPath)) {
    throw new Error(`Corrupt directory not found: ${corruptPath}`);
  }
  // HS-9578 — resolve against THIS cluster's version, not the compiled default.
  const availability = await getResetwalAvailability(corruptPath);
  if (!availability.available || availability.path === null) {
    throw new Error(`No pg_resetwal matching this database's PostgreSQL version is installed (platform: ${availability.platform})`);
  }

  const workDir = join(tmpdir(), `hs-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cpSync(corruptPath, workDir, { recursive: true });
  // Drop a stale lock file before running pg_resetwal so it doesn't
  // refuse to operate on what it sees as a "still running" cluster.
  try { rmSync(join(workDir, 'postmaster.pid'), { force: true }); } catch { /* ignore */ }

  try {
    await execFileAsync(availability.path, ['-f', workDir], { timeout: 60_000 });

    const db = createPglite(workDir);
    await db.waitReady;
    await db.exec('CHECKPOINT');
    const blob = await db.dumpDataDir('gzip');
    let ticketCount = 0;
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tickets WHERE status != 'deleted'`
      );
      ticketCount = parseInt(result.rows[0]?.count ?? '0', 10);
    } catch { /* schema may differ; non-fatal */ }
    await db.close();

    const buffer = Buffer.from(await blob.arrayBuffer());
    const ts = new Date().toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
    const filename = `backup-${ts}.tar.gz`;
    const tier = '5min';
    const tierDir = join(dataDir, 'backups', tier);
    mkdirSync(tierDir, { recursive: true });
    const tarballPath = join(tierDir, filename);
    writeFileSync(tarballPath, buffer);

    return { tier, filename, ticketCount, sizeBytes: buffer.length };
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** HS-9575 — one preserved `db-corrupt-*` directory, as offered to the user. */
export interface CorruptCluster {
  /** Absolute path. */
  path: string;
  /** Directory name, e.g. `db-corrupt-1785836790764`. */
  name: string;
  modifiedAt: string;
  sizeBytes: number;
  /** Whether it looks like an initialized cluster at all (`PG_VERSION` present).
   *  A false here is the 0-byte-directory case that misled the 2026-08-04
   *  recovery — worth showing as "nothing to recover" rather than offering it. */
  looksLikeCluster: boolean;
  /** Tickets recoverable from it, or null when not probed yet / not knowable. */
  recoverableTicketCount: number | null;
}

/**
 * Enumerate every preserved corrupt cluster in `dataDir`, newest first.
 *
 * Before this, the repair flow could only ever offer the ONE directory named by
 * `.db-recovery-marker.json`. That marker is written at the END of recovery, so
 * a recovery that died partway (HS-9572) leaves the PREVIOUS incident's marker
 * in place — and on 2026-08-04 that pointed at a 0-byte directory while the one
 * holding 432 tickets sat beside it, unreferenced and unofferable.
 *
 * Metadata only, so it stays fast: a `readdir` plus a `stat` per entry. The
 * expensive part (actually recovering each candidate to count its tickets) is
 * `probeCorruptCluster`, called per candidate so the list can render first.
 */
export async function listCorruptClusters(dataDir: string): Promise<CorruptCluster[]> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(dataDir)).filter((n) => n.startsWith('db-corrupt-'));
  } catch {
    return [];
  }

  const out: CorruptCluster[] = [];
  for (const name of entries) {
    const path = join(dataDir, name);
    try {
      const st = await fsp.stat(path);
      if (!st.isDirectory()) continue;
      out.push({
        path,
        name,
        modifiedAt: st.mtime.toISOString(),
        sizeBytes: await directorySize(path),
        looksLikeCluster: existsSync(join(path, 'PG_VERSION')),
        recoverableTicketCount: null,
      });
    } catch {
      // Vanished or unreadable between readdir and stat — skip it rather than
      // failing the whole enumeration.
    }
  }
  out.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return out;
}

/** Recursive size, bounded to one level of recursion depth per call. Used only
 *  to show the user roughly how much is in each candidate. */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    try {
      if (e.isDirectory()) total += await directorySize(p);
      else total += (await fsp.stat(p)).size;
    } catch { /* skip unreadable entries */ }
  }
  return total;
}

/**
 * Guard for a client-supplied corrupt-cluster path.
 *
 * The repair endpoints take a path from the browser and hand it to `cpSync` and
 * `pg_resetwal`, so it must be proven to be one of OUR preserved directories —
 * not a traversal, not a symlink out, not an arbitrary directory on the box.
 * Resolving both sides and requiring an exact match against an enumerated
 * candidate is the check; a `startsWith` on the raw string would not be.
 */
export async function resolveCorruptCluster(dataDir: string, requested: string): Promise<string | null> {
  const wanted = resolve(requested);
  const candidates = await listCorruptClusters(dataDir);
  return candidates.some((c) => resolve(c.path) === wanted) ? wanted : null;
}

/**
 * Recover a candidate far enough to count what it holds: copy it aside, run
 * `pg_resetwal -f`, open it, `COUNT(*)`. This is the same work `runResetwalAndDump`
 * does — it just throws away the result instead of dumping a tarball, so the user
 * can see which directory is worth repairing BEFORE choosing one.
 *
 * Returns null when the candidate cannot be opened at all. That is a real answer
 * ("nothing recoverable here"), not an error, and it is the one the 2026-08-04
 * marker would have produced for the directory it named.
 */
export async function probeCorruptCluster(corruptPath: string): Promise<number | null> {
  if (!existsSync(join(corruptPath, 'PG_VERSION'))) return null;
  const availability = await getResetwalAvailability(corruptPath);
  if (!availability.available || availability.path === null) return null;

  const workDir = join(tmpdir(), `hs-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cpSync(corruptPath, workDir, { recursive: true });
  try { rmSync(join(workDir, 'postmaster.pid'), { force: true }); } catch { /* ignore */ }
  try {
    await execFileAsync(availability.path, ['-f', workDir], { timeout: 60_000 });
    const db = createPglite(workDir);
    try {
      await db.waitReady;
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM tickets WHERE status != 'deleted'`
      );
      return parseInt(result.rows[0]?.count ?? '0', 10);
    } finally {
      await db.close();
    }
  } catch {
    return null;
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
