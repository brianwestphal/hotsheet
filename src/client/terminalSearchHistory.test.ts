import { describe, expect, it } from 'vitest';

import { navigateHistory, pushHistory } from './terminalSearchHistory.js';

describe('pushHistory (HS-7427)', () => {
  it('appends to an empty history', () => {
    expect(pushHistory([], 'foo')).toEqual(['foo']);
  });

  it('keeps MRU-at-tail order across multiple pushes', () => {
    let h = pushHistory([], 'a');
    h = pushHistory(h, 'b');
    h = pushHistory(h, 'c');
    expect(h).toEqual(['a', 'b', 'c']);
  });

  it('caps at the default N=10 by dropping the oldest entry', () => {
    let h: string[] = [];
    for (let i = 0; i < 12; i += 1) h = pushHistory(h, `q${i}`);
    expect(h).toHaveLength(10);
    expect(h[0]).toBe('q2');
    expect(h[h.length - 1]).toBe('q11');
  });

  it('honors a custom cap', () => {
    let h: string[] = [];
    for (let i = 0; i < 5; i += 1) h = pushHistory(h, `q${i}`, 3);
    expect(h).toEqual(['q2', 'q3', 'q4']);
  });

  it('cap of 0 returns an empty history', () => {
    expect(pushHistory(['a', 'b'], 'c', 0)).toEqual([]);
  });

  it('de-dupes the existing entry and re-adds it at the tail (MRU bump)', () => {
    let h = pushHistory([], 'a');
    h = pushHistory(h, 'b');
    h = pushHistory(h, 'c');
    h = pushHistory(h, 'a');
    expect(h).toEqual(['b', 'c', 'a']);
  });

  it('the de-dupe happens before the cap so the window always contains N distinct queries', () => {
    // Fill cap=3, then push the oldest entry again — it should bubble to the
    // tail and the middle entry should remain.
    let h: string[] = [];
    h = pushHistory(h, 'a', 3);
    h = pushHistory(h, 'b', 3);
    h = pushHistory(h, 'c', 3);
    h = pushHistory(h, 'a', 3);
    expect(h).toEqual(['b', 'c', 'a']);
  });

  it('empty / whitespace-only queries are not recorded', () => {
    expect(pushHistory(['x'], '')).toEqual(['x']);
    expect(pushHistory(['x'], '   ')).toEqual(['x']);
    expect(pushHistory(['x'], '\t\n')).toEqual(['x']);
  });

  it('does not mutate the input array', () => {
    const original = ['a', 'b'];
    const next = pushHistory(original, 'c');
    expect(original).toEqual(['a', 'b']);
    expect(next).toEqual(['a', 'b', 'c']);
    expect(next).not.toBe(original);
  });
});

describe('navigateHistory (HS-7427)', () => {
  describe('with empty history', () => {
    it('returns the draft and clamps cursor to 0 for both directions', () => {
      expect(navigateHistory([], 5, 'up', 'draft')).toEqual({ value: 'draft', cursor: 0 });
      expect(navigateHistory([], -2, 'down', 'd')).toEqual({ value: 'd', cursor: 0 });
    });
  });

  describe('with non-empty history', () => {
    const h = ['old', 'mid', 'new']; // MRU-at-tail: newest is "new"

    it('first ArrowUp from draft mode lands on the most recent entry', () => {
      expect(navigateHistory(h, h.length, 'up', 'draft')).toEqual({ value: 'new', cursor: 2 });
    });

    it('subsequent ArrowUp walks back through history', () => {
      expect(navigateHistory(h, 2, 'up', 'draft')).toEqual({ value: 'mid', cursor: 1 });
      expect(navigateHistory(h, 1, 'up', 'draft')).toEqual({ value: 'old', cursor: 0 });
    });

    it('ArrowUp at the oldest entry stays put', () => {
      expect(navigateHistory(h, 0, 'up', 'draft')).toEqual({ value: 'old', cursor: 0 });
    });

    it('ArrowDown walks forward and restores the draft past the newest entry', () => {
      expect(navigateHistory(h, 0, 'down', 'draft')).toEqual({ value: 'mid', cursor: 1 });
      expect(navigateHistory(h, 1, 'down', 'draft')).toEqual({ value: 'new', cursor: 2 });
      expect(navigateHistory(h, 2, 'down', 'draft')).toEqual({ value: 'draft', cursor: 3 });
    });

    it('ArrowDown in draft mode stays in draft mode', () => {
      expect(navigateHistory(h, h.length, 'down', 'draft')).toEqual({ value: 'draft', cursor: 3 });
    });

    it('out-of-range cursor is clamped to [0, history.length] before navigating', () => {
      // Cursor too high -> clamp to history.length (draft mode), then ArrowUp
      // takes us to the most recent entry.
      expect(navigateHistory(h, 999, 'up', 'draft')).toEqual({ value: 'new', cursor: 2 });
      // Cursor negative -> clamp to 0, then ArrowDown goes to next.
      expect(navigateHistory(h, -10, 'down', 'draft')).toEqual({ value: 'mid', cursor: 1 });
    });

    it('does not mutate the history input array', () => {
      const original = ['x', 'y'];
      navigateHistory(original, 1, 'up', 'd');
      expect(original).toEqual(['x', 'y']);
    });
  });

  describe('draft preservation (HS-7427 §34.9 acceptance case)', () => {
    it('round-trip ArrowUp -> ArrowDown restores the captured draft', () => {
      const h = ['foo'];
      const draft = 'fo';
      const up = navigateHistory(h, h.length, 'up', draft);
      expect(up).toEqual({ value: 'foo', cursor: 0 });
      const down = navigateHistory(h, up.cursor, 'down', draft);
      expect(down).toEqual({ value: draft, cursor: 1 });
    });
  });
});
