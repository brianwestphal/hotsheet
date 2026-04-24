import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { TicketStatus } from '../types.js';
import { getDb } from './connection.js';
import {
  addAttachment,
  batchDeleteTickets,
  batchRestoreTickets,
  batchUpdateTickets,
  createTicket,
  deleteAttachment,
  deleteNote,
  deleteTicket,
  duplicateTickets,
  editNote,
  emptyTrash,
  extractBracketTags,
  getAllTags,
  getAttachment,
  getAttachments,
  getCategories,
  getSettings,
  getTicket,
  getTickets,
  getTicketsForCleanup,
  getTicketStats,
  getUpNextTickets,
  hardDeleteTicket,
  nextTicketNumber,
  parseNotes,
  queryTickets,
  restoreTicket,
  saveCategories,
  toggleUpNext,
  updateSetting,
  updateTicket,
} from './queries.js';

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

  // HS-7279 — clicking the star on a completed ticket used to reopen it to
  // not_started correctly, but the up_next flag stayed false because the
  // transition block only set the _at fields and the general-loop copy of
  // up_next was suppressed by a STATUS_MANAGED guard that didn't account
  // for the transition not actually overriding up_next. Fix: only treat
  // up_next as status-managed when the target status is one that explicitly
  // clears it (completed / verified / backlog / archive).
  it('HS-7279: {status:not_started, up_next:true} on a completed ticket sets BOTH', async () => {
    const t = await createTicket('Star click regression');
    await updateTicket(t.id, { status: 'completed' });
    // Sanity: the completion path correctly cleared up_next.
    const done = await updateTicket(t.id, {});
    expect(done!.status).toBe('completed');
    expect(done!.up_next).toBe(false);
    // The star-click path sends both fields; both must land.
    const reopened = await updateTicket(t.id, { status: 'not_started', up_next: true });
    expect(reopened!.status).toBe('not_started');
    expect(reopened!.up_next).toBe(true);
    expect(reopened!.completed_at).toBeNull();
    expect(reopened!.verified_at).toBeNull();
  });

  it('HS-7279: {status:not_started, up_next:false} on a completed ticket honours the explicit false', async () => {
    const t = await createTicket('Explicit false', { up_next: true });
    await updateTicket(t.id, { status: 'completed' });
    const reopened = await updateTicket(t.id, { status: 'not_started', up_next: false });
    expect(reopened!.status).toBe('not_started');
    expect(reopened!.up_next).toBe(false);
  });

  it('HS-7279: {status:started, up_next:true} on any ticket sets both', async () => {
    const t = await createTicket('Start with up_next');
    const updated = await updateTicket(t.id, { status: 'started', up_next: true });
    expect(updated!.status).toBe('started');
    expect(updated!.up_next).toBe(true);
  });

  it('HS-7279: {status:deleted, up_next:true} keeps up_next — deleted transition no longer clears it', async () => {
    // Rationale: deleted is a soft-delete; if a workflow wants to preserve
    // the up_next flag for restore semantics, the caller's intent wins.
    // (Pre-HS-7279 the flag was silently dropped by the STATUS_MANAGED skip.)
    const t = await createTicket('Delete keeps up_next');
    const updated = await updateTicket(t.id, { status: 'deleted', up_next: true });
    expect(updated!.status).toBe('deleted');
    expect(updated!.up_next).toBe(true);
  });

  it('HS-7279: {status:completed, up_next:true} is still clobbered to false — completion is the one transition that always wins', async () => {
    // Completion / verification / backlog / archive each define a semantic
    // that forbids up_next; the client should not be able to override that.
    const t = await createTicket('Completion wins');
    const updated = await updateTicket(t.id, { status: 'completed', up_next: true });
    expect(updated!.status).toBe('completed');
    expect(updated!.up_next).toBe(false);
  });
});

describe('notes', () => {
  it('appends note as JSON array on empty notes', async () => {
    const t = await createTicket('Notes empty');
    const updated = await updateTicket(t.id, { notes: 'First note' });
    const parsed = JSON.parse(updated!.notes) as { text: string; created_at: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].text).toBe('First note');
    expect(parsed[0].created_at).toBeTruthy();
  });

  it('appends to existing JSON notes', async () => {
    const t = await createTicket('Notes append');
    await updateTicket(t.id, { notes: 'Note 1' });
    const updated = await updateTicket(t.id, { notes: 'Note 2' });
    const parsed = JSON.parse(updated!.notes) as { text: string }[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('Note 1');
    expect(parsed[1].text).toBe('Note 2');
  });

  it('wraps legacy plain text notes as first entry', async () => {
    const t = await createTicket('Notes legacy');
    const db = await getDb();
    await db.query(`UPDATE tickets SET notes = 'Legacy note' WHERE id = $1`, [t.id]);
    const updated = await updateTicket(t.id, { notes: 'New note' });
    const parsed = JSON.parse(updated!.notes) as { text: string }[];
    expect(parsed).toHaveLength(2);
    expect(parsed[0].text).toBe('Legacy note');
    expect(parsed[1].text).toBe('New note');
  });

  it('ignores empty note strings', async () => {
    const t = await createTicket('Notes empty string');
    await updateTicket(t.id, { notes: 'First' });
    const updated = await updateTicket(t.id, { notes: '' });
    const parsed = JSON.parse(updated!.notes) as { text: string }[];
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

  it('search escapes ILIKE wildcards (% and _)', async () => {
    const t = await createTicket('100% complete_task');
    // Search for literal % — should match, not be treated as wildcard
    const byPercent = await getTickets({ search: '100%' });
    expect(byPercent.map(t => t.id)).toContain(t.id);
    // Search for literal _ — should match, not be treated as single-char wildcard
    const byUnderscore = await getTickets({ search: 'complete_task' });
    expect(byUnderscore.map(t => t.id)).toContain(t.id);
    // A wildcard-only search should not match everything
    const byWildcard = await getTickets({ search: '%' });
    // Should only match tickets that literally contain %
    expect(byWildcard.every(t => t.title.includes('%') || t.details.includes('%') || t.tags.includes('%'))).toBe(true);
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
    const desc = await getTickets({ sort_by: 'created', sort_dir: 'desc' });
    const asc = await getTickets({ sort_by: 'created', sort_dir: 'asc' });
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
  it('returns empty settings initially (project settings come from settings.json)', async () => {
    const settings = await getSettings();
    // Project settings are now file-based; DB only has plugin settings
    // A fresh test DB has no plugin settings, so the result is whatever is in the test settings.json
    expect(typeof settings).toBe('object');
  });

  it('writes and reads project settings via file', async () => {
    await updateSetting('detail_position', 'bottom');
    const settings = await getSettings();
    expect(settings.detail_position).toBe('bottom');
  });

  it('writes and reads plugin settings via DB', async () => {
    await updateSetting('plugin:test:api_key', 'secret123');
    const settings = await getSettings();
    expect(settings['plugin:test:api_key']).toBe('secret123');
  });

  it('inserts new project setting key', async () => {
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

  it('respects custom threshold values', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup custom threshold');
    // Set verified_at to 6 days ago
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '6 days' WHERE id = $1`,
      [t.id]
    );
    // With 5-day threshold, should be included
    const forCleanup5 = await getTicketsForCleanup(5, 3);
    expect(forCleanup5.map(c => c.id)).toContain(t.id);
    // With 7-day threshold, should not be included
    const forCleanup7 = await getTicketsForCleanup(7, 3);
    expect(forCleanup7.map(c => c.id)).not.toContain(t.id);
  });

  it('uses default thresholds when not provided', async () => {
    const db = await getDb();
    const t = await createTicket('Cleanup defaults');
    await db.query(
      `UPDATE tickets SET status = 'verified', verified_at = NOW() - INTERVAL '31 days' WHERE id = $1`,
      [t.id]
    );
    // Default is 30 days for verified, 3 days for trash
    const forCleanup = await getTicketsForCleanup();
    expect(forCleanup.map(c => c.id)).toContain(t.id);
  });
});

describe('hardDeleteTicket', () => {
  it('permanently removes the ticket from the database', async () => {
    const t = await createTicket('Hard delete permanent');
    expect(await getTicket(t.id)).not.toBeNull();
    await hardDeleteTicket(t.id);
    expect(await getTicket(t.id)).toBeNull();
  });

  it('does not throw for non-existent ticket id', async () => {
    await expect(hardDeleteTicket(99999)).resolves.not.toThrow();
  });

  it('removes ticket from all query results', async () => {
    const t = await createTicket('Hard delete query', { category: 'bug' });
    await hardDeleteTicket(t.id);
    const allTickets = await getTickets();
    expect(allTickets.map(x => x.id)).not.toContain(t.id);
  });
});

describe('editNote', () => {
  it('edits an existing note by id', async () => {
    const t = await createTicket('Edit note test');
    await updateTicket(t.id, { notes: 'Original note' });
    const ticket = await getTicket(t.id);
    const notes = parseNotes(ticket!.notes);
    const noteId = notes[0].id;

    const result = await editNote(t.id, noteId, 'Updated note');
    expect(result).not.toBeNull();
    const updated = result!.find(n => n.id === noteId);
    expect(updated!.text).toBe('Updated note');
  });

  it('returns null for non-existent ticket', async () => {
    const result = await editNote(99999, 'n_fake', 'text');
    expect(result).toBeNull();
  });

  it('returns null for non-existent note id', async () => {
    const t = await createTicket('Edit note missing');
    await updateTicket(t.id, { notes: 'A note' });
    const result = await editNote(t.id, 'n_nonexistent', 'text');
    expect(result).toBeNull();
  });

  it('preserves other notes when editing one', async () => {
    const t = await createTicket('Edit note preserve');
    await updateTicket(t.id, { notes: 'Note 1' });
    await updateTicket(t.id, { notes: 'Note 2' });
    const ticket = await getTicket(t.id);
    const notes = parseNotes(ticket!.notes);
    const firstNoteId = notes[0].id;

    const result = await editNote(t.id, firstNoteId, 'Edited Note 1');
    expect(result).toHaveLength(2);
    expect(result![0].text).toBe('Edited Note 1');
    expect(result![1].text).toBe('Note 2');
  });
});

describe('deleteNote', () => {
  it('deletes a note by id', async () => {
    const t = await createTicket('Delete note test');
    await updateTicket(t.id, { notes: 'Note to delete' });
    const ticket = await getTicket(t.id);
    const notes = parseNotes(ticket!.notes);
    const noteId = notes[0].id;

    const result = await deleteNote(t.id, noteId);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(0);
  });

  it('returns null for non-existent ticket', async () => {
    const result = await deleteNote(99999, 'n_fake');
    expect(result).toBeNull();
  });

  it('returns null for non-existent note id', async () => {
    const t = await createTicket('Delete note missing');
    await updateTicket(t.id, { notes: 'A note' });
    const result = await deleteNote(t.id, 'n_nonexistent');
    expect(result).toBeNull();
  });

  it('preserves other notes when deleting one', async () => {
    const t = await createTicket('Delete note preserve');
    await updateTicket(t.id, { notes: 'Keep me' });
    await updateTicket(t.id, { notes: 'Delete me' });
    const ticket = await getTicket(t.id);
    const notes = parseNotes(ticket!.notes);
    const deleteId = notes[1].id;

    const result = await deleteNote(t.id, deleteId);
    expect(result).toHaveLength(1);
    expect(result![0].text).toBe('Keep me');
  });

  it('persists the deletion to the database', async () => {
    const t = await createTicket('Delete note persist');
    await updateTicket(t.id, { notes: 'Note 1' });
    await updateTicket(t.id, { notes: 'Note 2' });
    const ticket = await getTicket(t.id);
    const notes = parseNotes(ticket!.notes);

    await deleteNote(t.id, notes[0].id);
    // Re-read from DB
    const updated = await getTicket(t.id);
    const remaining = parseNotes(updated!.notes);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].text).toBe('Note 2');
  });
});

describe('parseNotes', () => {
  it('returns empty array for empty string', () => {
    expect(parseNotes('')).toEqual([]);
  });

  it('returns empty array for null-like input', () => {
    expect(parseNotes(null as unknown as string)).toEqual([]);
  });

  it('parses JSON array of notes', () => {
    const json = JSON.stringify([
      { id: 'n1', text: 'Note 1', created_at: '2024-01-01T00:00:00Z' },
      { id: 'n2', text: 'Note 2', created_at: '2024-01-02T00:00:00Z' },
    ]);
    const notes = parseNotes(json);
    expect(notes).toHaveLength(2);
    expect(notes[0].text).toBe('Note 1');
    expect(notes[1].text).toBe('Note 2');
  });

  it('assigns IDs to legacy notes without them', () => {
    const json = JSON.stringify([
      { text: 'Legacy', created_at: '2024-01-01T00:00:00Z' },
    ]);
    const notes = parseNotes(json);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBeTruthy();
    expect(notes[0].text).toBe('Legacy');
  });

  it('wraps plain text as a single note entry', () => {
    const notes = parseNotes('Just plain text');
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('Just plain text');
    expect(notes[0].id).toBeTruthy();
    expect(notes[0].created_at).toBeTruthy();
  });
});

describe('getCategories', () => {
  it('returns DEFAULT_CATEGORIES when no custom categories set', async () => {
    const categories = await getCategories();
    expect(categories).toHaveLength(6);
    expect(categories[0].id).toBe('issue');
    expect(categories[1].id).toBe('bug');
  });

  it('returns custom categories when saved', async () => {
    const custom = [
      { id: 'epic', label: 'Epic', shortLabel: 'EPC', color: '#8b5cf6', shortcutKey: 'e', description: 'Epics' },
    ];
    await saveCategories(custom);
    const categories = await getCategories();
    expect(categories).toHaveLength(1);
    expect(categories[0].id).toBe('epic');
  });

  it('returns defaults when stored JSON is invalid', async () => {
    await updateSetting('categories', 'not valid json');
    const categories = await getCategories();
    expect(categories).toHaveLength(6); // DEFAULT_CATEGORIES length
  });

  it('returns defaults when stored array is empty', async () => {
    await updateSetting('categories', '[]');
    const categories = await getCategories();
    expect(categories).toHaveLength(6);
  });
});

describe('saveCategories', () => {
  it('saves and retrieves categories round-trip', async () => {
    const custom = [
      { id: 'task', label: 'Task', shortLabel: 'TSK', color: '#3b82f6', shortcutKey: 't', description: 'Tasks' },
      { id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#ef4444', shortcutKey: 'b', description: 'Bugs' },
    ];
    await saveCategories(custom);
    const result = await getCategories();
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('task');
    expect(result[1].id).toBe('bug');
  });
});

describe('duplicateTickets', () => {
  it('creates a copy with " - Copy" suffix', async () => {
    const t = await createTicket('Original ticket', { category: 'bug', priority: 'high' });
    const copies = await duplicateTickets([t.id]);
    expect(copies).toHaveLength(1);
    expect(copies[0].title).toBe('Original ticket - Copy');
    expect(copies[0].category).toBe('bug');
    expect(copies[0].priority).toBe('high');
  });

  it('handles duplicate copy names with numeric suffix', async () => {
    const t = await createTicket('Dup test', { category: 'task' });
    const copy1 = await duplicateTickets([t.id]);
    expect(copy1[0].title).toBe('Dup test - Copy');
    const copy2 = await duplicateTickets([t.id]);
    expect(copy2[0].title).toBe('Dup test - Copy 2');
    const copy3 = await duplicateTickets([t.id]);
    expect(copy3[0].title).toBe('Dup test - Copy 3');
  });

  it('duplicates multiple tickets at once', async () => {
    const t1 = await createTicket('Multi dup 1');
    const t2 = await createTicket('Multi dup 2');
    const copies = await duplicateTickets([t1.id, t2.id]);
    expect(copies).toHaveLength(2);
    expect(copies[0].title).toBe('Multi dup 1 - Copy');
    expect(copies[1].title).toBe('Multi dup 2 - Copy');
  });

  it('skips non-existent ticket ids', async () => {
    const t = await createTicket('Dup with missing');
    const copies = await duplicateTickets([t.id, 99999]);
    expect(copies).toHaveLength(1);
    expect(copies[0].title).toBe('Dup with missing - Copy');
  });

  it('preserves up_next and details on copy', async () => {
    const t = await createTicket('Dup details', { up_next: true, details: 'Important stuff' });
    const copies = await duplicateTickets([t.id]);
    expect(copies[0].up_next).toBe(true);
    expect(copies[0].details).toBe('Important stuff');
  });
});

describe('queryTickets', () => {
  let queryBug: number;
  let queryFeature: number;
  let queryTask: number;

  beforeAll(async () => {
    const b = await createTicket('Query bug ticket', { category: 'bug', priority: 'high' });
    queryBug = b.id;
    const f = await createTicket('Query feature ticket', { category: 'feature', priority: 'low', up_next: true });
    queryFeature = f.id;
    const k = await createTicket('Query task ticket', { category: 'task', priority: 'highest' });
    queryTask = k.id;
  });

  it('filters with equals operator', async () => {
    const results = await queryTickets('all', [{ field: 'category', operator: 'equals', value: 'bug' }]);
    const ids = results.map(r => r.id);
    expect(ids).toContain(queryBug);
    expect(ids).not.toContain(queryFeature);
  });

  it('filters with not_equals operator', async () => {
    const results = await queryTickets('all', [{ field: 'category', operator: 'not_equals', value: 'bug' }]);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(queryBug);
    expect(ids).toContain(queryFeature);
  });

  it('filters with contains operator', async () => {
    const results = await queryTickets('all', [{ field: 'title', operator: 'contains', value: 'Query bug' }]);
    const ids = results.map(r => r.id);
    expect(ids).toContain(queryBug);
    expect(ids).not.toContain(queryFeature);
  });

  it('filters with not_contains operator', async () => {
    const results = await queryTickets('all', [{ field: 'title', operator: 'not_contains', value: 'bug' }]);
    const ids = results.map(r => r.id);
    expect(ids).not.toContain(queryBug);
    expect(ids).toContain(queryFeature);
  });

  it('uses ANY logic to match any condition', async () => {
    const results = await queryTickets('any', [
      { field: 'category', operator: 'equals', value: 'bug' },
      { field: 'category', operator: 'equals', value: 'feature' },
    ]);
    const ids = results.map(r => r.id);
    expect(ids).toContain(queryBug);
    expect(ids).toContain(queryFeature);
  });

  it('uses ALL logic to require all conditions', async () => {
    const results = await queryTickets('all', [
      { field: 'category', operator: 'equals', value: 'bug' },
      { field: 'priority', operator: 'equals', value: 'high' },
    ]);
    const ids = results.map(r => r.id);
    expect(ids).toContain(queryBug);
    expect(ids).not.toContain(queryTask);
  });

  it('always excludes deleted tickets', async () => {
    const t = await createTicket('Query deleted');
    await deleteTicket(t.id);
    const results = await queryTickets('all', [{ field: 'title', operator: 'contains', value: 'Query deleted' }]);
    expect(results.map(r => r.id)).not.toContain(t.id);
  });

  it('supports ordinal comparison on priority', async () => {
    // priority high = 2, so gte 2 (high or worse) should include high but not highest
    const results = await queryTickets('all', [{ field: 'priority', operator: 'gte', value: 'high' }]);
    const priorities = results.map(r => r.priority);
    // "gte 2" in ordinal means >= 2 so: high(2), default(3), low(4), lowest(5) are included
    for (const p of priorities) {
      expect(['high', 'default', 'low', 'lowest']).toContain(p);
    }
  });

  it('filters by up_next field', async () => {
    const results = await queryTickets('all', [{ field: 'up_next', operator: 'equals', value: 'true' }]);
    for (const r of results) {
      expect(r.up_next).toBe(true);
    }
    expect(results.map(r => r.id)).toContain(queryFeature);
  });

  it('ignores non-queryable fields', async () => {
    // 'id' is not in QUERYABLE_FIELDS so condition is skipped
    const results = await queryTickets('all', [{ field: 'id', operator: 'equals', value: '1' }]);
    // Should return all non-deleted tickets since the condition was skipped
    expect(results.length).toBeGreaterThan(0);
  });

  it('sorts results by specified field', async () => {
    const results = await queryTickets('all', [], 'priority', 'asc');
    const priorities = results.map(r => r.priority);
    const order = ['highest', 'high', 'default', 'low', 'lowest'];
    for (let i = 1; i < priorities.length; i++) {
      expect(order.indexOf(priorities[i])).toBeGreaterThanOrEqual(order.indexOf(priorities[i - 1]));
    }
  });
});

describe('extractBracketTags', () => {
  it('extracts bracket tags and cleans title', () => {
    const result = extractBracketTags('[frontend] Fix the login button');
    expect(result.title).toBe('Fix the login button');
    expect(result.tags).toEqual(['frontend']);
  });

  it('extracts multiple tags', () => {
    const result = extractBracketTags('[frontend] [urgent] Fix the bug');
    expect(result.title).toBe('Fix the bug');
    expect(result.tags).toContain('frontend');
    expect(result.tags).toContain('urgent');
  });

  it('normalizes tag content', () => {
    const result = extractBracketTags('[Front-End!!!] Something');
    expect(result.tags).toEqual(['front end']);
  });

  it('deduplicates tags', () => {
    const result = extractBracketTags('[api] [API] Something');
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]).toBe('api');
  });

  it('returns empty tags for no brackets', () => {
    const result = extractBracketTags('No tags here');
    expect(result.title).toBe('No tags here');
    expect(result.tags).toEqual([]);
  });

  it('handles empty brackets', () => {
    const result = extractBracketTags('[] Something');
    expect(result.title).toBe('Something');
    expect(result.tags).toEqual([]);
  });
});

describe('getAllTags', () => {
  it('returns all unique tags across tickets', async () => {
    await createTicket('Tag test 1', { tags: JSON.stringify(['alpha', 'beta']) });
    await createTicket('Tag test 2', { tags: JSON.stringify(['beta', 'gamma']) });
    const tags = await getAllTags();
    expect(tags).toContain('alpha');
    expect(tags).toContain('beta');
    expect(tags).toContain('gamma');
  });

  it('returns tags in sorted order', async () => {
    const tags = await getAllTags();
    for (let i = 1; i < tags.length; i++) {
      expect(tags[i] >= tags[i - 1]).toBe(true);
    }
  });

  it('excludes tags from deleted tickets', async () => {
    const t = await createTicket('Deleted tag', { tags: JSON.stringify(['deleted-only-tag']) });
    await deleteTicket(t.id);
    const tags = await getAllTags();
    expect(tags).not.toContain('deleted-only-tag');
  });
});
