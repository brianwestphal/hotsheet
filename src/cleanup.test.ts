import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from './test-helpers.js';
import { createTicket, getTicket, updateSetting } from './db/queries.js';
import { getDb } from './db/connection.js';
import { cleanupAttachments } from './cleanup.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

describe('cleanupAttachments', () => {
  it('hard-deletes verified tickets past verified threshold', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup verified');
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [t.id]
    );
    await cleanupAttachments();
    expect(await getTicket(t.id)).toBeNull();
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
    expect(await getTicket(t.id)).toBeNull();

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
