// HS-9236 — rotating JSONL raw-telemetry store. Covers the append/read round-trip,
// day partitioning, crash-tolerant reads (torn last line), concurrent-append
// non-interleaving, and the age-delete sweeper.
import { promises as fsp, rmSync } from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir } from '../test-helpers.js';
import {
  _resetOtelJsonlForTesting,
  appendOtelJsonl,
  dayRange,
  jsonlFileDay,
  listOtelJsonlDays,
  otelJsonlPath,
  readAllOtelJsonl,
  readOtelJsonlDay,
  readOtelJsonlRange,
  sweepOtelJsonl,
} from './otelJsonlStore.js';
import { serverLocalDay } from './otelRollupIngest.js';

let dir: string;
beforeEach(() => { dir = createTempDir(); _resetOtelJsonlForTesting(); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('appendOtelJsonl / readOtelJsonlDay', () => {
  it('round-trips rows to the server-local day file', async () => {
    const ts = new Date(2026, 5, 30, 10, 0, 0);
    const day = serverLocalDay(ts);
    await appendOtelJsonl(dir, 'events', ts, { prompt_id: 'p1', event_name: 'user_prompt' });
    await appendOtelJsonl(dir, 'events', ts, { prompt_id: 'p2', event_name: 'api_request' });

    const rows = await readOtelJsonlDay(dir, 'events', day);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ prompt_id: 'p1', event_name: 'user_prompt' });
    expect(rows[1]).toMatchObject({ prompt_id: 'p2', event_name: 'api_request' });
  });

  it('partitions by day and by kind (separate files)', async () => {
    const d1 = new Date(2026, 5, 30, 9, 0, 0);
    const d2 = new Date(2026, 6, 1, 9, 0, 0);
    await appendOtelJsonl(dir, 'metrics', d1, { metric_name: 'cost', v: 1 });
    await appendOtelJsonl(dir, 'metrics', d2, { metric_name: 'cost', v: 2 });
    await appendOtelJsonl(dir, 'events', d1, { event_name: 'x' });

    expect(await readOtelJsonlDay(dir, 'metrics', serverLocalDay(d1))).toHaveLength(1);
    expect(await readOtelJsonlDay(dir, 'metrics', serverLocalDay(d2))).toHaveLength(1);
    expect(await readOtelJsonlDay(dir, 'events', serverLocalDay(d1))).toHaveLength(1);
    // metrics d1 file has only the d1 metric, not d2's or the event.
    expect((await readOtelJsonlDay(dir, 'metrics', serverLocalDay(d1)))[0]).toMatchObject({ v: 1 });
  });

  it('returns [] for an absent day file', async () => {
    expect(await readOtelJsonlDay(dir, 'spans', '2026-01-01')).toEqual([]);
  });

  it('skips a torn last line + blank lines (crash tolerance)', async () => {
    const ts = new Date(2026, 5, 30, 10, 0, 0);
    const day = serverLocalDay(ts);
    await appendOtelJsonl(dir, 'events', ts, { ok: 1 });
    // Simulate an unclean shutdown mid-append: a partial (unparseable) trailing
    // line with no newline, plus a stray blank line.
    await fsp.appendFile(otelJsonlPath(dir, 'events', day), '\n{"ok":2}\n{"partial":', 'utf8');

    const rows = await readOtelJsonlDay(dir, 'events', day);
    // The two complete objects survive; the torn `{"partial":` is skipped.
    expect(rows).toEqual([{ ok: 1 }, { ok: 2 }]);
  });

  it('concurrent appends to the same file do not interleave (all lines parse)', async () => {
    const ts = new Date(2026, 5, 30, 10, 0, 0);
    const day = serverLocalDay(ts);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => appendOtelJsonl(dir, 'events', ts, { i, pad: 'xxxxxxxxxxxxxxxxxxxx' })),
    );
    const rows = await readOtelJsonlDay(dir, 'events', day);
    expect(rows).toHaveLength(50); // none lost, none corrupted mid-line
    expect(new Set(rows.map(r => r.i)).size).toBe(50);
  });
});

describe('jsonlFileDay', () => {
  it('parses the day out of a valid filename', () => {
    expect(jsonlFileDay('otel-events-2026-06-30.jsonl')).toBe('2026-06-30');
    expect(jsonlFileDay('otel-metrics-2026-01-02.jsonl')).toBe('2026-01-02');
    expect(jsonlFileDay('otel-spans-2026-12-31.jsonl')).toBe('2026-12-31');
  });
  it('returns null for non-matching names', () => {
    expect(jsonlFileDay('freeze.log')).toBeNull();
    expect(jsonlFileDay('otel-events.jsonl')).toBeNull();
    expect(jsonlFileDay('otel-other-2026-06-30.jsonl')).toBeNull();
    expect(jsonlFileDay('otel-events-2026-6-3.jsonl')).toBeNull();
  });
});

describe('dayRange (HS-9237)', () => {
  it('enumerates an inclusive day range', () => {
    expect(dayRange('2026-06-29', '2026-07-02')).toEqual(['2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02']);
  });
  it('crosses a month boundary correctly', () => {
    expect(dayRange('2026-01-30', '2026-02-02')).toEqual(['2026-01-30', '2026-01-31', '2026-02-01', '2026-02-02']);
  });
  it('returns a single day when from === to', () => {
    expect(dayRange('2026-06-30', '2026-06-30')).toEqual(['2026-06-30']);
  });
  it('returns [] when from > to', () => {
    expect(dayRange('2026-07-02', '2026-06-30')).toEqual([]);
  });
});

describe('readOtelJsonlRange (HS-9237)', () => {
  it('concatenates rows across a day range in day order, skipping missing days', async () => {
    const d1 = new Date('2026-06-29T10:00:00Z');
    const d3 = new Date('2026-07-01T10:00:00Z');
    // Seed day 1 and day 3; day 2 (2026-06-30) is intentionally absent.
    await appendOtelJsonl(dir, 'events', d1, { prompt_id: 'p1' });
    await appendOtelJsonl(dir, 'events', d1, { prompt_id: 'p2' });
    await appendOtelJsonl(dir, 'events', d3, { prompt_id: 'p3' });

    const rows = await readOtelJsonlRange(dir, 'events', serverLocalDay(d1), serverLocalDay(d3));
    expect(rows.map(r => r.prompt_id)).toEqual(['p1', 'p2', 'p3']);
  });

  it('returns [] for an empty range with no files', async () => {
    expect(await readOtelJsonlRange(dir, 'spans', '2026-01-01', '2026-01-03')).toEqual([]);
  });

  it('does not bleed rows from an adjacent day outside the range', async () => {
    const inRange = new Date('2026-06-29T10:00:00Z');
    const after = new Date('2026-07-01T10:00:00Z');
    await appendOtelJsonl(dir, 'events', inRange, { prompt_id: 'in' });
    await appendOtelJsonl(dir, 'events', after, { prompt_id: 'out' });
    const rows = await readOtelJsonlRange(dir, 'events', serverLocalDay(inRange), serverLocalDay(inRange));
    expect(rows.map(r => r.prompt_id)).toEqual(['in']);
  });
});

describe('listOtelJsonlDays / readAllOtelJsonl (HS-9278)', () => {
  it('lists only the requested kind’s days, sorted ascending', async () => {
    await appendOtelJsonl(dir, 'events', new Date('2026-07-02T10:00:00Z'), { a: 2 });
    await appendOtelJsonl(dir, 'events', new Date('2026-06-30T10:00:00Z'), { a: 1 });
    await appendOtelJsonl(dir, 'spans', new Date('2026-06-30T10:00:00Z'), { s: 1 });
    const eventDays = await listOtelJsonlDays(dir, 'events');
    // events on two days, ascending; the spans file must not leak in. (Assert
    // length + sortedness rather than exact labels — server-local day may shift.)
    expect(eventDays).toHaveLength(2);
    expect([...eventDays]).toEqual([...eventDays].sort());
    expect(await listOtelJsonlDays(dir, 'spans')).toHaveLength(1);
    expect(await listOtelJsonlDays(dir, 'metrics')).toEqual([]);
  });

  it('reads every extant row for a kind across all day files in day order', async () => {
    await appendOtelJsonl(dir, 'events', new Date('2026-07-02T10:00:00Z'), { n: 2 });
    await appendOtelJsonl(dir, 'events', new Date('2026-06-30T10:00:00Z'), { n: 1 });
    const rows = await readAllOtelJsonl(dir, 'events');
    expect(rows.map(r => r.n)).toEqual([1, 2]); // day-sorted: 06-30 before 07-02
  });

  it('returns [] for a missing dir / absent kind', async () => {
    expect(await readAllOtelJsonl(dir, 'metrics')).toEqual([]);
    expect(await listOtelJsonlDays(`${dir}/nope`, 'events')).toEqual([]);
  });
});

describe('sweepOtelJsonl', () => {
  async function seedDay(kind: 'events' | 'metrics' | 'spans', day: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join0(dir, `otel-${kind}-${day}.jsonl`), '{"x":1}\n', 'utf8');
  }
  // local join to avoid importing path twice in the test body
  function join0(a: string, b: string): string { return `${a}/${b}`; }

  it('deletes files older than maxAgeDays, keeps recent, and returns the count', async () => {
    const now = new Date(2026, 6, 10, 12, 0, 0); // 2026-07-10
    await seedDay('events', '2026-07-10'); // today — keep
    await seedDay('events', '2026-07-04'); // 6 days old — keep (>= cutoff at 7d)
    await seedDay('metrics', '2026-06-20'); // 20 days old — delete
    await seedDay('spans', '2026-05-01');   // way old — delete
    // A non-matching file must be left alone.
    await fsp.writeFile(join0(dir, 'freeze.log'), 'x', 'utf8');

    const removed = await sweepOtelJsonl(dir, 7, now);
    expect(removed).toBe(2);
    const remaining = (await fsp.readdir(dir)).sort();
    expect(remaining).toEqual(['freeze.log', 'otel-events-2026-07-04.jsonl', 'otel-events-2026-07-10.jsonl']);
  });

  it('maxAgeDays <= 0 disables the sweep (keep forever)', async () => {
    await seedDay('events', '2020-01-01');
    expect(await sweepOtelJsonl(dir, 0, new Date(2026, 6, 10))).toBe(0);
    expect(await fsp.readdir(dir)).toContain('otel-events-2020-01-01.jsonl');
  });

  it('is a no-op on a missing directory', async () => {
    expect(await sweepOtelJsonl(join0(dir, 'nope'), 7)).toBe(0);
  });
});
