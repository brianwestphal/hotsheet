import { PGlite } from '@electric-sql/pglite';
import { execFile } from 'child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { listBackups } from '../backup.js';

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

const execFileP = promisify(execFile);

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
  const backups = listBackups(dataDir);
  for (const backup of backups) {
    const filePath = join(dataDir, 'backups', backup.tier, backup.filename);
    if (!existsSync(filePath)) continue;
    const tempDir = join(tmpdir(), `hs-validate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    try {
      const buffer = readFileSync(filePath);
      const blob = new Blob([buffer]);
      const db = new PGlite(tempDir, { loadDataDir: blob });
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

/** Probe each candidate path with `--version` until one succeeds. */
export async function getResetwalAvailability(): Promise<ResetwalAvailability> {
  const platform = process.platform;
  for (const candidate of candidatePgResetwalPaths(platform)) {
    try {
      await execFileP(candidate, ['--version'], { timeout: 5000 });
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
  const availability = await getResetwalAvailability();
  if (!availability.available || availability.path === null) {
    throw new Error(`pg_resetwal is not installed (platform: ${availability.platform})`);
  }

  const workDir = join(tmpdir(), `hs-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  cpSync(corruptPath, workDir, { recursive: true });
  // Drop a stale lock file before running pg_resetwal so it doesn't
  // refuse to operate on what it sees as a "still running" cluster.
  try { rmSync(join(workDir, 'postmaster.pid'), { force: true }); } catch { /* ignore */ }

  try {
    await execFileP(availability.path, ['-f', workDir], { timeout: 60_000 });

    const db = new PGlite(workDir);
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
