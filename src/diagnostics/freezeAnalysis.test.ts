/**
 * HS-9531 — tests for the freeze-log analysis.
 *
 * These are written against the two mistakes the HS-9521 investigation actually
 * made, because those are the ones that will be made again:
 *
 *  1. Summing wall-measured async spans as if they were blocked time.
 *  2. Correlating the heartbeat against an incomplete set of causes.
 *
 * Both produced confident, specific, wrong numbers — the failure mode where a
 * green-looking analysis sends the next person to fix the wrong thing.
 */

import { describe, expect, it } from 'vitest';

import {
  attributeBlocks,
  formatReport,
  isBlocking,
  parseFreezeLog,
  rankByContext,
  summarizeBlocking,
} from './freezeAnalysis.js';
import type { FreezeEntry } from './freezeLogger.js';

const at = (iso: string): string => iso;

const beat = (ts: string, ms: number): FreezeEntry => ({
  ts: at(ts), source: 'server-heartbeat', durationMs: ms,
  context: 'event-loop blocked', blocking: true, project: 'hotsheet',
});
const asyncSpan = (ts: string, ms: number, context: string, project = 'hotsheet'): FreezeEntry => ({
  ts: at(ts), source: 'server-instrument-async', durationMs: ms, context, blocking: false, project,
});
const syncSpan = (ts: string, ms: number, context: string, project = 'hotsheet'): FreezeEntry => ({
  ts: at(ts), source: 'server-instrument-sync', durationMs: ms, context, blocking: true, project,
});

describe('isBlocking', () => {
  it('trusts the explicit flag', () => {
    expect(isBlocking(asyncSpan('2026-07-31T00:00:00.000Z', 100, 'x'))).toBe(false);
    expect(isBlocking(syncSpan('2026-07-31T00:00:00.000Z', 100, 'x'))).toBe(true);
  });

  it('falls back to the source for entries written before the flag existed', () => {
    // An existing log must still analyse correctly rather than silently reporting
    // zero blocking, which would read as "the problem went away".
    const legacyBeat = { ts: at('2026-07-31T00:00:00.000Z'), source: 'server-heartbeat', durationMs: 200, context: 'event-loop blocked' } as FreezeEntry;
    const legacyAsync = { ts: at('2026-07-31T00:00:00.000Z'), source: 'server-instrument-async', durationMs: 9000, context: 'fsyncDbDir:backup:5min' } as FreezeEntry;
    expect(isBlocking(legacyBeat)).toBe(true);
    expect(isBlocking(legacyAsync)).toBe(false);
  });
});

describe('summarizeBlocking', () => {
  it('counts ONLY heartbeat gaps, so a huge async span cannot inflate the figure', () => {
    // The HS-9521 error in one assertion. The async span is 17 s — larger than
    // everything else combined — and contributes nothing.
    const entries = [
      beat('2026-07-31T00:00:01.000Z', 500),
      beat('2026-07-31T00:00:02.000Z', 300),
      asyncSpan('2026-07-31T00:00:20.000Z', 17_000, 'fsyncDbDir:backup:5min'),
    ];
    const s = summarizeBlocking(entries);
    expect(s.blockedMs).toBe(800);
    expect(s.worstMs).toBe(500);
    expect(s.count).toBe(2);
  });

  it('does not double-count a sync block against the heartbeat gap it causes', () => {
    // A sync block appears twice in the log: as its own entry, and as the
    // heartbeat gap it produced. Adding both would roughly double the total.
    const entries = [
      syncSpan('2026-07-31T00:00:01.000Z', 400, 'pglite.query'),
      beat('2026-07-31T00:00:01.050Z', 400),
    ];
    expect(summarizeBlocking(entries).blockedMs).toBe(400);
  });

  it('computes the ratio against the observed span when no window is given', () => {
    const entries = [
      beat('2026-07-31T00:00:00.000Z', 1000),
      beat('2026-07-31T01:00:00.000Z', 1000),
    ];
    const s = summarizeBlocking(entries);
    expect(s.windowMs).toBe(3_600_000);
    expect(s.blockedRatio).toBeCloseTo(2000 / 3_600_000, 8);
  });

  it('honors an explicit window', () => {
    const entries = [
      beat('2026-07-31T00:00:00.000Z', 1000),
      beat('2026-07-31T05:00:00.000Z', 9999),
    ];
    const s = summarizeBlocking(entries, {
      fromMs: Date.parse('2026-07-31T00:00:00.000Z'),
      toMs: Date.parse('2026-07-31T01:00:00.000Z'),
    });
    expect(s.blockedMs).toBe(1000); // the 05:00 block is outside
  });
});

describe('rankByContext', () => {
  it('keeps blocking and wall-measured rows SEPARATE even for the same context', () => {
    const entries = [
      syncSpan('2026-07-31T00:00:01.000Z', 100, 'shared-name'),
      asyncSpan('2026-07-31T00:00:02.000Z', 9000, 'shared-name'),
    ];
    const ranked = rankByContext(entries);
    expect(ranked).toHaveLength(2);
    expect(ranked.find(r => r.blocking)?.totalMs).toBe(100);
    expect(ranked.find(r => !r.blocking)?.totalMs).toBe(9000);
  });

  it('counts distinct projects — the HS-9529 multiplier is the finding', () => {
    // No single run of this is remarkable; nine of them on one loop is.
    const entries = ['a', 'b', 'c'].map((p, i) =>
      asyncSpan(`2026-07-31T00:00:0${String(i)}.000Z`, 900, 'pglite.dumpDataDir: gzip', p));
    expect(rankByContext(entries)[0].projects).toEqual(['a', 'b', 'c']);
  });

  it('ignores memory samples and rotation markers', () => {
    const entries: FreezeEntry[] = [
      { ts: at('2026-07-31T00:00:00.000Z'), source: 'server-memory', durationMs: 0, context: 'periodic memory sample' },
      { ts: at('2026-07-31T00:00:01.000Z'), source: 'freeze.log-truncated', durationMs: 0, context: 'head dropped' },
      syncSpan('2026-07-31T00:00:02.000Z', 100, 'real'),
    ];
    expect(rankByContext(entries).map(r => r.context)).toEqual(['real']);
  });
});

describe('attributeBlocks', () => {
  it('credits a block to an operation that was in flight, naming its project', () => {
    const entries = [
      asyncSpan('2026-07-31T00:00:02.000Z', 2000, 'pglite.dumpDataDir: gzip', 'kerf'),
      beat('2026-07-31T00:00:01.000Z', 400), // inside the span above
    ];
    const r = attributeBlocks(entries);
    expect(r.attributed).toHaveLength(1);
    expect(r.attributed[0]).toMatchObject({ context: 'pglite.dumpDataDir: gzip', project: 'kerf', blockedMs: 400 });
    expect(r.unattributedMs).toBe(0);
  });

  it('credits the SHORTEST containing span, not the first or the longest', () => {
    // A 5-minute backup train overlapping a block says almost nothing; a 400 ms
    // query overlapping the same block says a great deal.
    const entries = [
      asyncSpan('2026-07-31T00:05:00.000Z', 300_000, 'backup:5min'),
      asyncSpan('2026-07-31T00:00:02.000Z', 500, 'pglite.query'),
      beat('2026-07-31T00:00:01.900Z', 300),
    ];
    expect(attributeBlocks(entries).attributed[0].context).toBe('pglite.query');
  });

  it('reports blocks with nothing running as UNATTRIBUTED rather than guessing', () => {
    // The honest answer. Reporting these as attributed to the nearest span is how
    // an analysis manufactures a culprit.
    const entries = [
      beat('2026-07-31T00:00:01.000Z', 1800),
      asyncSpan('2026-07-31T01:00:00.000Z', 200, 'far-away'),
    ];
    const r = attributeBlocks(entries);
    expect(r.attributed).toHaveLength(0);
    expect(r.unattributedMs).toBe(1800);
    expect(r.unattributedCount).toBe(1);
  });

  it('attributes ACROSS projects — the defect that made HS-9521 wrong', () => {
    // Before HS-9531 the heartbeat wrote to one project's file and the causes to
    // their own, so a block caused by `kerf` while the heartbeat was filed under
    // `hotsheet` looked like it had no cause at all. One log makes this work with
    // no merge step, which is the entire justification for the move.
    const entries = [
      asyncSpan('2026-07-31T00:00:02.000Z', 1500, 'plugin.scheduledSync', 'kerf'),
      beat('2026-07-31T00:00:01.500Z', 900), // heartbeat is project 'hotsheet'
    ];
    const r = attributeBlocks(entries);
    expect(r.unattributedMs).toBe(0);
    expect(r.attributed[0].project).toBe('kerf');
  });
});

describe('parseFreezeLog', () => {
  it('skips a truncated tail line instead of throwing', () => {
    // The file is appended to live, so the last line can be half-written.
    const raw = '{"ts":"2026-07-31T00:00:00.000Z","source":"server-heartbeat","durationMs":100,"context":"a"}\n{"ts":"2026-07-3';
    expect(parseFreezeLog(raw)).toHaveLength(1);
  });

  it('ignores blank lines and non-entry JSON', () => {
    const raw = '\n123\n{"nope":true}\n{"ts":"2026-07-31T00:00:00.000Z","source":"server-heartbeat","durationMs":5,"context":"a"}\n';
    expect(parseFreezeLog(raw)).toHaveLength(1);
  });
});

describe('formatReport', () => {
  it('labels wall-measured spans so they cannot be read as blocking', () => {
    const out = formatReport([
      beat('2026-07-31T00:00:01.000Z', 500),
      asyncSpan('2026-07-31T00:00:20.000Z', 17_000, 'fsyncDbDir:backup:5min'),
    ]);
    expect(out).toContain('NOT blocked time');
    expect(out).toContain('fsyncDbDir:backup:5min');
    // The headline number is the heartbeat's, not the 17 s span's.
    expect(out).toContain('0.5s across 1 blocks');
  });
});
