/**
 * HS-7929 — unit tests for the attachment-backup pipeline.
 *
 * Each test sets up a temp `<backupRoot>` + a temp `liveAttachments` dir,
 * exercises one piece of the pipeline, and asserts both the on-disk shape
 * and the return value of the helper. Streaming hash + atomic-write
 * contracts are pinned down so a future refactor can't quietly regress
 * either.
 */
import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ATTACHMENT_MANIFEST_VERSION,
  attachmentBlobsDir,
  buildAttachmentManifest,
  deleteManifestSibling,
  ensureBlobInStore,
  hashFile,
  manifestSiblingFilename,
  readManifest,
  restoreAttachmentsFromManifest,
  runAttachmentGc,
  writeManifestAtomically,
  type AttachmentManifest,
  type AttachmentRowSource,
} from './attachmentBackup.js';

let backupRoot: string;
let liveAttachmentsDir: string;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hs-attach-'));
  backupRoot = join(dataDir, 'backups');
  liveAttachmentsDir = join(dataDir, 'attachments');
  mkdirSync(backupRoot, { recursive: true });
  mkdirSync(liveAttachmentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function expectedSha(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeStubDb(rows: Array<{ id: number; ticket_id: number; original_filename: string; stored_path: string }>): AttachmentRowSource {
  return {
    query: async <T>() => Promise.resolve({ rows: rows as unknown as T[] }),
  };
}

describe('manifestSiblingFilename', () => {
  it('replaces .tar.gz with .attachments.json', () => {
    expect(manifestSiblingFilename('backup-2026-04-27T07-00-00Z.tar.gz')).toBe('backup-2026-04-27T07-00-00Z.attachments.json');
  });

  it('throws when the input does not end in .tar.gz (defensive)', () => {
    expect(() => manifestSiblingFilename('backup.tgz')).toThrow();
  });
});

describe('hashFile (HS-7929)', () => {
  it('returns the streaming sha256 + size of a small fixture', async () => {
    const path = join(liveAttachmentsDir, 'small.bin');
    const buf = Buffer.from('hello, world');
    writeFileSync(path, buf);
    const out = await hashFile(path);
    expect(out.size).toBe(buf.length);
    expect(out.sha).toBe(expectedSha(buf));
  });

  it('hashes a multi-MB blob without exhausting memory (streaming contract)', async () => {
    const path = join(liveAttachmentsDir, 'big.bin');
    const chunk = Buffer.alloc(1024 * 1024, 0x55);
    const total = Buffer.concat([chunk, chunk, chunk, chunk]);
    writeFileSync(path, total);
    const out = await hashFile(path);
    expect(out.size).toBe(4 * 1024 * 1024);
    expect(out.sha).toBe(expectedSha(total));
  });
});

describe('ensureBlobInStore (HS-7929)', () => {
  it('writes a new blob into the centralised store', async () => {
    const blobsDir = attachmentBlobsDir(backupRoot);
    const src = join(liveAttachmentsDir, 'a.bin');
    const buf = Buffer.from('payload-A');
    writeFileSync(src, buf);
    const sha = expectedSha(buf);
    const wrote = await ensureBlobInStore(blobsDir, src, sha);
    expect(wrote).toBe(true);
    expect(existsSync(join(blobsDir, sha))).toBe(true);
    expect(readFileSync(join(blobsDir, sha)).equals(buf)).toBe(true);
  });

  it('is a no-op when the blob already exists (dedup)', async () => {
    const blobsDir = attachmentBlobsDir(backupRoot);
    const src = join(liveAttachmentsDir, 'a.bin');
    const buf = Buffer.from('payload-A');
    writeFileSync(src, buf);
    const sha = expectedSha(buf);
    expect(await ensureBlobInStore(blobsDir, src, sha)).toBe(true);
    expect(await ensureBlobInStore(blobsDir, src, sha)).toBe(false);
  });

  it('does not leave a `.tmp` orphan after a successful write', async () => {
    const blobsDir = attachmentBlobsDir(backupRoot);
    const src = join(liveAttachmentsDir, 'a.bin');
    writeFileSync(src, 'payload');
    const sha = expectedSha(Buffer.from('payload'));
    await ensureBlobInStore(blobsDir, src, sha);
    const orphans = readdirSync(blobsDir).filter(n => n.endsWith('.tmp'));
    expect(orphans).toEqual([]);
  });
});

describe('writeManifestAtomically + readManifest round-trip', () => {
  it('round-trips a manifest verbatim', () => {
    const path = join(backupRoot, 'manifest.json');
    const manifest: AttachmentManifest = {
      schemaVersion: ATTACHMENT_MANIFEST_VERSION,
      createdAt: '2026-04-27T07:00:00.000Z',
      tarball: 'backup-2026-04-27T07-00-00Z.tar.gz',
      entries: [
        { attachmentId: 1, ticketId: 100, originalName: 's.png', storedName: 'HS-100_s.png', sha: 'abc', size: 42 },
      ],
    };
    writeManifestAtomically(path, manifest);
    expect(readManifest(path)).toEqual(manifest);
  });

  it('readManifest returns null for missing files', () => {
    expect(readManifest(join(backupRoot, 'nope.json'))).toBeNull();
  });

  it('readManifest returns null for malformed JSON without throwing', () => {
    const path = join(backupRoot, 'bad.json');
    writeFileSync(path, 'not valid json {{');
    expect(readManifest(path)).toBeNull();
  });

  it('readManifest returns null when required fields are missing', () => {
    const path = join(backupRoot, 'partial.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }));
    expect(readManifest(path)).toBeNull();
  });
});

describe('buildAttachmentManifest (HS-7929)', () => {
  it('captures every live attachments row + writes its blob into the store', async () => {
    const a1Path = join(liveAttachmentsDir, 'HS-1_a.png');
    const a2Path = join(liveAttachmentsDir, 'HS-2_b.txt');
    writeFileSync(a1Path, 'payload-1');
    writeFileSync(a2Path, 'payload-2');
    const db = makeStubDb([
      { id: 1, ticket_id: 100, original_filename: 'a.png', stored_path: a1Path },
      { id: 2, ticket_id: 200, original_filename: 'b.txt', stored_path: a2Path },
    ]);
    const m = await buildAttachmentManifest(db, backupRoot, 'backup-X.tar.gz');
    expect(m.schemaVersion).toBe(ATTACHMENT_MANIFEST_VERSION);
    expect(m.tarball).toBe('backup-X.tar.gz');
    expect(m.entries).toHaveLength(2);
    expect(m.entries[0]?.sha).toBe(expectedSha(Buffer.from('payload-1')));
    expect(m.entries[0]?.storedName).toBe('HS-1_a.png');
    expect(m.entries[1]?.sha).toBe(expectedSha(Buffer.from('payload-2')));
    const blobsDir = attachmentBlobsDir(backupRoot);
    expect(existsSync(join(blobsDir, m.entries[0]!.sha))).toBe(true);
    expect(existsSync(join(blobsDir, m.entries[1]!.sha))).toBe(true);
  });

  it('skips rows whose `stored_path` is missing on disk (logs warning)', async () => {
    const present = join(liveAttachmentsDir, 'present.bin');
    writeFileSync(present, 'P');
    const db = makeStubDb([
      { id: 1, ticket_id: 1, original_filename: 'p.bin', stored_path: present },
      { id: 2, ticket_id: 2, original_filename: 'g.bin', stored_path: join(liveAttachmentsDir, 'ghost.bin') },
    ]);
    const m = await buildAttachmentManifest(db, backupRoot, 'backup-Y.tar.gz');
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]?.attachmentId).toBe(1);
  });
});

describe('runAttachmentGc (HS-7929)', () => {
  function writeManifestUnder(tier: '5min' | 'hourly' | 'daily', name: string, shas: string[]): void {
    const tierDir = join(backupRoot, tier);
    mkdirSync(tierDir, { recursive: true });
    const manifest: AttachmentManifest = {
      schemaVersion: ATTACHMENT_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      tarball: name.replace('.attachments.json', '.tar.gz'),
      entries: shas.map((sha, idx) => ({
        attachmentId: idx + 1,
        ticketId: 1,
        originalName: 'x.bin',
        storedName: 'x.bin',
        sha,
        size: 42,
      })),
    };
    writeManifestAtomically(join(tierDir, name), manifest);
  }

  function blobAt(sha: string): string {
    const blobsDir = attachmentBlobsDir(backupRoot);
    mkdirSync(blobsDir, { recursive: true });
    const p = join(blobsDir, sha);
    writeFileSync(p, 'blob');
    return p;
  }

  it('reclaims blobs not referenced by any manifest', async () => {
    blobAt('sha-A');
    blobAt('sha-B');
    blobAt('sha-orphan-1');
    blobAt('sha-orphan-2');
    writeManifestUnder('5min', 'backup-1.attachments.json', ['sha-A']);
    writeManifestUnder('hourly', 'backup-2.attachments.json', ['sha-B']);

    const stats = await runAttachmentGc(backupRoot);
    expect(stats.deleted).toBe(2);
    expect(stats.bytesReclaimed).toBeGreaterThan(0);
    expect(stats.skippedDueToParseFailure).toBe(false);
    expect(existsSync(join(attachmentBlobsDir(backupRoot), 'sha-A'))).toBe(true);
    expect(existsSync(join(attachmentBlobsDir(backupRoot), 'sha-B'))).toBe(true);
    expect(existsSync(join(attachmentBlobsDir(backupRoot), 'sha-orphan-1'))).toBe(false);
    expect(existsSync(join(attachmentBlobsDir(backupRoot), 'sha-orphan-2'))).toBe(false);
  });

  it('aborts (no deletions) when ANY manifest fails to parse', async () => {
    blobAt('sha-A');
    blobAt('sha-orphan');
    writeManifestUnder('5min', 'good.attachments.json', ['sha-A']);
    // Drop a malformed manifest in the same tier dir.
    writeFileSync(join(backupRoot, '5min', 'broken.attachments.json'), 'not valid json {{');

    const stats = await runAttachmentGc(backupRoot);
    expect(stats.deleted).toBe(0);
    expect(stats.skippedDueToParseFailure).toBe(true);
    // Both blobs still on disk — the orphan was NOT swept because we
    // refused to operate on a partial reference set.
    expect(existsSync(join(attachmentBlobsDir(backupRoot), 'sha-A'))).toBe(true);
    expect(existsSync(join(attachmentBlobsDir(backupRoot), 'sha-orphan'))).toBe(true);
  });

  it('is a silent no-op when `<backupRoot>/attachments/` does not exist', async () => {
    const stats = await runAttachmentGc(backupRoot);
    expect(stats).toEqual({ deleted: 0, bytesReclaimed: 0, scannedManifests: 0, skippedDueToParseFailure: false });
  });

  it('leaves in-flight `.tmp` files alone (don\'t race a write)', async () => {
    const blobsDir = attachmentBlobsDir(backupRoot);
    mkdirSync(blobsDir, { recursive: true });
    writeFileSync(join(blobsDir, 'sha-A.tmp'), 'in-flight');
    writeManifestUnder('5min', 'good.attachments.json', []);

    const stats = await runAttachmentGc(backupRoot);
    expect(stats.deleted).toBe(0);
    expect(existsSync(join(blobsDir, 'sha-A.tmp'))).toBe(true);
  });
});

describe('deleteManifestSibling (HS-7929)', () => {
  it('removes the .attachments.json sibling next to a tarball', () => {
    const tarballPath = join(backupRoot, '5min', 'backup-X.tar.gz');
    mkdirSync(join(backupRoot, '5min'), { recursive: true });
    writeFileSync(tarballPath, 'tarball');
    const manifestPath = tarballPath.replace(/\.tar\.gz$/, '.attachments.json');
    writeFileSync(manifestPath, '{}');
    deleteManifestSibling(tarballPath);
    expect(existsSync(manifestPath)).toBe(false);
  });

  it('is a no-op when the sibling does not exist', () => {
    const tarballPath = join(backupRoot, 'no-sibling.tar.gz');
    expect(() => deleteManifestSibling(tarballPath)).not.toThrow();
  });
});

describe('restoreAttachmentsFromManifest (HS-7929)', () => {
  function setupBlobsDir(): string {
    const blobsDir = attachmentBlobsDir(backupRoot);
    mkdirSync(blobsDir, { recursive: true });
    return blobsDir;
  }

  it('copies hash-addressed blobs back to <liveAttachmentsDir>/<storedName>', async () => {
    const blobsDir = setupBlobsDir();
    const buf = Buffer.from('payload-A');
    const sha = expectedSha(buf);
    writeFileSync(join(blobsDir, sha), buf);
    const manifest: AttachmentManifest = {
      schemaVersion: ATTACHMENT_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      tarball: 'backup-X.tar.gz',
      entries: [{ attachmentId: 1, ticketId: 100, originalName: 'a.png', storedName: 'HS-100_a.png', sha, size: buf.length }],
    };
    const restored = await restoreAttachmentsFromManifest(manifest, blobsDir, liveAttachmentsDir);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.finalStoredName).toBe('HS-100_a.png');
    const dst = join(liveAttachmentsDir, 'HS-100_a.png');
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst).equals(buf)).toBe(true);
  });

  it('appends a -restored-<TS> suffix when a live file with the same name has DIFFERENT content', async () => {
    const blobsDir = setupBlobsDir();
    const oldBuf = Buffer.from('user-edited');
    const backupBuf = Buffer.from('original-backup');
    writeFileSync(join(liveAttachmentsDir, 'HS-100_a.png'), oldBuf);
    const sha = expectedSha(backupBuf);
    writeFileSync(join(blobsDir, sha), backupBuf);
    const manifest: AttachmentManifest = {
      schemaVersion: ATTACHMENT_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      tarball: 'backup-X.tar.gz',
      entries: [{ attachmentId: 1, ticketId: 100, originalName: 'a.png', storedName: 'HS-100_a.png', sha, size: backupBuf.length }],
    };
    const restored = await restoreAttachmentsFromManifest(manifest, blobsDir, liveAttachmentsDir);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.finalStoredName).not.toBe('HS-100_a.png');
    expect(restored[0]?.finalStoredName).toMatch(/^HS-100_a-restored-.+\.png$/);
    // The user's live file is preserved.
    expect(readFileSync(join(liveAttachmentsDir, 'HS-100_a.png')).equals(oldBuf)).toBe(true);
    // The backup blob landed under the suffix.
    expect(readFileSync(join(liveAttachmentsDir, restored[0]!.finalStoredName)).equals(backupBuf)).toBe(true);
  });

  it('is a no-op for entries whose live file matches the manifest sha (idempotent restore)', async () => {
    const blobsDir = setupBlobsDir();
    const buf = Buffer.from('content');
    const sha = expectedSha(buf);
    writeFileSync(join(blobsDir, sha), buf);
    writeFileSync(join(liveAttachmentsDir, 'HS-1_x.bin'), buf);
    const manifest: AttachmentManifest = {
      schemaVersion: ATTACHMENT_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      tarball: 'backup-X.tar.gz',
      entries: [{ attachmentId: 1, ticketId: 1, originalName: 'x.bin', storedName: 'HS-1_x.bin', sha, size: buf.length }],
    };
    const restored = await restoreAttachmentsFromManifest(manifest, blobsDir, liveAttachmentsDir);
    expect(restored).toHaveLength(1);
    expect(restored[0]?.finalStoredName).toBe('HS-1_x.bin');
    // No duplicate file was written.
    expect(readdirSync(liveAttachmentsDir).filter(n => n.startsWith('HS-1_x'))).toEqual(['HS-1_x.bin']);
  });

  it('skips entries whose hash blob is missing from the store', async () => {
    const blobsDir = setupBlobsDir();
    // Don't put the blob at all — simulate a GC race or corrupted store.
    const manifest: AttachmentManifest = {
      schemaVersion: ATTACHMENT_MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      tarball: 'backup-X.tar.gz',
      entries: [{ attachmentId: 1, ticketId: 1, originalName: 'x.bin', storedName: 'HS-1_x.bin', sha: 'missing-sha', size: 42 }],
    };
    const restored = await restoreAttachmentsFromManifest(manifest, blobsDir, liveAttachmentsDir);
    expect(restored).toHaveLength(0);
  });
});
