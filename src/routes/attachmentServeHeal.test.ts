// HS-8808 — serve-time self-heal for recoverable attachment files. When the
// `GET /api/attachments/file/*` route 404s, `tryServeTimeRestore` copies the
// blob back from the backup store so the broken image comes back immediately
// (the HS-8802 startup sweep also heals, but only on the next launch).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getDb } from '../db/connection.js';
import { createTicket } from '../db/queries.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { tryServeTimeRestore } from './attachments.js';

let tempDir: string;
let backupRoot: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
  backupRoot = join(tempDir, 'backups');
});
afterAll(async () => {
  await cleanupTestDb(tempDir);
  rmSync(backupRoot, { recursive: true, force: true });
});

async function insertAttachment(ticketId: number, name: string, storedPath: string): Promise<number> {
  const db = await getDb();
  const r = await db.query<{ id: number }>(
    `INSERT INTO attachments (ticket_id, original_filename, stored_path) VALUES ($1, $2, $3) RETURNING id`,
    [ticketId, name, storedPath],
  );
  return r.rows[0].id;
}

/** Write a manifest recording `attachmentId → sha` and create the blob in the store. */
function seedBackupWithBlob(attachmentId: number, ticketId: number, sha: string, bytes = 'blob-bytes'): void {
  mkdirSync(join(backupRoot, 'daily'), { recursive: true });
  mkdirSync(join(backupRoot, 'attachments'), { recursive: true });
  writeFileSync(join(backupRoot, 'attachments', sha), bytes);
  const manifest = {
    schemaVersion: 1, createdAt: new Date().toISOString(), tarball: 'b.tar.gz',
    entries: [{ attachmentId, ticketId, originalName: 'r.png', storedName: 'r.png', sha, size: bytes.length }],
  };
  writeFileSync(join(backupRoot, 'daily', 'b.tar.gz.attachments.json'), JSON.stringify(manifest));
}

describe('tryServeTimeRestore (HS-8808)', () => {
  it('restores a missing attachment file from the backup store', async () => {
    const t = await createTicket('serve-heal owner');
    const storedPath = resolve(join(tempDir, 'attachments', 'heal-me.png'));
    const id = await insertAttachment(t.id, 'heal-me.png', storedPath);
    seedBackupWithBlob(id, t.id, 'servehealsha', 'the-image-bytes');

    expect(existsSync(storedPath)).toBe(false);
    const healed = await tryServeTimeRestore(tempDir, storedPath);
    expect(healed).toBe(true);
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath, 'utf8')).toBe('the-image-bytes');
  });

  it('returns false for a path that maps to no attachment row', async () => {
    seedBackupWithBlob(-1, -1, 'unrelatedsha'); // ensure a backup store exists
    const healed = await tryServeTimeRestore(tempDir, resolve(join(tempDir, 'attachments', 'not-a-row.png')));
    expect(healed).toBe(false);
  });

  it('returns false when the attachment has no recoverable blob (and does not create the file)', async () => {
    const t = await createTicket('no-blob owner');
    const storedPath = resolve(join(tempDir, 'attachments', 'no-blob.png'));
    await insertAttachment(t.id, 'no-blob.png', storedPath);
    // Manifest references a sha whose blob file is absent from the store.
    mkdirSync(join(backupRoot, 'daily'), { recursive: true });
    mkdirSync(join(backupRoot, 'attachments'), { recursive: true });
    writeFileSync(join(backupRoot, 'daily', 'b.tar.gz.attachments.json'), JSON.stringify({
      schemaVersion: 1, createdAt: new Date().toISOString(), tarball: 'b.tar.gz',
      entries: [], // no entry for this attachment → no cross-ref
    }));

    const healed = await tryServeTimeRestore(tempDir, storedPath);
    expect(healed).toBe(false);
    expect(existsSync(storedPath)).toBe(false);
  });

  it('returns false when the backup root is absent', async () => {
    rmSync(backupRoot, { recursive: true, force: true });
    const t = await createTicket('no-backup owner');
    const storedPath = resolve(join(tempDir, 'attachments', 'no-backup.png'));
    await insertAttachment(t.id, 'no-backup.png', storedPath);
    const healed = await tryServeTimeRestore(tempDir, storedPath);
    expect(healed).toBe(false);
  });
});
