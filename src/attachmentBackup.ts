/**
 * HS-7929 — attachment-backup pipeline.
 *
 * Companion to `src/backup.ts` (PGLite tarball, HS-7891 hardening) and
 * `src/dbJsonExport.ts` (HS-7893 JSON co-save). Closes the gap left by both:
 * neither carries the binary blobs under `.hotsheet/attachments/`, only the
 * `attachments` table rows.
 *
 * Design: see `docs/43-attachment-backups.md`. Hash-addressed centralized
 * store at `<backupRoot>/attachments/<sha256-hex>` + per-backup
 * `backup-<TS>.attachments.json` manifest sibling. Daily orphan GC walks the
 * union of every manifest's `entries[].sha` and deletes anything outside
 * that set.
 *
 * All filesystem helpers are streaming to keep memory bounded — a 200 MB
 * attachment must never blow up the heap.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fsp,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'fs';
import type { FileHandle } from 'fs/promises';
import { dirname, join } from 'path';
import { gunzipSync } from 'zlib';
import { z } from 'zod';

import { hashFileOffThread } from './hashWorker.js';

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
 * Hash a file → `{ sha, size }`. HS-8728 — delegates to a worker thread
 * (`hashFileOffThread`) so the SHA-256 CPU + file read run OFF the main event
 * loop entirely; it falls back to an in-process streaming hash when no worker is
 * available. Streaming on both paths keeps memory bounded regardless of blob
 * size — a 200 MB attachment never lands in a single ArrayBuffer. (Pre-HS-8728
 * this was the in-process streaming implementation, now `hashFileInProcess` in
 * `hashWorker.ts`.)
 */
export async function hashFile(path: string): Promise<{ sha: string; size: number }> {
  return hashFileOffThread(path);
}

/**
 * Return the directory holding the centralized hash-addressed blob pool
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
 * HS-8178 — every disk-touching call is the `fs.promises` async variant
 * so the operation runs on libuv's threadpool instead of blocking the
 * main event loop. The `copyFile` fallback in particular can stall for
 * tens of seconds on a Google-Drive `backupDir` (HS-8174 candidate 2);
 * keeping it on the main thread froze every WS message + PGLite query
 * + HTTP route until the kernel returned. The hash-addressed
 * de-duplication still skips re-copies of unchanged blobs so most
 * backup ticks don't even reach the slow path.
 */
export async function ensureBlobInStore(
  blobsDir: string,
  srcPath: string,
  sha: string,
): Promise<boolean> {
  await fsp.mkdir(blobsDir, { recursive: true });
  const finalPath = join(blobsDir, sha);
  // HS-8178 — `fsp.access` raises on missing-file, so use a try/catch
  // probe instead of the sync `existsSync` to keep the whole function
  // off the main thread. The race window is the same as the prior
  // `existsSync + linkSync` pattern.
  try {
    await fsp.access(finalPath);
    return false; // already in store
  } catch { /* not present — fall through to write */ }

  const tmpPath = `${finalPath}.tmp`;
  try { await fsp.rm(tmpPath, { force: true }); } catch { /* ignore */ }

  try {
    await fsp.link(srcPath, tmpPath);
  } catch (linkErr) {
    // EXDEV (cross-device) or any other failure → fall back to copy.
    try { await fsp.rm(tmpPath, { force: true }); } catch { /* ignore */ }
    try {
      await fsp.copyFile(srcPath, tmpPath);
    } catch (copyErr) {
      // Surface the copy error (more actionable) but log the link error too.
      console.error('[attachmentBackup] link failed:', linkErr);
      throw copyErr;
    }
  }

  // Atomic rename so a crash never leaves a half-written file at the final
  // path. Cleanup of the tmp on rename failure mirrors the JSON co-save's
  // pattern in `dbJsonExport.ts`.
  try {
    await fsp.rename(tmpPath, finalPath);
  } catch (renameErr) {
    try { await fsp.rm(tmpPath, { force: true }); } catch { /* ignore */ }
    throw renameErr;
  }
  return true;
}

/**
 * Atomic write of a JSON manifest. Mirrors `writeJsonExportAtomically` in
 * `src/dbJsonExport.ts` — tmp + write + fsync + close + rename.
 * A crash mid-write leaves either the prior manifest or no manifest, never
 * a partial.
 *
 * HS-8178 — async via `fs.promises` so the fsync runs on libuv's
 * threadpool instead of blocking the main event loop on a slow
 * `backupDir` (Google Drive, NFS, etc.). Same rationale as
 * `writeJsonExportAtomically`.
 */
export async function writeManifestAtomically(path: string, manifest: AttachmentManifest): Promise<void> {
  const json = JSON.stringify(manifest, null, 2) + '\n';
  const buffer = Buffer.from(json, 'utf-8');
  const tmpPath = `${path}.tmp`;
  try { await fsp.rm(tmpPath, { force: true }); } catch { /* ignore */ }
  let handle: FileHandle | null = null;
  try {
    handle = await fsp.open(tmpPath, 'w');
    await handle.write(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tmpPath, path);
  } catch (err) {
    if (handle !== null) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fsp.rm(tmpPath, { force: true }); } catch { /* ignore */ }
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
/**
 * HS-8359 — yield to the event loop between async hot-path iterations.
 * `await new Promise<void>(resolve => setImmediate(resolve))` flushes the
 * I/O phase + timers + the heartbeat watchdog before the next iteration
 * starts, so a long sequence of CPU-bound `hashFile` calls in the manifest
 * builder doesn't starve WS frames / HTTP handlers / freeze-log heartbeats
 * across the whole backup window. Each individual `hashFile` still blocks
 * the loop for ITS chunk-hash duration (streaming SHA-256's `update(chunk)`
 * is on-loop work between async I/O yields) — option 2 of the HS-8359
 * decision; HS-8728 captures the option-1 worker-thread design for the
 * full-fix follow-up if measurement post-deploy shows option 2 is
 * insufficient. (Earlier revisions cited HS-8364 here — that ticket is
 * actually the kerfjs-0.6.0 upgrade; the reference was stale.)
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/**
 * HS-8825 — attachment ids already warned about as "missing on disk and
 * unrecoverable" during this process. The orphan self-heal that prunes / restores
 * these rows (`cleanupOrphanedAttachments`) only runs once at startup, but the
 * backup runs every ~5 min. Pre-fix, a file deleted out-of-band mid-session
 * therefore re-logged the same warning on EVERY backup tick for the rest of a
 * (potentially days-long) session. We now (1) attempt an inline self-heal from
 * the backup store before warning, and (2) warn at most once per id per process
 * for the genuinely-unrecoverable remainder — the next restart's cleanup prunes
 * them. Reset via `_resetMissingAttachmentWarningsForTests`.
 */
const warnedMissingAttachmentIds = new Set<number>();

/** Test-only — clear the per-process "already warned" set so a vitest
 *  file (single process, many cases) can assert the once-per-id dedupe
 *  without cross-test leakage. */
export function _resetMissingAttachmentWarningsForTests(): void {
  warnedMissingAttachmentIds.clear();
}

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
  const missingIds: number[] = [];
  // HS-8825 — built lazily on the first missing file: an index of every
  // existing manifest's `attachmentId → {sha,…}` so the inline self-heal can
  // recover a file whose blob is still in the backup store.
  let crossRefIndex: Map<number, { sha: string; storedName: string; size: number }> | null = null;
  for (const row of result.rows) {
    if (!existsSync(row.stored_path)) {
      // HS-8825 — attempt an inline self-heal from the backup store before
      // giving up. Pre-fix the only self-heal ran once at startup
      // (`cleanupOrphanedAttachments`); a file deleted out-of-band mid-session
      // therefore stayed missing — and re-logged the warning — on EVERY 5-min
      // backup for the rest of the session. If the content is still in the
      // hash-addressed store we copy it back to `stored_path` and fall through
      // to capture it in THIS manifest; otherwise it's genuinely unrecoverable
      // (the next restart's cleanup prunes the row).
      crossRefIndex ??= indexExistingManifestEntries(backupRoot);
      const xref = crossRefIndex.get(row.id);
      let healed = false;
      if (xref !== undefined && existsSync(join(blobsDir, xref.sha))) {
        healed = await restoreAttachmentBlob(blobsDir, xref.sha, row.stored_path) && existsSync(row.stored_path);
      }
      if (!healed) {
        // HS-8783 — aggregate instead of one warn per row.
        missingIds.push(row.id);
        continue;
      }
      // fall through — the file is back on disk; hash + capture it below.
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
    // HS-8359 — drain pending I/O + timers between attachments so the
    // freeze-log heartbeat / WS frames / HTTP requests aren't starved
    // across a multi-file backup window.
    await yieldToEventLoop();
  }
  if (missingIds.length > 0) {
    // HS-8825 — only warn for ids not already reported this process. The
    // self-heal above recovers anything still in the backup store, so what
    // reaches here is genuinely unrecoverable and won't change between
    // backup ticks; logging it once (rather than every 5 min) is enough.
    const fresh = missingIds.filter(id => !warnedMissingAttachmentIds.has(id));
    for (const id of missingIds) warnedMissingAttachmentIds.add(id);
    if (fresh.length > 0) {
      const shown = fresh.slice(0, 20).join(', ');
      const more = fresh.length > 20 ? `, …(+${String(fresh.length - 20)} more)` : '';
      console.warn(`[attachmentBackup] ${String(fresh.length)} attachment(s) missing on disk and unrecoverable from backups (excluded from this backup): ids ${shown}${more}`);
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
  let scanned = 0;
  for (const p of manifestPaths) {
    const m = readManifest(p);
    if (m === null) {
      console.warn(`[attachmentBackup] GC: failed to parse ${p} — aborting GC to avoid orphaning live data`);
      parseFailure = true;
      break;
    }
    for (const e of m.entries) liveShas.add(e.sha);
    // HS-8727 (load resilience, docs/75 §75.6 Phase 5) — yield between manifests
    // so building the live-sha reference set can't starve the loop.
    if (++scanned % 25 === 0) await yieldToEventLoop();
  }
  if (parseFailure) {
    return { deleted: 0, bytesReclaimed: 0, scannedManifests: manifestPaths.length, skippedDueToParseFailure: true };
  }

  let deleted = 0;
  let bytesReclaimed = 0;
  // HS-8727 — the manifest BUILD already yields between files (HS-8359); this
  // closes the matching gap on the GC delete side. Async `readdir` + per-blob
  // `stat`/`rm` run on libuv's threadpool, and a periodic `yieldToEventLoop()`
  // flushes the heartbeat / WS frames / HTTP handlers, so sweeping a blob store
  // with thousands of orphans can't block the event loop.
  const blobNames = await fsp.readdir(blobsDir);
  let iterated = 0;
  for (const name of blobNames) {
    if (++iterated % 500 === 0) await yieldToEventLoop();
    if (name.endsWith('.tmp')) continue; // in-flight write; leave alone
    if (liveShas.has(name)) continue;
    const p = join(blobsDir, name);
    let size = 0;
    try { size = (await fsp.stat(p)).size; } catch { /* ignore */ }
    try {
      await fsp.rm(p, { force: true });
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

/**
 * HS-8802 — self-heal a single attachment whose live file is gone but whose
 * content is still in the backup store. Copies the blob at `<blobsDir>/<sha>`
 * back to `destPath` (the row's `stored_path`), creating the parent dir if
 * needed. Returns `true` on a successful restore, `false` if the blob is absent
 * or the copy fails (the caller then leaves the row alone to retry next sweep).
 *
 * Unlike `restoreAttachmentsFromManifest`, the caller here has already confirmed
 * the live file is MISSING, so there's no live-collision to suffix around — a
 * direct copy to the original `stored_path` keeps the DB row valid with no
 * `stored_path` rewrite.
 */
export async function restoreAttachmentBlob(blobsDir: string, sha: string, destPath: string): Promise<boolean> {
  const blobPath = join(blobsDir, sha);
  try {
    await fsp.access(blobPath);
  } catch {
    return false; // blob not in store
  }
  try {
    await fsp.mkdir(dirname(destPath), { recursive: true });
    await fsp.copyFile(blobPath, destPath);
    return true;
  } catch (err) {
    console.error(`[attachmentBackup] self-heal restore ${blobPath} → ${destPath} failed:`, err);
    return false;
  }
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

// HS-8567 — zod-validated cosave shape. The row schema is `.loose()` so
// extra columns the JSON happens to carry don't break the parse — only the
// four fields the rebuild actually needs are enforced.
const JsonCosaveAttachmentRowSchema = z.object({
  id: z.number(),
  ticket_id: z.number(),
  original_filename: z.string(),
  stored_path: z.string(),
}).loose();
type JsonCosaveAttachmentRow = z.infer<typeof JsonCosaveAttachmentRowSchema>;

const JsonCosaveSchema = z.object({
  schemaVersion: z.number().optional(),
  exportedAt: z.string().optional(),
  tables: z.object({
    attachments: z.array(z.unknown()).optional(),
  }).loose().optional(),
}).loose();

/**
 * Read + ungzip + parse a `.json.gz` co-save's `attachments` rows. Returns
 * `null` on any failure (missing file, malformed gzip / JSON, missing
 * tables key) — callers treat that as "rebuild not possible from this
 * cosave".
 *
 * HS-8567 — replaces the `JSON.parse(...) as JsonCosave` + hand-rolled
 * per-row predicate with a zod parse. The row-level filter still drops
 * malformed entries individually so a single bad row doesn't kill the
 * whole rebuild.
 */
function readJsonCosaveAttachmentRows(jsonCosavePath: string): JsonCosaveAttachmentRow[] | null {
  if (!existsSync(jsonCosavePath)) return null;
  try {
    const buf = readFileSync(jsonCosavePath);
    const json = gunzipSync(buf).toString('utf-8');
    const rawJson: unknown = JSON.parse(json);
    const cosaveResult = JsonCosaveSchema.safeParse(rawJson);
    if (!cosaveResult.success) return null;
    const rows = cosaveResult.data.tables?.attachments;
    if (!Array.isArray(rows)) return null;
    const out: JsonCosaveAttachmentRow[] = [];
    for (const r of rows) {
      const rowResult = JsonCosaveAttachmentRowSchema.safeParse(r);
      if (rowResult.success) out.push(rowResult.data);
    }
    return out;
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
export function indexExistingManifestEntries(backupRoot: string): Map<number, { sha: string; storedName: string; size: number }> {
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
    // HS-8359 — same yield pattern as `buildAttachmentManifest`. The
    // boot-time reanalyze pass iterates every historical tarball lacking
    // a manifest sibling and hashes its live attachments; on a fresh boot
    // with many historical backups this can run for several seconds —
    // exactly the surface where loop-starvation hurts most.
    await yieldToEventLoop();
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
        await writeManifestAtomically(manifestPath, manifest);
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
