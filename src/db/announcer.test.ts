import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import {
  clearAnnouncements, dismissAnnouncement, getActiveAnnouncements,
  getLatestCoversTo, insertAnnouncements,
} from './announcer.js';
import { getDb } from './connection.js';

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

  it('clear wipes all entries', async () => {
    await insertAnnouncements([{ title: 'A', script: 'a' }, { title: 'B', script: 'b' }], null, null);
    expect(await clearAnnouncements()).toBe(2);
    expect(await getActiveAnnouncements()).toHaveLength(0);
  });
});
