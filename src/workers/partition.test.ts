// HS-8965 — AI partition helper: pure logic (clustering fallback + parse) +
// HS-9080 the tag-scoped DB path (AI provider mocked to null → deterministic).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import {
  clusterPartition, parsePartition, partitionTickets, type PendingTicketRow, roundRobinPartition, type WorkerRefInput,
} from './partition.js';

// Force the deterministic clustering path (no live AI provider in unit tests).
vi.mock('./announcerJson.js', () => ({ callAnnouncerJson: () => Promise.resolve(null) }));

const row = (id: number): PendingTicketRow => ({
  id, ticketNumber: `HS-${String(id)}`, title: `t${String(id)}`, category: 'feature', tags: [], blocked: false,
});
/** Richer row for the clustering tests (custom title / tags). */
const rowT = (id: number, opts: { title?: string; tags?: string[] } = {}): PendingTicketRow => ({
  id, ticketNumber: `HS-${String(id)}`, title: opts.title ?? `t${String(id)}`, category: 'feature', tags: opts.tags ?? [], blocked: false,
});
const W: WorkerRefInput[] = [{ worker: 'w1', label: 'worker-1' }, { worker: 'w2', label: 'worker-2' }];

describe('roundRobinPartition (HS-8965)', () => {
  it('distributes tickets across workers in order', () => {
    const out = roundRobinPartition([row(1), row(2), row(3)], W);
    expect(out.map(a => a.label)).toEqual(['worker-1', 'worker-2']);
    expect(out[0].ticketIds).toEqual([1, 3]);
    expect(out[1].ticketIds).toEqual([2]);
    expect(out[0].ticketNumbers).toEqual(['HS-1', 'HS-3']);
  });
  it('returns [] for no workers', () => {
    expect(roundRobinPartition([row(1)], [])).toEqual([]);
  });
});

describe('clusterPartition (HS-9073, docs/98 §98.2)', () => {
  it('groups tickets that share a tag onto the same worker (and keeps unrelated ones off it)', () => {
    const out = clusterPartition([
      rowT(1, { tags: ['auth'] }),
      rowT(2, { tags: ['auth'] }),
      rowT(3, { tags: ['ui'] }),
    ], W);
    const w1 = out.find(a => a.ticketIds.includes(1));
    expect(w1?.ticketIds).toEqual(expect.arrayContaining([1, 2]));
    expect(w1?.ticketIds).not.toContain(3);
  });

  it('isolates a large/risky ticket onto its own chunk even when it shares a tag', () => {
    const out = clusterPartition([
      rowT(1, { tags: ['db'] }),
      rowT(2, { tags: ['db'], title: 'Migrate the users table to the new schema' }),
    ], W);
    // The migration (risky) is NOT batched with ticket 1 despite the shared `db` tag.
    const with1 = out.find(a => a.ticketIds.includes(1));
    expect(with1?.ticketIds).not.toContain(2);
    // Both tickets are still placed (exactly once each across the workers).
    const all = out.flatMap(a => a.ticketIds).sort((x, y) => x - y);
    expect(all).toEqual([1, 2]);
  });

  it('spreads independent (no shared tag) tickets evenly across workers', () => {
    const out = clusterPartition([rowT(1), rowT(2), rowT(3), rowT(4)], W);
    expect(out[0].ticketIds.length).toBe(2);
    expect(out[1].ticketIds.length).toBe(2);
    // No ticket dropped or duplicated.
    expect(out.flatMap(a => a.ticketIds).sort((x, y) => x - y)).toEqual([1, 2, 3, 4]);
  });

  it('keeps a 3-ticket related cluster intact on one worker rather than splitting it', () => {
    const out = clusterPartition([
      rowT(1, { tags: ['search'] }), rowT(2, { tags: ['search'] }), rowT(3, { tags: ['search'] }),
      rowT(4, { tags: ['billing'] }),
    ], W);
    const w = out.find(a => a.ticketIds.includes(1));
    expect(w?.ticketIds).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(w?.ticketIds).not.toContain(4);
  });

  it('empty rows → empty assignments; no workers → []', () => {
    expect(clusterPartition([], W).every(a => a.ticketIds.length === 0)).toBe(true);
    expect(clusterPartition([rowT(1)], [])).toEqual([]);
  });
});

describe('parsePartition (HS-8965)', () => {
  const rows = [row(1), row(2), row(3)];

  it('maps the model assignment to ids per worker (one entry per input worker)', () => {
    const text = '{"assignments":[{"worker":"worker-1","tickets":["HS-1","HS-3"]},{"worker":"worker-2","tickets":["HS-2"]}]}';
    const out = parsePartition(text, rows, W)!;
    expect(out.map(a => a.label)).toEqual(['worker-1', 'worker-2']);
    expect(out[0].ticketIds).toEqual([1, 3]);
    expect(out[1].ticketIds).toEqual([2]);
  });

  it('drops unknown workers, unknown tickets, and duplicates', () => {
    const text = '{"assignments":[{"worker":"worker-1","tickets":["HS-1","HS-1","HS-99"]},{"worker":"ghost","tickets":["HS-2"]}]}';
    const out = parsePartition(text, rows, W)!;
    expect(out[0].ticketIds).toEqual([1]);   // HS-1 once, HS-99 unknown dropped
    expect(out[1].ticketIds).toEqual([]);    // "ghost" isn't a real worker
  });

  it('tolerates a code fence and returns null on garbage', () => {
    const fenced = '```json\n{"assignments":[{"worker":"worker-1","tickets":["HS-2"]}]}\n```';
    expect(parsePartition(fenced, rows, W)![0].ticketIds).toEqual([2]);
    expect(parsePartition('not json', rows, W)).toBeNull();
  });
});

describe('partitionTickets — tag scope (HS-9080)', () => {
  let dir: string;
  const w1: WorkerRefInput[] = [{ worker: 'w1', label: 'worker-1' }];

  beforeEach(async () => {
    dir = await setupTestDb();
    const { getDb } = await import('../db/connection.js');
    const db = await getDb();
    await db.query(`INSERT INTO tickets (ticket_number, title, up_next, tags) VALUES
      ('HS-1', 'refactor a', TRUE, '["refactor"]'),
      ('HS-2', 'refactor b', TRUE, '["refactor"]'),
      ('HS-3', 'ui thing',   TRUE, '["ui"]')`);
  });
  afterEach(async () => { await cleanupTestDb(dir); });

  it('partitions ONLY the unblocked Up Next tickets carrying the tag', async () => {
    const out = await partitionTickets(w1, { tag: 'refactor' });
    const nums = out.flatMap(a => a.ticketNumbers).sort();
    expect(nums).toEqual(['HS-1', 'HS-2']);
    expect(nums).not.toContain('HS-3');
  });

  it('with no tag, partitions the whole unblocked Up Next set', async () => {
    const out = await partitionTickets(w1);
    expect(out.flatMap(a => a.ticketNumbers).sort()).toEqual(['HS-1', 'HS-2', 'HS-3']);
  });

  it('returns empty assignments when no ticket carries the tag', async () => {
    const out = await partitionTickets(w1, { tag: 'nonexistent' });
    expect(out.every(a => a.ticketIds.length === 0)).toBe(true);
  });
});
