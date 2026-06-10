import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import { getDb } from './connection.js';
import { updateSetting } from './settings.js';
import { deriveBuiltinViewCounts, getSidebarCounts } from './sidebarCounts.js';
import { createTicket } from './tickets.js';

describe('deriveBuiltinViewCounts (HS-8511, pure)', () => {
  it('maps grouped status/category/priority counts to sidebar view ids', () => {
    const counts = deriveBuiltinViewCounts({
      byStatus: { not_started: 3, started: 2, completed: 4, verified: 1, backlog: 5, archive: 6, deleted: 7 },
      upNext: 2,
      byCategory: { bug: 3, feature: 2 },
      byPriority: { high: 1, default: 4 },
    });
    expect(counts.all).toBe(10); // active = not_started + started + completed + verified
    expect(counts['non-verified']).toBe(9); // active minus verified
    expect(counts.open).toBe(5); // not_started + started
    expect(counts.completed).toBe(4);
    expect(counts.verified).toBe(1);
    expect(counts['up-next']).toBe(2);
    expect(counts.backlog).toBe(5);
    expect(counts.archive).toBe(6);
    expect(counts.trash).toBe(7); // deleted
    expect(counts['category:bug']).toBe(3);
    expect(counts['category:feature']).toBe(2);
    expect(counts['priority:high']).toBe(1);
    expect(counts['priority:default']).toBe(4);
  });

  it('treats absent status buckets as 0', () => {
    const c = deriveBuiltinViewCounts({ byStatus: {}, upNext: 0, byCategory: {}, byPriority: {} });
    expect(c.all).toBe(0);
    expect(c.open).toBe(0);
    expect(c.trash).toBe(0);
    expect(c['up-next']).toBe(0);
  });
});

describe('getSidebarCounts (HS-8511, DB)', () => {
  let tempDir: string;
  beforeAll(async () => { tempDir = await setupTestDb(); });
  afterAll(async () => { await cleanupTestDb(tempDir); });
  beforeEach(async () => {
    await (await getDb()).query('DELETE FROM tickets');
    await updateSetting('custom_views', '');
  });

  it('counts built-in views, category + priority views, and a custom view', async () => {
    // Active scope
    await createTicket('a', { category: 'bug', priority: 'high', status: 'not_started', up_next: true });
    await createTicket('b', { category: 'bug', priority: 'default', status: 'started' });
    await createTicket('c', { category: 'feature', priority: 'default', status: 'completed' });
    await createTicket('d', { category: 'task', priority: 'low', status: 'verified' });
    // Out-of-scope lifecycle buckets
    await createTicket('e', { category: 'bug', priority: 'high', status: 'backlog' });
    await createTicket('f', { category: 'bug', priority: 'high', status: 'archive' });
    await createTicket('g', { category: 'bug', priority: 'high', status: 'deleted' });

    // A custom view selecting bugs. `queryTickets` (the path the custom-view
    // LIST uses) excludes deleted + archive but INCLUDES backlog — so this counts
    // a, b, and e (backlog), i.e. 3, matching what clicking the view would show.
    await updateSetting('custom_views', JSON.stringify([
      { id: 'cv1', name: 'Bugs', logic: 'all', conditions: [{ field: 'category', operator: 'equals', value: 'bug' }] },
    ]));

    const counts = await getSidebarCounts();

    expect(counts.all).toBe(4); // a,b,c,d
    expect(counts['non-verified']).toBe(3); // a,b,c
    expect(counts.open).toBe(2); // a (not_started) + b (started)
    expect(counts.completed).toBe(1);
    expect(counts.verified).toBe(1);
    expect(counts['up-next']).toBe(1); // a
    expect(counts.backlog).toBe(1);
    expect(counts.archive).toBe(1);
    expect(counts.trash).toBe(1);
    expect(counts['category:bug']).toBe(2); // active bugs: a,b
    expect(counts['category:feature']).toBe(1);
    expect(counts['priority:high']).toBe(1); // active high: a
    expect(counts['priority:default']).toBe(2); // b,c
    // Custom view counts through the authoritative queryTickets path: bugs that
    // aren't deleted/archived = a, b, e(backlog) = 3.
    expect(counts['custom:cv1']).toBe(3);
  });

  it('omits custom counts when the custom_views setting is empty / malformed', async () => {
    await createTicket('x', { category: 'bug', priority: 'high', status: 'not_started' });
    await updateSetting('custom_views', 'not json');
    const counts = await getSidebarCounts();
    expect(counts.all).toBe(1);
    expect(Object.keys(counts).some(k => k.startsWith('custom:'))).toBe(false);
  });
});
