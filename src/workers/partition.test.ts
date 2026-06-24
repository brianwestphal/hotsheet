// HS-8965 — AI partition helper: pure logic (round-robin fallback + parse). The
// live AI call + DB fetch run in the app; the provider routing mirrors the tested
// announcerJson/summarize path (docs/92 §92.6).
import { describe, expect, it } from 'vitest';

import {
  parsePartition, type PendingTicketRow, roundRobinPartition, type WorkerRefInput,
} from './partition.js';

const row = (id: number): PendingTicketRow => ({
  id, ticketNumber: `HS-${String(id)}`, title: `t${String(id)}`, category: 'feature', tags: [], blocked: false,
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
