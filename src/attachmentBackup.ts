/**
 * HS-7929 — attachment-backup pipeline.
 *
 * Companion to `src/backup.ts` (PGLite tarball, HS-7891 hardening) and
 * `src/dbJsonExport.ts` (HS-7893 JSON co-save). Closes the gap left by both:
 * neither carries the binary blobs under `.hotsheet/attachments/`, only the
 * `attachments` table rows.
 *
 * Design: see `docs/43-attachment-backups.md`. Hash-addressed centralised
 * store at `<backupRoot>/attachments/<sha256-hex>` + per-backup
 * `backup-<TS>.attachments.json` manifest sibling. Daily orphan GC walks the
 * union of every manifest's `entries[].sha` and deletes anything outside
 * that set.
 *
 * All filesystem helpers are streaming to keep memory bounded — a 200 MB
 * attachment must never blow up the heap.
 */
import { createHash } from 'crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'fs';
import { createReadStream } from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';

/**
 * Manifest schema version. Incremented when the manifest's shape changes
 * (new field, removed field, semantics shift). Future readers compare
 * against this constant to decide whether they can interpret an older
 * manifest as-is.
 */
export const ATTACHMENT_MANIFEST_VERSION = 1;

export interface AttachmentManifestEntry {
  attachmentId: number;
  ticketId: number;
  originalName: string;
  storedName: string;
  sha: string;
  size: number;
}

export interface AttachmentManifest {
  schemaVersion: number;
  createdAt: string;
  tarball: string;
  entries: AttachmentManifestEntry[];
}

/** Minimal DB surface — kept loose so tests can inject a stub without
 *  pulling in PGLite. */
export interface AttachmentRowSource {
  query: <T>(sql: string) => Promise<{ rows: T[] }>;
}

interface AttachmentRow {
  id: number;
  ticket_id: number;
  original_filename: string;
  stored_path: string;
}

/**
 * Compute the manifest filename for a given tarball filename. Mirrors
 * `jsonSiblingFilename` in `src/dbJsonExport.ts`.
 *
 *   backup-2026-04-27T07-00-00Z.tar.gz → backup-2026-04-27T07-00-00Z.attachments.json
 */
export function manifestSiblingFilename(tarballFilename: string): string {
  if (!tarballFilename.endsWith('.tar.gz')) {
    throw new Error(`Expected .tar.gz filename, got: ${tarballFilename}`);
  }
  return `${tarballFilename.slice(0, -'.tar.gz'.length)}.attachments.json`;
}

/**
 * Stream-hash a file → `{ sha, size }`. Pure function over the filesystem.
 * `pipeline(createReadStream, hash)` keeps memory bounded regardless of
 * blob size — a 200 MB attachment hashes through a Node stream and never
 * lands in a single ArrayBuffer.
 */
export async function hashFile(path: string): Promise<{ sha: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    createReadStream(path),
    async function* (source) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    },
    // Sink: just consume the bytes; pipeline needs a writable end.
    async function (source) {
      for await (const _ of source) { /* drain */ }
    },
  );
  return { sha: hash.digest('hex'), size };
}

/**
 * Return the directory holding the centralised hash-addressed blob pool
 * for a given `backupRoot` (typically `<dataDir>/backups/` or a custom
 * `backupDir` per `getBackupDir`).
 */
export function attachmentBlobsDir(backupRoot: string): string {
  return join(backupRoot, 'attachments');
}

/**
 * Ensure the blob at `<blobsDir>/<sha>` exists. If absent, hard-link from
 * `srcPath` first (zero-cost on same filesystem) and fall back to a
 * `copyFile` if linking isn't supported (cross-fs `backupDir`, e.g. Google
 * Drive). Atomic via `<sha>.tmp` + rename so a crash mid-copy never leaves
 * a half-written blob in the addressable namespace.
 *
 * Returns `true` if a new blob was written, `false` if it already existed.
 */
export async function ensureBlobInStore(
  blobsDir: string,
  srcPath: string,
  sha: string,
): Promise<boolean> {
  mkdirSync(blobsDir, { recursive: true });
  const finalPath = join(blobsDir, sha);
  if (existsSync(finalPath)) return false;

  const tmpPath = `${finalPath}.tmp`;
  try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }

  try {
    linkSync(srcPath, tmpPath);
  } catch (linkErr) {
    // EXDEV (cross-device) or any other failure → fall back to copy.
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    try {
      copyFileSync(srcPath, tmpPath);
    } catch (copyErr) {
      // Surface the copy error (more actionable) but log the link error too.
      console.error('[attachmentBackup] linkSync failed:', linkErr);
      throw copyErr;
    }
  }

  // Atomic rename so a crash never leaves a half-written file at the final
  // path. Cleanup of the tmp on rename failure mirrors the JSON co-save's
  // pattern in `dbJsonExport.ts`.
  try {
    renameSync(tmpPath, finalPath);
  } catch (renameErr) {
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw renameErr;
  }
  return true;
}

/**
 * Atomic write of a JSON manifest. Mirrors `writeJsonExportAtomically` in
 * `src/dbJsonExport.ts` — tmp + writeSync + fsyncSync + closeSync + rename.
 * A crash mid-write leaves either the prior manifest or no manifest, never
 * a partial.
 */
export function writeManifestAtomically(path: string, manifest: AttachmentManifest): void {
  const json = JSON.stringify(manifest, null, 2) + '\n';
  const buffer = Buffer.from(json, 'utf-8');
  const tmpPath = `${path}.tmp`;
  try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'w');
    writeSync(fd, buffer);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
    try { rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

/** Read + parse a manifest file. Returns null on missing file or
 *  malformed JSON — callers handle the rebuild path. */
export function readManifest(path: string): AttachmentManifest | null {
  if (!existsSync(path)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    if (!isManifest(raw)) return null;
    return raw;
  } catch {
    return null;
  }
}

function isManifest(raw: unknown): raw is AttachmentManifest {
  if (typeof raw !== 'object' || raw === null) return false;
  const m = raw as Record<string, unknown>;
  if (typeof m.schemaVersion !== 'number') return false;
  if (typeof m.createdAt !== 'string') return false;
  if (typeof m.tarball !== 'string') return false;
  if (!Array.isArray(m.entries)) return false;
  return m.entries.every(isManifestEntry);
}

function isManifestEntry(raw: unknown): raw is AttachmentManifestEntry {
  if (typeof raw !== 'object' || raw === null) return false;
  const e = raw as Record<string, unknown>;
  return typeof e.attachmentId === 'number'
    && typeof e.ticketId === 'number'
    && typeof e.originalName === 'string'
    && typeof e.storedName === 'string'
    && typeof e.sha === 'string'
    && typeof e.size === 'number';
}

/**
 * Build a manifest for a single backup: query every attachments row, hash
 * each live file, ensure its blob is in the store, and assemble the
 * entries array.
 *
 * Rows whose `stored_path` doesn't exist on disk are skipped with a warning.
 * Per the design, those rows already point at a missing file; there's no
 * blob to capture.
 */
export async function buildAttachmentManifest(
  db: AttachmentRowSource,
  backupRoot: string,
  tarballFilename: string,
): Promise<AttachmentManifest> {
  const blobsDir = attachmentBlobsDir(backupRoot);
  const result = await db.query<AttachmentRow>(
    'SELECT id, ticket_id, original_filename, stored_path FROM attachments ORDER BY id',
  );
  const entries: AttachmentManifestEntry[] = [];
  for (const row of result.rows) {
    if (!existsSync(row.stored_path)) {
      console.warn(`[attachmentBackup] attachment ${row.id} (${row.original_filename}) missing on disk: ${row.stored_path}`);
      continue;
    }
    try {
      const { sha, size } = await hashFile(row.stored_path);
      await ensureBlobInStore(blobsDir, row.stored_path, sha);
      const storedName = basename(row.stored_path);
      entries.push({
        attachmentId: row.id,
        ticketId: row.ticket_id,
        originalName: row.original_filename,
        storedName,
        sha,
        size,
      });
    } catch (err) {
      console.error(`[attachmentBackup] failed to capture attachment ${row.id}:`, err);
      // Skip — single attachment failure must not block the whole manifest.
    }
  }
  return {
    schemaVersion: ATTACHMENT_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    tarball: tarballFilename,
    entries,
  };
}

function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Daily GC: walk every manifest under `<backupRoot>/{5min,hourly,daily}/`,
 * union their `entries[].sha`, then delete any blob in
 * `<backupRoot>/attachments/` whose name is NOT in that union.
 *
 * Aborts (no deletions) if any manifest fails to parse — operating on a
 * partial reference set could orphan live data.
 */
export async function runAttachmentGc(backupRoot: string): Promise<{
  deleted: number;
  bytesReclaimed: number;
  scannedManifests: number;
  skippedDueToParseFailure: boolean;
}> {
  const blobsDir = attachmentBlobsDir(backupRoot);
  if (!existsSync(blobsDir)) {
    return { deleted: 0, bytesReclaimed: 0, scannedManifests: 0, skippedDueToParseFailure: false };
  }

  const manifestPaths = collectManifestPaths(backupRoot);
  const liveShas = new Set<string>();
  let parseFailure = false;
  for (const p of manifestPaths) {
    const m = readManifest(p);
    if (m === null) {
      console.warn(`[attachmentBackup] GC: failed to parse ${p} — aborting GC to avoid orphaning live data`);
      parseFailure = true;
      break;
    }
    for (const e of m.entries) liveShas.add(e.sha);
  }
  if (parseFailure) {
    return { deleted: 0, bytesReclaimed: 0, scannedManifests: manifestPaths.length, skippedDueToParseFailure: true };
  }

  let deleted = 0;
  let bytesReclaimed = 0;
  for (const name of readdirSync(blobsDir)) {
    if (name.endsWith('.tmp')) continue; // in-flight write; leave alone
    if (liveShas.has(name)) continue;
    const p = join(blobsDir, name);
    let size = 0;
    try { size = statSync(p).size; } catch { /* ignore */ }
    try {
      rmSync(p, { force: true });
      deleted++;
      bytesReclaimed += size;
    } catch (err) {
      console.error(`[attachmentBackup] GC: failed to delete ${p}:`, err);
    }
  }
  return { deleted, bytesReclaimed, scannedManifests: manifestPaths.length, skippedDueToParseFailure: false };
}

function collectManifestPaths(backupRoot: string): string[] {
  const out: string[] = [];
  for (const tier of ['5min', 'hourly', 'daily']) {
    const tierPath = join(backupRoot, tier);
    if (!existsSync(tierPath)) continue;
    for (const name of readdirSync(tierPath)) {
      if (name.endsWith('.attachments.json')) out.push(join(tierPath, name));
    }
  }
  return out;
}

/** Drop the manifest sibling next to a tarball — called from
 *  `pruneBackups` when a tarball ages out. */
export function deleteManifestSibling(tarballPath: string): void {
  const base = tarballPath.replace(/\.tar\.gz$/, '');
  const path = `${base}.attachments.json`;
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
}

/**
 * Restore — copy each manifest entry's hash blob into
 * `<dataDir>/attachments/<storedName>`. If a live file already exists at
 * that path with DIFFERENT content (different sha), append a
 * `-restored-<TS>` suffix to the storedName so we don't trample whatever
 * the user is actively using.
 *
 * Returns the list of `{ originalStoredName, finalStoredName, sha }` so
 * the caller can update the corresponding `attachments.stored_path` rows.
 */
export async function restoreAttachmentsFromManifest(
  manifest: AttachmentManifest,
  blobsDir: string,
  liveAttachmentsDir: string,
): Promise<Array<{ attachmentId: number; originalStoredName: string; finalStoredName: string; sha: string }>> {
  mkdirSync(liveAttachmentsDir, { recursive: true });
  const out: Array<{ attachmentId: number; originalStoredName: string; finalStoredName: string; sha: string }> = [];
  const ts = formatRestoreTimestamp(new Date());
  for (const e of manifest.entries) {
    const blobPath = join(blobsDir, e.sha);
    if (!existsSync(blobPath)) {
      console.warn(`[attachmentBackup] restore: blob ${e.sha} for attachment ${e.attachmentId} missing — skipping`);
      continue;
    }
    let finalStoredName = e.storedName;
    const livePath = join(liveAttachmentsDir, e.storedName);
    if (existsSync(livePath)) {
      // Compare the live file's hash to the manifest entry's. If they
      // match, no work to do (the live file IS the backed-up content). If
      // they differ, the user has a different file with the same name —
      // suffix to avoid overwriting their work.
      try {
        const { sha: liveSha } = await hashFile(livePath);
        if (liveSha !== e.sha) {
          finalStoredName = appendRestoredSuffix(e.storedName, ts);
        } else {
          out.push({ attachmentId: e.attachmentId, originalStoredName: e.storedName, finalStoredName, sha: e.sha });
          continue;
        }
      } catch {
        // Couldn't hash the live file — be conservative and suffix.
        finalStoredName = appendRestoredSuffix(e.storedName, ts);
      }
    }
    const finalPath = join(liveAttachmentsDir, finalStoredName);
    try {
      copyFileSync(blobPath, finalPath);
      out.push({ attachmentId: e.attachmentId, originalStoredName: e.storedName, finalStoredName, sha: e.sha });
    } catch (err) {
      console.error(`[attachmentBackup] restore: copy ${blobPath} → ${finalPath} failed:`, err);
    }
  }
  return out;
}

function formatRestoreTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function appendRestoredSuffix(storedName: string, ts: string): string {
  const dotIdx = storedName.lastIndexOf('.');
  if (dotIdx === -1) return `${storedName}-restored-${ts}`;
  return `${storedName.slice(0, dotIdx)}-restored-${ts}${storedName.slice(dotIdx)}`;
}
