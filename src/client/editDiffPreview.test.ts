/**
 * HS-7951 — pure-helper tests for the Edit/Write diff preview. The DOM-
 * mounting `renderEditDiffPreview` isn't directly tested at the helper
 * level; its output is the union of `splitLines` + `computeDiffOps` +
 * `buildHunks` results plus presentational chrome. The pure helpers are
 * what a future regression would catch — wire-up changes show up at e2e.
 */
import { describe, expect, it } from 'vitest';

import { buildHunks, computeDiffOps, splitLines } from './editDiffPreview.js';

describe('splitLines (HS-7951)', () => {
  it('splits a simple multi-line string', () => {
    expect(splitLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('returns a single empty line for the empty string (so empty diff renders one row)', () => {
    expect(splitLines('')).toEqual(['']);
  });

  it('preserves a trailing newline as a final empty line', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b', '']);
  });

  it('handles a single-line input with no newlines', () => {
    expect(splitLines('hello')).toEqual(['hello']);
  });
});

describe('computeDiffOps (HS-7951)', () => {
  it('returns all-context for identical input', () => {
    const ops = computeDiffOps('a\nb\nc', 'a\nb\nc');
    expect(ops).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('marks the changed line as del + add', () => {
    const ops = computeDiffOps('a\nb\nc', 'a\nB\nc');
    expect(ops).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'B' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('handles pure-add (empty old, like Write)', () => {
    const ops = computeDiffOps('', 'new line 1\nnew line 2');
    // splitLines('') → [''] so we get one ctx-or-mismatch on '' first.
    // Either way the new lines should appear as adds in source order.
    const adds = ops.filter(o => o.kind === 'add').map(o => o.text);
    expect(adds).toEqual(['new line 1', 'new line 2']);
  });

  it('handles pure-delete (empty new)', () => {
    const ops = computeDiffOps('old line 1\nold line 2', '');
    const dels = ops.filter(o => o.kind === 'del').map(o => o.text);
    expect(dels).toEqual(['old line 1', 'old line 2']);
  });

  it('produces stable LCS for adds in the middle', () => {
    const ops = computeDiffOps('a\nc', 'a\nb\nc');
    expect(ops).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('produces stable LCS for deletes in the middle', () => {
    const ops = computeDiffOps('a\nb\nc', 'a\nc');
    expect(ops).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ]);
  });

  it('emits empty-string ops correctly (preserves trailing newline diffs)', () => {
    const ops = computeDiffOps('a', 'a\n');
    // splitLines('a') = ['a']; splitLines('a\n') = ['a', ''].
    // Expect the trailing '' to show as an add.
    expect(ops).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'add', text: '' },
    ]);
  });
});

describe('buildHunks (HS-7951)', () => {
  it('returns empty when there are no changes (all-ctx)', () => {
    expect(buildHunks(computeDiffOps('a\nb\nc', 'a\nb\nc'))).toEqual([]);
  });

  it('returns empty for an empty op list', () => {
    expect(buildHunks([])).toEqual([]);
  });

  it('wraps a single change with up to 2 lines of context (default contextLines)', () => {
    // 5 lines, changing line 3.
    const ops = computeDiffOps('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
    const hunks = buildHunks(ops);
    expect(hunks.length).toBe(1);
    // ctx a, ctx b, del c, add C, ctx d, ctx e — 6 ops.
    expect(hunks[0].lines.map(l => l.kind)).toEqual(['ctx', 'ctx', 'del', 'add', 'ctx', 'ctx']);
  });

  it('trims context outside the contextLines window', () => {
    // 9 lines, changing only line 5. With contextLines=2, hunk is lines 3..7.
    const ops = computeDiffOps('a\nb\nc\nd\ne\nf\ng\nh\ni', 'a\nb\nc\nd\nE\nf\ng\nh\ni');
    const hunks = buildHunks(ops, 2);
    expect(hunks.length).toBe(1);
    expect(hunks[0].lines.length).toBe(6); // c, d, del-e, add-E, f, g
    expect(hunks[0].lines[0].text).toBe('c');
    expect(hunks[0].lines[hunks[0].lines.length - 1].text).toBe('g');
  });

  it('merges two close changes into one hunk when their context ranges overlap', () => {
    // 8 lines, changes at line 3 and line 5. contextLines=2 makes ranges
    // 1..5 and 3..7 → merged 1..7 → one hunk.
    const ops = computeDiffOps('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nC\nd\nE\nf\ng\nh');
    const hunks = buildHunks(ops, 2);
    expect(hunks.length).toBe(1);
  });

  it('keeps two distant changes as two hunks', () => {
    // 11 lines, changes at line 1 and line 10. contextLines=2 makes ranges
    // 0..3 and 7..10 → two separate hunks.
    const ops = computeDiffOps('A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK', 'A1\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK1');
    const hunks = buildHunks(ops, 2);
    expect(hunks.length).toBe(2);
  });

  it('respects a custom contextLines value', () => {
    const ops = computeDiffOps('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
    const hunks0 = buildHunks(ops, 0);
    expect(hunks0.length).toBe(1);
    expect(hunks0[0].lines.map(l => l.kind)).toEqual(['del', 'add']); // no context
    const hunks1 = buildHunks(ops, 1);
    expect(hunks1.length).toBe(1);
    expect(hunks1[0].lines.map(l => l.kind)).toEqual(['ctx', 'del', 'add', 'ctx']);
  });
});
