import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetForTests,
  filterVisible,
  getHiddenTerminals,
  isTerminalHidden,
  setTerminalHidden,
  subscribeToHiddenChanges,
  unhideAllEverywhere,
  unhideAllInProject,
} from './dashboardHiddenTerminals.js';

afterEach(() => {
  _resetForTests();
});

describe('dashboardHiddenTerminals (HS-7661)', () => {
  it('isTerminalHidden defaults to false for an unknown pair', () => {
    expect(isTerminalHidden('s1', 'default')).toBe(false);
  });

  it('setTerminalHidden(true) flips the state and fires subscribers', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden('s1', 'a', true);
    expect(isTerminalHidden('s1', 'a')).toBe(true);
    expect(fires).toBe(1);
    unsub();
  });

  it('setTerminalHidden(true) twice for the same pair is a no-op (no extra fires)', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'a', true);
    expect(fires).toBe(1);
    unsub();
  });

  it('setTerminalHidden(false) restores visibility and fires subscribers', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'a', false);
    expect(isTerminalHidden('s1', 'a')).toBe(false);
    expect(fires).toBe(2);
    unsub();
  });

  it('per-project sets are independent — hiding "a" in s1 does not hide "a" in s2', () => {
    setTerminalHidden('s1', 'a', true);
    expect(isTerminalHidden('s1', 'a')).toBe(true);
    expect(isTerminalHidden('s2', 'a')).toBe(false);
  });

  it('getHiddenTerminals returns a fresh copy — mutating it does not affect module state', () => {
    setTerminalHidden('s1', 'a', true);
    const set = getHiddenTerminals('s1');
    set.add('mutated');
    expect(isTerminalHidden('s1', 'mutated')).toBe(false);
    expect(set.has('mutated')).toBe(true);
  });

  it('filterVisible returns the input unchanged when no entries are hidden', () => {
    const entries = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    const result = filterVisible('s1', entries);
    expect(result).toEqual(entries);
    // Same reference is returned for the no-op fast path (caller can rely
    // on it for cheap equality checks if desired).
    expect(result).toBe(entries);
  });

  it('filterVisible drops only the hidden ids', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'c', true);
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const result = filterVisible('s1', entries);
    expect(result.map(e => e.id)).toEqual(['b', 'd']);
  });

  it('unhideAllInProject removes every hidden id for that project but leaves others intact', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s2', 'a', true);
    unhideAllInProject('s1');
    expect(isTerminalHidden('s1', 'a')).toBe(false);
    expect(isTerminalHidden('s1', 'b')).toBe(false);
    expect(isTerminalHidden('s2', 'a')).toBe(true);
  });

  it('unhideAllInProject for an empty/non-existent project is a no-op (no fire)', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    unhideAllInProject('s1');
    expect(fires).toBe(0);
    unsub();
  });

  it('unhideAllEverywhere clears all projects', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s2', 'b', true);
    unhideAllEverywhere();
    expect(isTerminalHidden('s1', 'a')).toBe(false);
    expect(isTerminalHidden('s2', 'b')).toBe(false);
  });

  it('removing the last hidden id from a project deletes the per-project entry so getHiddenTerminals returns an empty set', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'a', false);
    expect(getHiddenTerminals('s1').size).toBe(0);
  });

  it('subscribers do NOT fire on no-op setTerminalHidden(false) for a non-hidden pair', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden('s1', 'a', false);
    expect(fires).toBe(0);
    unsub();
  });

  it('unsubscribe stops further fires', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden('s1', 'a', true);
    unsub();
    setTerminalHidden('s1', 'b', true);
    expect(fires).toBe(1);
  });
});
