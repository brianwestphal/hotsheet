import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import {
  clearAnnouncements, dismissAnnouncement, getActiveAnnouncements,
  getLatestCoversTo, insertAnnouncements, markAnnouncementListened,
} from './announcer.js';
import { getDb } from './connection.js';
import { updateSetting } from './settings.js';

let tempDir: string;

beforeAll(async () => { tempDir = await setupTestDb(); });
afterAll(async () => { await cleanupTestDb(tempDir); });
beforeEach(async () => { await (await getDb()).query('DELETE FROM announcements'); });

describe('announcements DB (HS-8745)', () => {
  it('inserts a batch, appends positions, lists in playback order', async () => {
    await insertAnnouncements([{ title: 'A', script: 'a' }, { title: 'B', script: 'b' }], '2026-06-05T00:00:00Z', '2026-06-05T01:00:00Z');
    await insertAnnouncements([{ title: 'C', script: 'c' }], '2026-06-05T01:00:00Z', '2026-06-05T02:00:00Z');

    const rows = await getActiveAnnouncements();
    expect(rows.map(r => r.title)).toEqual(['A', 'B', 'C']);
    // Positions are strictly increasing across batches.
    expect(rows[0].position).toBeLessThan(rows[1].position);
    expect(rows[1].position).toBeLessThan(rows[2].position);
    expect(rows[0].covers_from).not.toBeNull();
  });

  it('empty batch inserts nothing', async () => {
    expect(await insertAnnouncements([], null, null)).toEqual([]);
    expect(await getActiveAnnouncements()).toHaveLength(0);
  });

  it('dismiss removes an entry from the active list', async () => {
    const [a, b] = await insertAnnouncements([{ title: 'A', script: 'a' }, { title: 'B', script: 'b' }], null, null);
    const dismissed = await dismissAnnouncement(a.id);
    expect(dismissed?.dismissed).toBe(true);
    expect((await getActiveAnnouncements()).map(r => r.id)).toEqual([b.id]);
    // Dismissing a missing id returns null.
    expect(await dismissAnnouncement(999999)).toBeNull();
  });

  it('getLatestCoversTo returns the high-water mark', async () => {
    expect(await getLatestCoversTo()).toBeNull();
    await insertAnnouncements([{ title: 'A', script: 'a' }], '2026-06-05T00:00:00Z', '2026-06-05T01:00:00Z');
    await insertAnnouncements([{ title: 'B', script: 'b' }], '2026-06-05T01:00:00Z', '2026-06-05T03:00:00Z');
    const latest = await getLatestCoversTo();
    expect(latest).not.toBeNull();
    // Normalized to ISO; the high-water mark is the later covers_to.
    expect(latest).toBe('2026-06-05T03:00:00.000Z');
  });

  it('round-trips the emphasis phrase list (HS-8749)', async () => {
    const [row] = await insertAnnouncements(
      [{ title: 'A', script: 'fixed the export bug', emphasis: ['export bug'] }],
      null, null,
    );
    expect(row.emphasis).toEqual(['export bug']);
    const [active] = await getActiveAnnouncements();
    expect(active.emphasis).toEqual(['export bug']);
  });

  it('defaults emphasis to an empty array when omitted', async () => {
    const [row] = await insertAnnouncements([{ title: 'A', script: 'a' }], null, null);
    expect(row.emphasis).toEqual([]);
    const [active] = await getActiveAnnouncements();
    expect(active.emphasis).toEqual([]);
  });

  it('round-trips a code-diff visual (HS-8772)', async () => {
    const [row] = await insertAnnouncements(
      [{ title: 'A', script: 'a', visuals: [{ type: 'diff', oldStr: 'a', newStr: 'b', filePath: 'f.ts', replaceAll: false }] }],
      null, null,
    );
    expect(row.visuals).toEqual([{ type: 'diff', oldStr: 'a', newStr: 'b', filePath: 'f.ts', replaceAll: false }]);
    const [active] = await getActiveAnnouncements();
    expect(active.visuals[0]).toMatchObject({ type: 'diff', oldStr: 'a', newStr: 'b' });
  });

  it('defaults visuals to an empty array when omitted', async () => {
    const [row] = await insertAnnouncements([{ title: 'A', script: 'a' }], null, null);
    expect(row.visuals).toEqual([]);
  });

  it('clear wipes all entries', async () => {
    await insertAnnouncements([{ title: 'A', script: 'a' }, { title: 'B', script: 'b' }], null, null);
    expect(await clearAnnouncements()).toBe(2);
    expect(await getActiveAnnouncements()).toHaveLength(0);
  });
});

describe('listened tracking + 1h grace window (HS-8803)', () => {
  /** Directly stamp `listened_at` relative to now (PG interval string, e.g. `2 hours`). */
  async function stampListened(id: number, interval: string): Promise<void> {
    await (await getDb()).query(`UPDATE announcements SET listened_at = now() - interval '${interval}' WHERE id = $1`, [id]);
  }
  async function listenedAtOf(id: number): Promise<string | Date | null> {
    const r = await (await getDb()).query<{ listened_at: string | Date | null }>(
      `SELECT listened_at FROM announcements WHERE id = $1`, [id]);
    return r.rows[0].listened_at;
  }

  it('hides entries listened more than the grace window ago, keeps recent + never-heard', async () => {
    const [a, b, c] = await insertAnnouncements(
      [{ title: 'A', script: 'a' }, { title: 'B', script: 'b' }, { title: 'C', script: 'c' }], null, null);
    await stampListened(a.id, '2 hours'); // beyond the 1h grace → hidden
    await stampListened(b.id, '10 minutes'); // within grace → kept
    // c left NULL (never heard) → kept
    expect((await getActiveAnnouncements()).map(r => r.id)).toEqual([b.id, c.id]);
    // The kept entry round-trips its listened_at as ISO (not Date).
    const kept = (await getActiveAnnouncements()).find(r => r.id === b.id);
    expect(kept?.listened_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect((await getActiveAnnouncements()).find(r => r.id === c.id)?.listened_at).toBeNull();
  });

  it('markAnnouncementListened stamps the entry and resets only LATER already-heard entries', async () => {
    const [a, b, c, d] = await insertAnnouncements(
      [{ title: 'A', script: 'a' }, { title: 'B', script: 'b' }, { title: 'C', script: 'c' }, { title: 'D', script: 'd' }],
      null, null);
    // a (earlier) + c (later) already heard long ago; d (later) never heard.
    await stampListened(a.id, '3 hours');
    await stampListened(c.id, '3 hours');
    // Re-listen to b: b is stamped now, c (later + heard) resets, a (earlier) and d (never-heard) untouched.
    await markAnnouncementListened(b.id);
    // a stays beyond grace → hidden; b, c now recent and d still NULL → all shown.
    expect((await getActiveAnnouncements()).map(r => r.id)).toEqual([b.id, c.id, d.id]);
    // d (a never-heard later entry) must remain NULL — it's still a "first non-listened" candidate.
    expect(await listenedAtOf(d.id)).toBeNull();
  });

  it('one-time backfill clears the pre-cursor backlog from the legacy close-cursor, then is idempotent', async () => {
    const db = await getDb();
    // Re-arm the backfill (it runs once per project) and set the legacy close-cursor.
    await db.query(`DELETE FROM settings WHERE key = 'plugin:announcer_listened_backfilled'`);
    await updateSetting('announcer_last_listened_at', '2026-06-05T12:00:00Z');

    const [old1, old2] = await insertAnnouncements([{ title: 'old1', script: 'x' }, { title: 'old2', script: 'y' }], null, null);
    const [fresh] = await insertAnnouncements([{ title: 'fresh', script: 'z' }], null, null);
    await db.query(`UPDATE announcements SET created_at = '2026-06-05T10:00:00Z' WHERE id = ANY($1::int[])`, [[old1.id, old2.id]]);
    await db.query(`UPDATE announcements SET created_at = '2026-06-05T14:00:00Z' WHERE id = $1`, [fresh.id]);

    // First read triggers the backfill: pre-cursor entries are marked heard-in-the-past → cleared.
    expect((await getActiveAnnouncements()).map(r => r.title)).toEqual(['fresh']);
    // Sentinel persisted → a second read is a no-op (a close-without-listening can't re-trigger it).
    const sentinel = await db.query(`SELECT 1 FROM settings WHERE key = 'plugin:announcer_listened_backfilled'`);
    expect(sentinel.rows).toHaveLength(1);
    expect((await getActiveAnnouncements()).map(r => r.title)).toEqual(['fresh']);
  });
});
