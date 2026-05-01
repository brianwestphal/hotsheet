// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetForTests,
  addGroupingForProjectWithId,
  applyHideButtonBadge,
  countHiddenAcrossAllProjects,
  countHiddenForProject,
  filterVisible,
  generateGroupingIdAcrossProjects,
  getActiveGroupingId,
  getGroupings,
  getHiddenTerminals,
  hideAllInGrouping,
  hideNewTerminalInNonDefaultGroupings,
  hydratePersistedHiddenForProject,
  isTerminalHidden,
  isTerminalHiddenInGrouping,
  pruneHiddenForProject,
  setActiveGroupingForProject,
  setTerminalHidden,
  setTerminalHiddenInGrouping,
  subscribeToHiddenChanges,
  unhideAllEverywhere,
  unhideAllInGrouping,
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

describe('cross-project grouping fan-out (HS-7826 follow-up)', () => {
  it('generateGroupingIdAcrossProjects returns an id not used in any of the supplied projects', () => {
    addGroupingForProjectWithId('s1', 'g-shared', 'Servers');
    addGroupingForProjectWithId('s2', 'g-shared', 'Servers');
    const id = generateGroupingIdAcrossProjects(['s1', 's2', 's3']);
    expect(id).not.toBe('g-shared');
    expect(id.startsWith('g-')).toBe(true);
  });

  it('addGroupingForProjectWithId adds the grouping with the supplied id (idempotent on re-add)', () => {
    addGroupingForProjectWithId('s1', 'g-shared', 'Servers');
    addGroupingForProjectWithId('s1', 'g-shared', 'Apps'); // second call same id is a no-op
    const groupings = getGroupings('s1');
    expect(groupings).toHaveLength(2);
    expect(groupings[1]).toEqual({ id: 'g-shared', name: 'Servers', hiddenIds: [] });
  });

  it('a shared id lets activeId stay aligned across projects when the dialog fans out', () => {
    // Mirror what the dialog now does: add the same grouping under the same
    // id in every project, then activate it in every project.
    addGroupingForProjectWithId('s1', 'g-shared', 'Servers');
    addGroupingForProjectWithId('s2', 'g-shared', 'Servers');
    setActiveGroupingForProject('s1', 'g-shared');
    setActiveGroupingForProject('s2', 'g-shared');
    expect(getActiveGroupingId('s1')).toBe('g-shared');
    expect(getActiveGroupingId('s2')).toBe('g-shared');
  });

  it('toggling visibility against the terminal\'s own project (not the dialog scope) shows up in that project\'s active filter — the HS-7826-follow-up regression case', () => {
    addGroupingForProjectWithId('s1', 'g-shared', 'Servers');
    addGroupingForProjectWithId('s2', 'g-shared', 'Servers');
    setActiveGroupingForProject('s1', 'g-shared');
    setActiveGroupingForProject('s2', 'g-shared');

    // Pre-fix the dialog wrote everything against dialog-scope (s1) so a
    // toggle on a terminal whose project was s2 disappeared as far as
    // `filterVisible(s2, …)` was concerned. Post-fix the dialog routes the
    // toggle to the terminal's own project secret.
    setTerminalHiddenInGrouping('s2', 'g-shared', 'claude-id', true);

    expect(isTerminalHiddenInGrouping('s2', 'g-shared', 'claude-id')).toBe(true);
    expect(filterVisible('s2', [{ id: 'claude-id' }, { id: 'server-id' }]))
      .toEqual([{ id: 'server-id' }]);
    // s1's active grouping stays untouched.
    expect(isTerminalHiddenInGrouping('s1', 'g-shared', 'claude-id')).toBe(false);
  });
});

describe('hideNewTerminalInNonDefaultGroupings (HS-7949 follow-up)', () => {
  it('hides the new id in every non-Default grouping but leaves Default alone', () => {
    addGroupingForProjectWithId('s1', 'g-claude', 'Claude');
    addGroupingForProjectWithId('s1', 'g-server', 'Server');

    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');

    expect(isTerminalHiddenInGrouping('s1', 'default', 'dyn-new')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', 'g-claude', 'dyn-new')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'dyn-new')).toBe(true);
  });

  it('is idempotent — calling twice does not duplicate the id', () => {
    addGroupingForProjectWithId('s1', 'g-claude', 'Claude');
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    const claude = getGroupings('s1').find(g => g.id === 'g-claude')!;
    expect(claude.hiddenIds.filter(id => id === 'dyn-new')).toHaveLength(1);
  });

  it('is a no-op when the project has no non-Default groupings', () => {
    let notifyCount = 0;
    const unsubscribe = subscribeToHiddenChanges(() => { notifyCount++; });
    // Force-create the project state so the helper has something to read.
    setTerminalHidden('s1', 'tmp', false);
    notifyCount = 0; // ignore the previous notify
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    expect(notifyCount).toBe(0);
    unsubscribe();
  });

  it('is a no-op when the project state has not been initialised yet', () => {
    let notifyCount = 0;
    const unsubscribe = subscribeToHiddenChanges(() => { notifyCount++; });
    hideNewTerminalInNonDefaultGroupings('never-seen-secret', 'dyn-new');
    expect(notifyCount).toBe(0);
    unsubscribe();
  });

  it('applies to configured ids too (not just dyn-* — the helper is shape-agnostic)', () => {
    addGroupingForProjectWithId('s1', 'g-claude', 'Claude');
    hideNewTerminalInNonDefaultGroupings('s1', 'configured-id');
    expect(isTerminalHiddenInGrouping('s1', 'g-claude', 'configured-id')).toBe(true);
  });
});

describe('pruneHiddenForProject (HS-8016)', () => {
  it('drops ids that are not in the live list and decreases the count', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s1', 'c', true);
    expect(countHiddenForProject('s1')).toBe(3);

    // User closed `b` (drawer X-button); the next /terminal/list call has
    // a + c but not b.
    pruneHiddenForProject('s1', ['a', 'c']);
    expect(countHiddenForProject('s1')).toBe(2);
    expect(isTerminalHidden('s1', 'a')).toBe(true);
    expect(isTerminalHidden('s1', 'b')).toBe(false);
    expect(isTerminalHidden('s1', 'c')).toBe(true);
  });

  it('fires the change subscription exactly once per pruning pass', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    pruneHiddenForProject('s1', []);
    expect(fires).toBe(1);
    unsub();
  });

  it('does not fire when nothing changed', () => {
    setTerminalHidden('s1', 'a', true);
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    pruneHiddenForProject('s1', ['a', 'b', 'c']);
    expect(fires).toBe(0);
    unsub();
  });

  it('is a no-op when the project state has not been seen yet', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    pruneHiddenForProject('never-seen', ['a']);
    expect(fires).toBe(0);
    expect(countHiddenForProject('never-seen')).toBe(0);
    unsub();
  });

  it('prunes from non-active groupings as well, not just the active one', () => {
    addGroupingForProjectWithId('s1', 'g-server', 'Server');
    setTerminalHiddenInGrouping('s1', 'default', 'a', true);
    setTerminalHiddenInGrouping('s1', 'g-server', 'a', true);
    setTerminalHiddenInGrouping('s1', 'g-server', 'b', true);

    // `a` no longer exists in the live list.
    pruneHiddenForProject('s1', ['b']);

    expect(isTerminalHiddenInGrouping('s1', 'default', 'a')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'a')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'b')).toBe(true);
  });

  it('counts go to zero across-projects when every hidden id was closed', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s2', 'b', true);
    expect(countHiddenAcrossAllProjects()).toBe(2);
    pruneHiddenForProject('s1', []);
    pruneHiddenForProject('s2', []);
    expect(countHiddenAcrossAllProjects()).toBe(0);
  });
});

/**
 * HS-8063 — `hideAllInGrouping` is the symmetric counterpart to
 * `unhideAllInGrouping`, used by the dialog's new "Hide All" button.
 * Hides every supplied terminal id in a specific grouping in one call.
 * Idempotent: already-hidden ids stay hidden, duplicates collapse.
 */
describe('hideAllInGrouping (HS-8063)', () => {
  it('hides every supplied id in the target grouping', () => {
    addGroupingForProjectWithId('s1', 'g-server', 'Server');
    setActiveGroupingForProject('s1', 'g-server');

    hideAllInGrouping('s1', 'g-server', ['a', 'b', 'c']);

    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'a')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'b')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'c')).toBe(true);
  });

  it('is idempotent — calling twice does not duplicate ids', () => {
    addGroupingForProjectWithId('s1', 'g-server', 'Server');
    hideAllInGrouping('s1', 'g-server', ['a', 'b']);
    hideAllInGrouping('s1', 'g-server', ['a', 'b']);
    expect(getHiddenTerminals('s1').size).toBe(0); // active is still default
    setActiveGroupingForProject('s1', 'g-server');
    expect(Array.from(getHiddenTerminals('s1')).sort()).toEqual(['a', 'b']);
  });

  it('preserves prior hidden ids and merges new ones', () => {
    addGroupingForProjectWithId('s1', 'g-server', 'Server');
    setTerminalHiddenInGrouping('s1', 'g-server', 'a', true);
    hideAllInGrouping('s1', 'g-server', ['b', 'c']);
    setActiveGroupingForProject('s1', 'g-server');
    expect(Array.from(getHiddenTerminals('s1')).sort()).toEqual(['a', 'b', 'c']);
  });

  it('only mutates the target grouping, not the active or default', () => {
    addGroupingForProjectWithId('s1', 'g-server', 'Server');
    // Active is default. Mutate only `g-server`.
    hideAllInGrouping('s1', 'g-server', ['a', 'b']);
    expect(isTerminalHidden('s1', 'a')).toBe(false); // active=default, untouched
    expect(isTerminalHiddenInGrouping('s1', 'default', 'a')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', 'g-server', 'a')).toBe(true);
  });

  it('empty terminalIds is a no-op (no notify)', () => {
    let calls = 0;
    const unsub = subscribeToHiddenChanges(() => { calls += 1; });
    hideAllInGrouping('s1', 'default', []);
    expect(calls).toBe(0);
    unsub();
  });

  it('symmetric with unhideAllInGrouping — round trip yields empty grouping', () => {
    addGroupingForProjectWithId('s1', 'g-server', 'Server');
    hideAllInGrouping('s1', 'g-server', ['a', 'b', 'c']);
    unhideAllInGrouping('s1', 'g-server');
    setActiveGroupingForProject('s1', 'g-server');
    expect(getHiddenTerminals('s1').size).toBe(0);
  });
});
