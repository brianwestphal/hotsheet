// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetForTests,
  applyHideButtonBadge,
  countHiddenAcrossAllProjects,
  countHiddenForProject,
  filterVisible,
  getHiddenTerminals,
  hydratePersistedHiddenForProject,
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

  // HS-7823 — badge count helpers + DOM helper for the eye-icon button.
  it('countHiddenAcrossAllProjects sums across every project', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s2', 'x', true);
    expect(countHiddenAcrossAllProjects()).toBe(3);
  });

  it('countHiddenAcrossAllProjects returns 0 when nothing is hidden', () => {
    expect(countHiddenAcrossAllProjects()).toBe(0);
  });

  it('countHiddenForProject scopes the count to the given secret', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s2', 'x', true);
    expect(countHiddenForProject('s1')).toBe(2);
    expect(countHiddenForProject('s2')).toBe(1);
    expect(countHiddenForProject('s3')).toBe(0);
  });

  it('applyHideButtonBadge adds a .hide-btn-badge child with the count when > 0', () => {
    const btn = document.createElement('button');
    applyHideButtonBadge(btn, 3);
    const badge = btn.querySelector('.hide-btn-badge');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('3');
  });

  it('applyHideButtonBadge clamps very large counts to 99+', () => {
    const btn = document.createElement('button');
    applyHideButtonBadge(btn, 137);
    expect(btn.querySelector('.hide-btn-badge')!.textContent).toBe('99+');
  });

  it('applyHideButtonBadge removes the badge when count drops to 0', () => {
    const btn = document.createElement('button');
    applyHideButtonBadge(btn, 2);
    expect(btn.querySelector('.hide-btn-badge')).not.toBeNull();
    applyHideButtonBadge(btn, 0);
    expect(btn.querySelector('.hide-btn-badge')).toBeNull();
  });

  it('applyHideButtonBadge updates an existing badge in place rather than recreating it', () => {
    const btn = document.createElement('button');
    applyHideButtonBadge(btn, 1);
    const original = btn.querySelector('.hide-btn-badge');
    applyHideButtonBadge(btn, 2);
    const updated = btn.querySelector('.hide-btn-badge');
    expect(updated).toBe(original);
    expect(updated!.textContent).toBe('2');
  });

  it('applyHideButtonBadge tolerates a null button (no-op)', () => {
    expect(() => applyHideButtonBadge(null, 5)).not.toThrow();
  });

  // HS-7825 — hydratePersistedHiddenForProject seeds the in-memory map from
  // persisted ids. Drives the auto-hide-on-relaunch behaviour spec.
  it('hydratePersistedHiddenForProject seeds the hidden set and notifies subscribers', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    hydratePersistedHiddenForProject('s1', ['default', 'claude']);
    expect(getHiddenTerminals('s1').size).toBe(2);
    expect(isTerminalHidden('s1', 'default')).toBe(true);
    expect(isTerminalHidden('s1', 'claude')).toBe(true);
    expect(fires).toBe(1);
    unsub();
  });

  it('hydratePersistedHiddenForProject silently drops dynamic ids (defense in depth)', () => {
    hydratePersistedHiddenForProject('s1', ['default', 'dyn-abc', 'claude']);
    expect(isTerminalHidden('s1', 'default')).toBe(true);
    expect(isTerminalHidden('s1', 'claude')).toBe(true);
    expect(isTerminalHidden('s1', 'dyn-abc')).toBe(false);
  });

  it('hydratePersistedHiddenForProject with an empty list clears existing state for that project', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    expect(getHiddenTerminals('s1').size).toBe(2);
    hydratePersistedHiddenForProject('s1', []);
    expect(getHiddenTerminals('s1').size).toBe(0);
  });

  it('hydratePersistedHiddenForProject is a no-op when the new set matches the current set (no fire)', () => {
    hydratePersistedHiddenForProject('s1', ['a', 'b']);
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    hydratePersistedHiddenForProject('s1', ['b', 'a']); // same set, different order
    expect(fires).toBe(0);
    unsub();
  });
});
