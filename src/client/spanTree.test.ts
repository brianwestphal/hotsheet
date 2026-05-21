import { describe, expect, it } from 'vitest';

import type { SpanRow } from '../db/otelQueries.js';
import { assembleSpanTree, findEnclosingSpanId } from './spanTree.js';

function row(opts: Partial<SpanRow> & { spanId: string }): SpanRow {
  return {
    id: 0,
    traceId: opts.traceId ?? 'trace-1',
    spanId: opts.spanId,
    parentSpanId: opts.parentSpanId ?? null,
    spanName: opts.spanName ?? 'claude_code.turn',
    startTs: opts.startTs ?? '2026-05-21T10:00:00.000Z',
    endTs: opts.endTs ?? '2026-05-21T10:00:01.000Z',
    attributesJson: opts.attributesJson ?? {},
    statusCode: opts.statusCode ?? null,
  };
}

describe('assembleSpanTree (HS-8475 / §68.4)', () => {
  it('returns an empty array for empty input', () => {
    expect(assembleSpanTree([])).toEqual([]);
  });

  it('builds a single root with two children sorted by startTs', () => {
    const tree = assembleSpanTree([
      row({ spanId: 'b', parentSpanId: 'a', startTs: '2026-05-21T10:00:00.200Z' }),
      row({ spanId: 'c', parentSpanId: 'a', startTs: '2026-05-21T10:00:00.100Z' }),
      row({ spanId: 'a' }),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].row.spanId).toBe('a');
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children).toHaveLength(2);
    expect(tree[0].children[0].row.spanId).toBe('c');
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[1].row.spanId).toBe('b');
    expect(tree[0].children[1].depth).toBe(1);
  });

  it('treats spans with missing parents as roots', () => {
    const tree = assembleSpanTree([
      row({ spanId: 'b', parentSpanId: 'session-root-not-in-result' }),
      row({ spanId: 'c', parentSpanId: null }),
    ]);
    expect(tree).toHaveLength(2);
    const ids = tree.map(n => n.row.spanId).sort();
    expect(ids).toEqual(['b', 'c']);
    for (const root of tree) expect(root.depth).toBe(0);
  });

  it('handles multi-root + deep nesting + per-level sort', () => {
    const tree = assembleSpanTree([
      row({ spanId: 'r2', startTs: '2026-05-21T10:00:01.000Z' }),
      row({ spanId: 'r1', startTs: '2026-05-21T10:00:00.000Z' }),
      row({ spanId: 'r1-a', parentSpanId: 'r1', startTs: '2026-05-21T10:00:00.100Z' }),
      row({ spanId: 'r1-a-x', parentSpanId: 'r1-a', startTs: '2026-05-21T10:00:00.150Z' }),
      row({ spanId: 'r1-a-y', parentSpanId: 'r1-a', startTs: '2026-05-21T10:00:00.110Z' }),
    ]);
    expect(tree).toHaveLength(2);
    expect(tree[0].row.spanId).toBe('r1');
    expect(tree[1].row.spanId).toBe('r2');

    const r1 = tree[0];
    expect(r1.children).toHaveLength(1);
    expect(r1.children[0].row.spanId).toBe('r1-a');
    expect(r1.children[0].depth).toBe(1);

    const r1a = r1.children[0];
    expect(r1a.children).toHaveLength(2);
    expect(r1a.children[0].row.spanId).toBe('r1-a-y');
    expect(r1a.children[1].row.spanId).toBe('r1-a-x');
    expect(r1a.children[0].depth).toBe(2);
  });

  it('uses spanId as a stable tiebreaker when startTs is equal', () => {
    const ts = '2026-05-21T10:00:00.000Z';
    const tree = assembleSpanTree([
      row({ spanId: 'b', startTs: ts }),
      row({ spanId: 'a', startTs: ts }),
      row({ spanId: 'c', startTs: ts }),
    ]);
    expect(tree.map(n => n.row.spanId)).toEqual(['a', 'b', 'c']);
  });
});

describe('findEnclosingSpanId (HS-8476 / §68.5.1)', () => {
  it('returns null when no span contains the timestamp', () => {
    const spans = [
      row({ spanId: 's1', startTs: '2026-05-21T10:00:00.000Z', endTs: '2026-05-21T10:00:01.000Z' }),
    ];
    expect(findEnclosingSpanId('2026-05-21T10:00:05.000Z', spans)).toBeNull();
  });

  it('returns the deepest (latest-start) span when multiple contain the ts', () => {
    const spans = [
      // outer span covers [0, 10s]
      row({ spanId: 'outer', startTs: '2026-05-21T10:00:00.000Z', endTs: '2026-05-21T10:00:10.000Z' }),
      // inner span covers [2s, 8s] — deeper, since startTs is later
      row({ spanId: 'inner', startTs: '2026-05-21T10:00:02.000Z', endTs: '2026-05-21T10:00:08.000Z' }),
    ];
    expect(findEnclosingSpanId('2026-05-21T10:00:05.000Z', spans)).toBe('inner');
  });

  it('returns the span when the ts is exactly at the start boundary', () => {
    const spans = [
      row({ spanId: 's1', startTs: '2026-05-21T10:00:00.000Z', endTs: '2026-05-21T10:00:01.000Z' }),
    ];
    expect(findEnclosingSpanId('2026-05-21T10:00:00.000Z', spans)).toBe('s1');
  });

  it('returns the span when the ts is exactly at the end boundary', () => {
    const spans = [
      row({ spanId: 's1', startTs: '2026-05-21T10:00:00.000Z', endTs: '2026-05-21T10:00:01.000Z' }),
    ];
    expect(findEnclosingSpanId('2026-05-21T10:00:01.000Z', spans)).toBe('s1');
  });

  it('returns null for empty span list', () => {
    expect(findEnclosingSpanId('2026-05-21T10:00:00.000Z', [])).toBeNull();
  });
});
