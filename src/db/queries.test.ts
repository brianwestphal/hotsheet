import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TicketStatus } from '../types.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import {
  addAttachment,
  batchDeleteTickets,
  batchRestoreTickets,
  batchUpdateTickets,
  createTicket,
  deleteAttachment,
  deleteTicket,
  emptyTrash,
  getAttachment,
  getAttachments,
  getSettings,
  getTicket,
  getTickets,
  getTicketStats,
  getTicketsForCleanup,
  getUpNextTickets,
  hardDeleteTicket,
  nextTicketNumber,
  restoreTicket,
  toggleUpNext,
  updateSetting,
  updateTicket,
} from './queries.js';
import { getDb } from './connection.js';

let tempDir: string;

beforeAll(async () => {
  tempDir = await setupTestDb();
});

afterAll(async () => {
  await cleanupTestDb(tempDir);
});

describe('ticket number generation', () => {
  it('generates sequential HS-N numbers', async () => {
    const n1 = await nextTicketNumber();
    const n2 = await nextTicketNumber();
    expect(n1).toMatch(/^HS-\d+$/);
    const num1 = parseInt(n1.split('-')[1]);
    const num2 = parseInt(n2.split('-')[1]);
    expect(num2).toBe(num1 + 1);
  });
});

describe('ticket creation', () => {
  it('creates with default values', async () => {
    const t = await createTicket('Default ticket');
    expect(t.title).toBe('Default ticket');
    expect(t.category).toBe('issue');
    expect(t.priority).toBe('default');
    expect(t.status).toBe('not_started');
    expect(t.up_next).toBe(false);
    expect(t.details).toBe('');
    expect(t.ticket_number).toMatch(/^HS-\d+$/);
    expect(t.created_at).toBeTruthy();
    expect(t.updated_at).toBeTruthy();
    expect(t.completed_at).toBeNull();
    expect(t.deleted_at).toBeNull();
  });

  it('applies category, priority, up_next, and details overrides', async () => {
    const t = await createTicket('Custom ticket', {
      category: 'bug',
      priority: 'high',
      up_next: true,
      details: 'Test details',
    });
    expect(t.category).toBe('bug');
    expect(t.priority).toBe('high');
    expect(t.up_next).toBe(true);
    expect(t.details).toBe('Test details');
  });

  it('treats empty string overrides as not provided', async () => {
    const t = await createTicket('Empty overrides', {
      category: '' as never,
      priority: '' as never,
      details: '',
    });
    expect(t.category).toBe('issue');
    expect(t.priority).toBe('default');
    expect(t.details).toBe('');
  });
});

describe('ticket read', () => {
  it('returns ticket by id', async () => {
    const created = await createTicket('Read test');
    const t = await getTicket(created.id);
    expect(t).not.toBeNull();
    expect(t!.title).toBe('Read test');
  });

  it('returns null for non-existent id', async () => {
    const t = await getTicket(99999);
    expect(t).toBeNull();
  });
});

describe('status transitions', () => {
  it('→ completed: sets completed_at, clears verified_at, clears up_next', async () => {
    const t = await createTicket('Transition completed', { up_next: true });
    const updated = await updateTicket(t.id, { status: 'completed' });
    expect(updated!.status).toBe('completed');
    expect(updated!.completed_at).not.toBeNull();
    expect(updated!.verified_at).toBeNull();
    expect(updated!.up_next).toBe(false);
  });

  it('→ verified: sets verified_at, sets completed_at if not already, clears up_next', async () => {
    const t = await createTicket('Transition verified', { up_next: true });
    const updated = await updateTicket(t.id, { status: 'verified' });
    expect(updated!.status).toBe('verified');
    expect(updated!.verified_at).not.toBeNull();
    expect(updated!.completed_at).not.toBeNull();
    expect(updated!.up_next).toBe(false);
  });

  it('completed → verified: preserves existing completed_at', async () => {
    const t = await createTicket('Transition comp→ver');
    const completed = await updateTicket(t.id, { status: 'completed' });
    const completedAt = completed!.completed_at;
    await new Promise(r => setTimeout(r, 50));
    const verified = await updateTicket(t.id, { status: 'verified' });
    expect(verified!.verified_at).not.toBeNull();
    expect(String(verified!.completed_at)).toBe(String(completedAt));
  });

  it('verified → completed: clears verified_at, sets new completed_at', async () => {
    const t = await createTicket('Transition ver→comp');
    await updateTicket(t.id, { status: 'verified' });
    const updated = await updateTicket(t.id, { status: 'completed' });
    expect(updated!.status).toBe('completed');
    expect(updated!.verified_at).toBeNull();
    expect(updated!.completed_at).not.toBeNull();
  });

  it('→ deleted: sets deleted_at', async () => {
    const t = await createTicket('Transition deleted');
    const updated = await updateTicket(t.id, { status: 'deleted' });
    expect(updated!.status).toBe('deleted');
    expect(updated!.deleted_at).not.toBeNull();
  });

  it('→ backlog: clears up_next and deleted_at, preserves completed_at', async () => {
    const t = await createTicket('Transition backlog', { up_next: true });
    await updateTicket(t.id, { status: 'completed' });
    const updated = await updateTicket(t.id, { status: 'backlog' });
    expect(updated!.status).toBe('backlog');
    expect(updated!.up_next).toBe(false);
    expect(updated!.completed_at).not.toBeNull();
    expect(updated!.verified_at).toBeNull();
    expect(updated!.deleted_at).toBeNull();
  });

  it('→ archive: clears up_next and deleted_at, preserves completed_at', async () => {
    const t = await createTicket('Transition archive');
    await updateTicket(t.id, { status: 'completed' });
    const updated = await updateTicket(t.id, { status: 'archive' });
    expect(updated!.status).toBe('archive');
    expect(updated!.up_next).toBe(false);
    expect(updated!.completed_at).not.toBeNull();
    expect(updated!.verified_at).toBeNull();
    expect(updated!.deleted_at).toBeNull();
  });

  it('→ not_started: clears completed_at, verified_at, deleted_at', async () => {
    const t = await createTicket('Transition not_started');
    await updateTicket(t.id, { status: 'completed' });
    const updated = await updateTicket(t.id, { status: 'not_started' });
    expect(updated!.status).toBe('not_started');
    expect(updated!.completed_at).toBeNull();
    expect(updated!.verified_at).toBeNull();
    expect(updated!.deleted_at).toBeNull();
  });

  it('→ started: clears completed_at, verified_at, deleted_at', async () => {
    const t = await createTicket('Transition started');
    await updateTicket(t.id, { status: 'deleted' });
    const updated = await updateTicket(t.id, { status: 'started' });
    expect(updated!.status).toBe('started');
    expect(updated!.completed_at).toBeNull();
    expect(updated!.verified_at).toBeNull();
    expect(updated!.deleted_at).toBeNull();
  });

  it('sets updated_at on every transition', async () => {
    const t = await createTicket('Transition timestamp');
    const before = t.updated_at;
    await new Promise(r => setTimeout(r, 50));
    const updated = await updateTicket(t.id, { status: 'started' });
    expect(new Date(updated!.updated_at).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});

describe('notes', () => {
  it('appends note as JSON array on empty notes', async () => {
    const t = await createTicket('Notes empty');
    const updated = await updateTicket(t.id, { notes: 'First note' });
    const parsed = JSON.parse(updated!.notes);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('First note');
    expect(parsed[0].created_at).toBeTruthy();
  });

  it('appends to existing JSON notes', async () => {
    const t = await createTicket('Notes append');
    await updateTicket(t.id, { notes: 'Note 1' });
    const updated = await updateTicket(t.id, { notes: 'Note 2' });
    const parsed = JSON.parse(updated!.notes);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('Note 1');
    expect(parsed[1].text).toBe('Note 2');
  });

  it('wraps legacy plain text notes as first entry', async () => {
    const t = await createTicket('Notes legacy');
    const db = await getDb();
    await db.query(`UPDATE tickets SET notes = 'Legacy note' WHERE id = $1`, [t.id]);
    const updated = await updateTicket(t.id, { notes: 'New note' });
    const parsed = JSON.parse(updated!.notes);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('Legacy note');
    expect(parsed[1].text).toBe('New note');
  });

  it('ignores empty note strings', async () => {
    const t = await createTicket('Notes empty string');
    await updateTicket(t.id, { notes: 'First' });
    const updated = await updateTicket(t.id, { notes: '' });
    const parsed = JSON.parse(updated!.notes);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('First');
  });
});

describe('filtering', () => {
  let bugId: number, featureId: number, startedId: number, completedId: number, deletedId: number;

  beforeAll(async () => {
    const bug = await createTicket('Filter bug', { category: 'investigation', priority: 'highest' });
    bugId = bug.id;
    const feature = await createTicket('Filter feature', { category: 'feature', priority: 'low', up_next: true });
    featureId = feature.id;
    const started = await createTicket('Filter started', { category: 'investigation' });
    startedId = started.id;
    await updateTicket(startedId, { status: 'started' });
    const completed = await createTicket('Filter completed', { category: 'investigation' });
    completedId = completed.id;
    await updateTicket(completedId, { status: 'completed' });
    const deleted = await createTicket('Filter deleted', { category: 'investigation' });
    deletedId = deleted.id;
    await updateTicket(deletedId, { status: 'deleted' });
  });

  it('default filter excludes deleted, backlog, archive', async () => {
    const tickets = await getTickets();
    const ids = tickets.map(t => t.id);
    expect(ids).not.toContain(deletedId);
    expect(ids).toContain(bugId);
    expect(ids).toContain(featureId);
    expect(ids).toContain(completedId);
  });

  it('status=open returns not_started and started only', async () => {
    const tickets = await getTickets({ status: 'open' });
    for (const t of tickets) {
      expect(['not_started', 'started']).toContain(t.status);
    }
    const ids = tickets.map(t => t.id);
    expect(ids).toContain(startedId);
    expect(ids).not.toContain(completedId);
    expect(ids).not.toContain(deletedId);
  });

  it('status=non_verified returns not_started, started, completed', async () => {
    const tickets = await getTickets({ status: 'non_verified' });
    for (const t of tickets) {
      expect(['not_started', 'started', 'completed']).toContain(t.status);
    }
    const ids = tickets.map(t => t.id);
    expect(ids).toContain(completedId);
    expect(ids).not.toContain(deletedId);
  });

  it('status=active excludes deleted, backlog, archive', async () => {
    const tickets = await getTickets({ status: 'active' as TicketStatus });
    const ids = tickets.map(t => t.id);
    expect(ids).not.toContain(deletedId);
    expect(ids).toContain(bugId);
  });

  it('filters by category', async () => {
    const tickets = await getTickets({ category: 'investigation' });
    for (const t of tickets) {
      expect(t.category).toBe('investigation');
    }
    expect(tickets.map(t => t.id)).toContain(bugId);
    expect(tickets.map(t => t.id)).not.toContain(featureId);
  });

  it('filters by priority', async () => {
    const tickets = await getTickets({ priority: 'highest' });
    for (const t of tickets) {
      expect(t.priority).toBe('highest');
    }
    expect(tickets.map(t => t.id)).toContain(bugId);
  });

  it('filters by up_next', async () => {
    const tickets = await getTickets({ up_next: true });
    for (const t of tickets) {
      expect(t.up_next).toBe(true);
    }
    expect(tickets.map(t => t.id)).toContain(featureId);
  });

  it('search is case-insensitive on title', async () => {
    const tickets = await getTickets({ search: 'FILTER BUG' });
    expect(tickets.map(t => t.id)).toContain(bugId);
  });

  it('search matches ticket_number', async () => {
    const t = await createTicket('Search by number');
    const tickets = await getTickets({ search: t.ticket_number });
    expect(tickets.map(t => t.id)).toContain(t.id);
  });

  it('filters combine with AND logic', async () => {
    const tickets = await getTickets({ category: 'investigation', status: 'started' as TicketStatus });
    const ids = tickets.map(t => t.id);
    expect(ids).toContain(startedId);
    expect(ids).not.toContain(bugId);
    expect(ids).not.toContain(featureId);
  });
});

describe('sorting', () => {
  it('sorts by priority asc (highest first)', async () => {
    const tickets = await getTickets({ sort_by: 'priority', sort_dir: 'asc' });
    const priorities = tickets.map(t => t.priority);
    const order = ['highest', 'high', 'default', 'low', 'lowest'];
    for (let i = 1; i < priorities.length; i++) {
      expect(order.indexOf(priorities[i])).toBeGreaterThanOrEqual(order.indexOf(priorities[i - 1]));
    }
  });

  it('sorts by status asc (backlog first)', async () => {
    const tickets = await getTickets({ sort_by: 'status', sort_dir: 'asc' });
    const statuses = tickets.map(t => t.status);
    const order = ['backlog', 'not_started', 'started', 'completed', 'verified', 'archive'];
    for (let i = 1; i < statuses.length; i++) {
      expect(order.indexOf(statuses[i])).toBeGreaterThanOrEqual(order.indexOf(statuses[i - 1]));
    }
  });

  it('default sort is created_at DESC with id DESC tiebreaker', async () => {
    const tickets = await getTickets();
    for (let i = 1; i < tickets.length; i++) {
      const a = new Date(tickets[i - 1].created_at).getTime();
      const b = new Date(tickets[i].created_at).getTime();
      if (a === b) {
        expect(tickets[i - 1].id).toBeGreaterThan(tickets[i].id);
      } else {
        expect(a).toBeGreaterThanOrEqual(b);
      }
    }
  });

  it('sorts by category', async () => {
    const tickets = await getTickets({ sort_by: 'category', sort_dir: 'asc' });
    const categories = tickets.map(t => t.category);
    for (let i = 1; i < categories.length; i++) {
      expect(categories[i] >= categories[i - 1]).toBe(true);
    }
  });

  it('sort_dir=asc reverses order', async () => {
    const desc = await getTickets({ sort_by: 'ticket_number', sort_dir: 'desc' });
    const asc = await getTickets({ sort_by: 'ticket_number', sort_dir: 'asc' });
    if (desc.length > 1) {
      expect(desc[0].id).toBeGreaterThan(desc[desc.length - 1].id);
      expect(asc[0].id).toBeLessThan(asc[asc.length - 1].id);
    }
  });
});

describe('update', () => {
  it('updates title and details', async () => {
    const t = await createTicket('Original title');
    const updated = await updateTicket(t.id, { title: 'New title', details: 'New details' });
    expect(updated!.title).toBe('New title');
    expect(updated!.details).toBe('New details');
  });

  it('returns null for non-existent ticket', async () => {
    const result = await updateTicket(99999, { title: 'Nope' });
    expect(result).toBeNull();
  });
});

describe('getUpNextTickets', () => {
  it('returns only up_next tickets sorted by priority', async () => {
    const low = await createTicket('Up next low', { priority: 'low', up_next: true });
    const high = await createTicket('Up next high', { priority: 'high', up_next: true });
    const notUpNext = await createTicket('Not up next');

    const tickets = await getUpNextTickets();
    const ids = tickets.map(t => t.id);
    expect(ids).toContain(low.id);
    expect(ids).toContain(high.id);
    expect(ids).not.toContain(notUpNext.id);
    // high priority should come before low
    expect(ids.indexOf(high.id)).toBeLessThan(ids.indexOf(low.id));
  });
});

describe('toggle up_next', () => {
  it('toggles false → true → false', async () => {
    const t = await createTicket('Toggle test');
    expect(t.up_next).toBe(false);
    const toggled = await toggleUpNext(t.id);
    expect(toggled!.up_next).toBe(true);
    const toggled2 = await toggleUpNext(t.id);
    expect(toggled2!.up_next).toBe(false);
  });

  it('returns null for non-existent ticket', async () => {
    const result = await toggleUpNext(99999);
    expect(result).toBeNull();
  });
});

describe('batch operations', () => {
  it('batch deletes multiple tickets', async () => {
    const t1 = await createTicket('Batch del 1');
    const t2 = await createTicket('Batch del 2');
    await batchDeleteTickets([t1.id, t2.id]);
    expect((await getTicket(t1.id))!.status).toBe('deleted');
    expect((await getTicket(t2.id))!.status).toBe('deleted');
  });

  it('batch updates category', async () => {
    const t1 = await createTicket('Batch cat 1');
    const t2 = await createTicket('Batch cat 2');
    await batchUpdateTickets([t1.id, t2.id], { category: 'task' });
    expect((await getTicket(t1.id))!.category).toBe('task');
    expect((await getTicket(t2.id))!.category).toBe('task');
  });

  it('batch status change triggers side effects', async () => {
    const t = await createTicket('Batch status', { up_next: true });
    await batchUpdateTickets([t.id], { status: 'completed' });
    const r = await getTicket(t.id);
    expect(r!.status).toBe('completed');
    expect(r!.completed_at).not.toBeNull();
    expect(r!.up_next).toBe(false);
  });

  it('batch restore restores deleted tickets', async () => {
    const t = await createTicket('Batch restore');
    await deleteTicket(t.id);
    await batchRestoreTickets([t.id]);
    const r = await getTicket(t.id);
    expect(r!.status).toBe('not_started');
    expect(r!.deleted_at).toBeNull();
  });
});

describe('trash', () => {
  it('soft delete sets status to deleted', async () => {
    const t = await createTicket('Trash test');
    await deleteTicket(t.id);
    expect((await getTicket(t.id))!.status).toBe('deleted');
  });

  it('restore sets status to not_started and clears deleted_at', async () => {
    const t = await createTicket('Restore test');
    await deleteTicket(t.id);
    const restored = await restoreTicket(t.id);
    expect(restored!.status).toBe('not_started');
    expect(restored!.deleted_at).toBeNull();
  });

  it('empty trash hard-deletes all deleted tickets', async () => {
    const t1 = await createTicket('Empty trash 1');
    const t2 = await createTicket('Empty trash 2');
    await deleteTicket(t1.id);
    await deleteTicket(t2.id);
    const ids = await emptyTrash();
    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
    expect(await getTicket(t1.id)).toBeNull();
    expect(await getTicket(t2.id)).toBeNull();
  });
});

describe('hard delete', () => {
  it('permanently removes ticket', async () => {
    const t = await createTicket('Hard delete');
    await hardDeleteTicket(t.id);
    expect(await getTicket(t.id)).toBeNull();
  });
});

describe('stats', () => {
  it('returns correct structure with counts', async () => {
    const stats = await getTicketStats();
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.open).toBe('number');
    expect(typeof stats.up_next).toBe('number');
    expect(stats.total).toBeGreaterThanOrEqual(0);
    expect(stats.open).toBeGreaterThanOrEqual(0);
    expect(stats.by_category).toBeDefined();
    expect(stats.by_status).toBeDefined();
  });

  it('excludes deleted, backlog, archive from total', async () => {
    const t = await createTicket('Stats deleted');
    await deleteTicket(t.id);
    const stats = await getTicketStats();
    // The deleted ticket should not be in total
    const allActive = await getTickets({ status: 'active' as TicketStatus });
    expect(stats.total).toBe(allActive.length);
  });
});

describe('settings', () => {
  it('returns default settings', async () => {
    const settings = await getSettings();
    expect(settings.detail_position).toBe('side');
    expect(settings.detail_width).toBe('360');
    expect(settings.trash_cleanup_days).toBe('3');
    expect(settings.verified_cleanup_days).toBe('30');
  });

  it('upserts settings', async () => {
    await updateSetting('detail_position', 'bottom');
    const settings = await getSettings();
    expect(settings.detail_position).toBe('bottom');
  });

  it('inserts new setting key', async () => {
    await updateSetting('custom_key', 'custom_value');
    const settings = await getSettings();
    expect(settings.custom_key).toBe('custom_value');
  });
});

describe('attachments', () => {
  it('adds and retrieves attachments', async () => {
    const t = await createTicket('Attachment test');
    const att = await addAttachment(t.id, 'test.png', '/tmp/test.png');
    expect(att.ticket_id).toBe(t.id);
    expect(att.original_filename).toBe('test.png');
    expect(att.stored_path).toBe('/tmp/test.png');
    const list = await getAttachments(t.id);
    expect(list).toHaveLength(1);
    expect(list[0].original_filename).toBe('test.png');
  });

  it('retrieves single attachment by id', async () => {
    const t = await createTicket('Attachment single');
    const att = await addAttachment(t.id, 'single.png', '/tmp/single.png');
    const retrieved = await getAttachment(att.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(att.id);
    expect(retrieved!.original_filename).toBe('single.png');
  });

  it('returns null for non-existent attachment', async () => {
    expect(await getAttachment(99999)).toBeNull();
  });

  it('deletes attachment', async () => {
    const t = await createTicket('Attachment del');
    const att = await addAttachment(t.id, 'del.png', '/tmp/del.png');
    const deleted = await deleteAttachment(att.id);
    expect(deleted).not.toBeNull();
    expect(deleted!.id).toBe(att.id);
    expect(await getAttachments(t.id)).toHaveLength(0);
  });

  it('cascades on ticket hard delete', async () => {
    const t = await createTicket('Attachment cascade');
    await addAttachment(t.id, 'cascade.png', '/tmp/cascade.png');
    await hardDeleteTicket(t.id);
    // Attachment should be gone with the ticket (CASCADE)
    expect(await getAttachments(t.id)).toHaveLength(0);
  });
});

describe('cleanup query', () => {
  it('returns verified tickets past threshold', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup verified');
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [t.id]
    );
    const forCleanup = await getTicketsForCleanup(30, 3);
    expect(forCleanup.map(c => c.id)).toContain(t.id);
  });

  it('does not return tickets within the threshold', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup boundary');
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '29 days' WHERE id = $1`,
      [t.id]
    );
    const forCleanup = await getTicketsForCleanup(30, 3);
    expect(forCleanup.map(c => c.id)).not.toContain(t.id);
  });

  it('returns deleted tickets past trash threshold', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup trash');
    await db.query(
      `UPDATE tickets SET status = 'deleted', deleted_at = NOW() - INTERVAL '4 days' WHERE id = $1`,
      [t.id]
    );
    const forCleanup = await getTicketsForCleanup(30, 3);
    expect(forCleanup.map(c => c.id)).toContain(t.id);
  });

  it('does not return tickets in other statuses regardless of age', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup safe');
    await db.query(
      `UPDATE tickets SET created_at = NOW() - INTERVAL '365 days' WHERE id = $1`,
      [t.id]
    );
    const forCleanup = await getTicketsForCleanup(30, 3);
    expect(forCleanup.map(c => c.id)).not.toContain(t.id);
  });
});
