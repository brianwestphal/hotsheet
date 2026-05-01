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
createReadStream, 
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync} from 'fs';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { gunzipSync } from 'zlib';

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
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- `T` is the contract: callers pass the row shape they want and `query<T>(sql)` threads it through to the returned `rows: T[]`. Not a one-shot internal narrowing — drives the public return type.
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
 *
 * HS-8093 — `async` is kept (despite no `await` body today) because the
 * function is part of an evolving backup pipeline where worker-thread or
 * stream-based variants are likely to land; making it sync now would
 * force every caller to flip back to `await` once that happens.
 */
// eslint-disable-next-line @typescript-eslint/require-await
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
 *
 * HS-8093 — see `ensureBlobInStore` for the `async`-without-await
 * rationale; the same evolving-pipeline argument applies here.
 */
// eslint-disable-next-line @typescript-eslint/require-await
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

/**
 * HS-7937 — translate a tarball filename to its JSON co-save sibling.
 * Mirrors `jsonSiblingFilename` from `src/dbJsonExport.ts`. Defined here
 * (instead of imported) to keep `attachmentBackup.ts` independent of the
 * JSON-export module's exports.
 */
function jsonCosaveFilename(tarballFilename: string): string {
  return tarballFilename.replace(/\.tar\.gz$/, '.json.gz');
}

interface JsonCosaveAttachmentRow {
  id: number;
  ticket_id: number;
  original_filename: string;
  stored_path: string;
}

interface JsonCosave {
  schemaVersion?: number;
  exportedAt?: string;
  // HS-8093 — typed as `unknown[]` (not `JsonCosaveAttachmentRow[]`)
  // because the JSON co-save is parsed from disk and could be
  // malformed (truncated write, hand-edited, version drift). The
  // per-row predicate in `readJsonCosaveAttachmentRows` is the trust
  // boundary that narrows individual entries to the structured shape.
  tables?: { attachments?: unknown[] };
}

/**
 * Read + ungzip + parse a `.json.gz` co-save's `attachments` rows. Returns
 * `null` on any failure (missing file, malformed gzip / JSON, missing
 * tables key) — callers treat that as "rebuild not possible from this
 * cosave".
 */
function readJsonCosaveAttachmentRows(jsonCosavePath: string): JsonCosaveAttachmentRow[] | null {
  if (!existsSync(jsonCosavePath)) return null;
  try {
    const buf = readFileSync(jsonCosavePath);
    const json = gunzipSync(buf).toString('utf-8');
    const raw = JSON.parse(json) as JsonCosave;
    const rows = raw.tables?.attachments;
    if (!Array.isArray(rows)) return null;
    return rows.filter((r): r is JsonCosaveAttachmentRow => {
      if (typeof r !== 'object' || r === null) return false;
      const o = r as Record<string, unknown>;
      return typeof o.id === 'number'
        && typeof o.ticket_id === 'number'
        && typeof o.original_filename === 'string'
        && typeof o.stored_path === 'string';
    });
  } catch {
    return null;
  }
}

/**
 * HS-7937 — index every existing manifest by `attachmentId → {sha, storedName, size}` so a
 * rebuild can recover an entry whose live file is gone but whose blob is
 * referenced by a sibling backup's manifest. Returns the union of all
 * mappings; if multiple manifests carry the same attachmentId with
 * different shas, the most recently scanned wins (cheap deterministic
 * choice — the rebuild path is best-effort).
 */
function indexExistingManifestEntries(backupRoot: string): Map<number, { sha: string; storedName: string; size: number }> {
  const out = new Map<number, { sha: string; storedName: string; size: number }>();
  for (const tier of ['5min', 'hourly', 'daily']) {
    const tierPath = join(backupRoot, tier);
    if (!existsSync(tierPath)) continue;
    for (const name of readdirSync(tierPath)) {
      if (!name.endsWith('.attachments.json')) continue;
      const m = readManifest(join(tierPath, name));
      if (m === null) continue;
      for (const e of m.entries) {
        out.set(e.attachmentId, { sha: e.sha, storedName: e.storedName, size: e.size });
      }
    }
  }
  return out;
}

/**
 * HS-7937 — rebuild a single tarball's manifest from its `.json.gz`
 * co-save sibling + on-disk hashing of any still-live attachments. Best-
 * effort: rows whose live file is missing fall back to the cross-reference
 * index from existing manifests; rows that can't be recovered either way
 * are dropped with a warning.
 */
async function rebuildManifestFromJsonCosave(
  backupRoot: string,
  tarballFilename: string,
  jsonCosavePath: string,
  crossRefIndex: Map<number, { sha: string; storedName: string; size: number }>,
): Promise<AttachmentManifest | null> {
  const rows = readJsonCosaveAttachmentRows(jsonCosavePath);
  if (rows === null) return null;

  const blobsDir = attachmentBlobsDir(backupRoot);
  const entries: AttachmentManifestEntry[] = [];
  for (const row of rows) {
    let sha: string | null = null;
    let size: number | null = null;
    let storedName: string;
    if (existsSync(row.stored_path)) {
      try {
        const hashed = await hashFile(row.stored_path);
        sha = hashed.sha;
        size = hashed.size;
        await ensureBlobInStore(blobsDir, row.stored_path, sha);
        storedName = basename(row.stored_path);
      } catch (err) {
        console.error(`[attachmentBackup] reanalyze: hash failed for ${row.stored_path}:`, err);
      }
    }
    if (sha === null) {
      // Live file gone — try the cross-reference index.
      const xref = crossRefIndex.get(row.id);
      if (xref !== undefined && existsSync(join(blobsDir, xref.sha))) {
        sha = xref.sha;
        size = xref.size;
        storedName = xref.storedName;
      } else {
        console.warn(`[attachmentBackup] reanalyze: dropping attachment ${row.id} (${row.original_filename}) — live file missing and no cross-ref blob in store`);
        continue;
      }
    }
    entries.push({
      attachmentId: row.id,
      ticketId: row.ticket_id,
      originalName: row.original_filename,
      storedName: storedName!,
      sha: sha,
      size: size!,
    });
  }

  return {
    schemaVersion: ATTACHMENT_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    tarball: tarballFilename,
    entries,
  };
}

/**
 * HS-7937 — startup pass: walk every tarball under
 * `<backupRoot>/{5min,hourly,daily}/`, find any without an
 * `.attachments.json` manifest sibling, and rebuild the manifest for ones
 * older than `minTarballAgeMs` (default 24h). Younger tarballs are skipped
 * to avoid hashing live attachments on every boot — a manifest will be
 * written by the next normal backup or by the explicit failure-recovery
 * path before the 24h window elapses.
 *
 * Returns `{ rebuilt, skipped, failed }`. The function never throws; per-
 * tarball failures are logged and counted.
 */
export async function reanalyzeMissingManifests(
  backupRoot: string,
  options: { now?: number; minTarballAgeMs?: number } = {},
): Promise<{ rebuilt: number; skipped: number; failed: number }> {
  const now = options.now ?? Date.now();
  const minAge = options.minTarballAgeMs ?? 24 * 60 * 60 * 1000;

  const crossRefIndex = indexExistingManifestEntries(backupRoot);
  let rebuilt = 0;
  let skipped = 0;
  let failed = 0;

  for (const tier of ['5min', 'hourly', 'daily']) {
    const tierPath = join(backupRoot, tier);
    if (!existsSync(tierPath)) continue;
    for (const name of readdirSync(tierPath)) {
      if (!name.endsWith('.tar.gz')) continue;
      const tarballPath = join(tierPath, name);
      const manifestPath = join(tierPath, manifestSiblingFilename(name));
      if (existsSync(manifestPath)) continue;

      let mtimeMs: number;
      try { mtimeMs = statSync(tarballPath).mtimeMs; } catch { failed++; continue; }
      if (now - mtimeMs < minAge) { skipped++; continue; }

      const jsonCosavePath = join(tierPath, jsonCosaveFilename(name));
      try {
        const manifest = await rebuildManifestFromJsonCosave(backupRoot, name, jsonCosavePath, crossRefIndex);
        if (manifest === null) {
          console.warn(`[attachmentBackup] reanalyze: cannot rebuild manifest for ${tarballPath} — JSON co-save missing or unreadable`);
          failed++;
          continue;
        }
        writeManifestAtomically(manifestPath, manifest);
        // Surface it in the index so later iterations in this same pass
        // can cross-reference it.
        for (const e of manifest.entries) {
          crossRefIndex.set(e.attachmentId, { sha: e.sha, storedName: e.storedName, size: e.size });
        }
        rebuilt++;
      } catch (err) {
        console.error(`[attachmentBackup] reanalyze failed for ${tarballPath}:`, err);
        failed++;
      }
    }
  }
  return { rebuilt, skipped, failed };
}
