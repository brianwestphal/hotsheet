import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupAttachments } from './cleanup.js';
import { getDb } from './db/connection.js';
import { createTicket, getTicket, updateSetting } from './db/queries.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

describe('cleanupAttachments', () => {
  it('auto-archives verified tickets past verified threshold', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup verified');
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [t.id]
    );
    await cleanupAttachments();
    const updated = await getTicket(t.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('archive');
  });

  it('hard-deletes deleted tickets past trash threshold', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup deleted');
    await db.query(
      `UPDATE tickets SET status = 'deleted', deleted_at = NOW() - INTERVAL '4 days' WHERE id = $1`,
      [t.id]
    );
    await cleanupAttachments();
    expect(await getTicket(t.id)).toBeNull();
  });

  it('respects custom cleanup thresholds from settings', async () => {
    const db = await getDb();
    await updateSetting('verified_cleanup_days', '1');
    await updateSetting('trash_cleanup_days', '1');

    const t = await createTicket('Cleanup custom');
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [t.id]
    );
    await cleanupAttachments();
    const updated = await getTicket(t.id);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('archive');

    // Reset settings
    await updateSetting('verified_cleanup_days', '30');
    await updateSetting('trash_cleanup_days', '3');
  });

  it('does not clean up open tickets regardless of age', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup safe');
    await db.query(
      `UPDATE tickets SET created_at = NOW() - INTERVAL '365 days', updated_at = NOW() - INTERVAL '365 days' WHERE id = $1`,
      [t.id]
    );
    await cleanupAttachments();
    expect(await getTicket(t.id)).not.toBeNull();
  });

  it('GCs orphan draft attachments older than the 7-day horizon (HS-8428)', async () => {
    const db = await getDb();
    const t = await createTicket('Orphan draft attachment owner');

    // Set up: insert a draft-scoped attachment whose draft_id does NOT
    // match any feedback_drafts row + backdate it past the 7-day horizon.
    // The cleanup sweep should reap it. A second attachment that's only
    // 1 day old should survive (caller might still be working on the
    // draft).
    const oldDraftId = 'fd_orphan_old';
    const youngDraftId = 'fd_orphan_young';
    await db.query(
      `INSERT INTO attachments (ticket_id, draft_id, original_filename, stored_path, created_at)
       VALUES ($1, $2, 'old.png', '/tmp/old.png', NOW() - INTERVAL '8 days')`,
      [t.id, oldDraftId],
    );
    await db.query(
      `INSERT INTO attachments (ticket_id, draft_id, original_filename, stored_path, created_at)
       VALUES ($1, $2, 'young.png', '/tmp/young.png', NOW() - INTERVAL '1 days')`,
      [t.id, youngDraftId],
    );

    await cleanupAttachments();

    const survivors = await db.query<{ original_filename: string }>(
      `SELECT original_filename FROM attachments WHERE ticket_id = $1`,
      [t.id],
    );
    const names = survivors.rows.map(r => r.original_filename).sort();
    // The 8-day-old orphan is gone, the 1-day-old one survives.
    expect(names).toEqual(['young.png']);
  });

  it('does NOT reap a draft attachment whose draft row still exists (HS-8428)', async () => {
    const db = await getDb();
    const t = await createTicket('Draft attachment with live draft');
    const draftId = 'fd_live_draft';
    // Create the draft row.
    await db.query(
      `INSERT INTO feedback_drafts (id, ticket_id, prompt_text, partitions_json, created_at, updated_at)
       VALUES ($1, $2, '', '{}', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')`,
      [draftId, t.id],
    );
    // Attach an old draft-scoped attachment whose draft DOES exist.
    await db.query(
      `INSERT INTO attachments (ticket_id, draft_id, original_filename, stored_path, created_at)
       VALUES ($1, $2, 'kept.png', '/tmp/kept.png', NOW() - INTERVAL '30 days')`,
      [t.id, draftId],
    );

    await cleanupAttachments();

    // The attachment should survive — the LEFT JOIN in
    // listOrphanDraftAttachments matched a draft row, so it's not an orphan.
    const survivors = await db.query<{ original_filename: string }>(
      `SELECT original_filename FROM attachments WHERE ticket_id = $1`,
      [t.id],
    );
    const names = survivors.rows.map(r => r.original_filename);
    expect(names).toContain('kept.png');
  });

  it('uses default thresholds if settings are missing', async () => {
    const db = await getDb();
    // Remove cleanup settings
    await db.query(`DELETE FROM settings WHERE key IN ('verified_cleanup_days', 'trash_cleanup_days')`);

    const t = await createTicket('Cleanup defaults');
    await db.query(
      `UPDATE tickets SET status = 'deleted', deleted_at = NOW() - INTERVAL '4 days' WHERE id = $1`,
      [t.id]
    );
    await cleanupAttachments();
    expect(await getTicket(t.id)).toBeNull();

    // Restore settings
    await updateSetting('verified_cleanup_days', '30');
    await updateSetting('trash_cleanup_days', '3');
  });
});
