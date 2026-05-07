// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetForTests,
  addGrouping,
  applyHideButtonBadge,
  countHiddenAcrossAllProjects,
  countHiddenForProject,
  filterVisible,
  getActiveGroupingId,
  getGroupings,
  getHiddenTerminals,
  hideAllInGrouping,
  hideNewTerminalInNonDefaultGroupings,
  hydratePersistedGlobalState,
  isTerminalHidden,
  isTerminalHiddenInGrouping,
  pruneHiddenForProject,
  setActiveGrouping,
  setTerminalHidden,
  setTerminalHiddenInGrouping,
  subscribeToHiddenChanges,
  unhideAllEverywhere,
  unhideAllInGrouping,
  unhideAllInProject,
} from './dashboardHiddenTerminals.js';
import { initialGlobalState } from './visibilityGroupings.js';

afterEach(() => {
  _resetForTests();
});

describe('dashboardHiddenTerminals (HS-7661 / HS-8290 global state)', () => {
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

  it('getHiddenTerminals returns a fresh copy', () => {
    setTerminalHidden('s1', 'a', true);
    const set = getHiddenTerminals('s1');
    set.add('mutated');
    expect(isTerminalHidden('s1', 'mutated')).toBe(false);
  });

  it('filterVisible returns the input unchanged when no entries are hidden', () => {
    const entries = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    expect(filterVisible('s1', entries)).toBe(entries);
  });

  it('filterVisible drops only the hidden ids', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'c', true);
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(filterVisible('s1', entries).map(e => e.id)).toEqual(['b', 'd']);
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

  it('countHiddenAcrossAllProjects sums across every project', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s2', 'x', true);
    expect(countHiddenAcrossAllProjects()).toBe(3);
  });

  it('countHiddenForProject scopes the count to the given secret', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s2', 'x', true);
    expect(countHiddenForProject('s1')).toBe(2);
    expect(countHiddenForProject('s2')).toBe(1);
    expect(countHiddenForProject('s3')).toBe(0);
  });

  it('applyHideButtonBadge adds and removes a badge based on count', () => {
    const btn = document.createElement('button');
    applyHideButtonBadge(btn, 3);
    expect(btn.querySelector('.hide-btn-badge')!.textContent).toBe('3');
    applyHideButtonBadge(btn, 137);
    expect(btn.querySelector('.hide-btn-badge')!.textContent).toBe('99+');
    applyHideButtonBadge(btn, 0);
    expect(btn.querySelector('.hide-btn-badge')).toBeNull();
  });
});

describe('global grouping CRUD (HS-8290)', () => {
  it('addGrouping creates a global grouping that every project can read', () => {
    const g = addGrouping('Servers');
    expect(getGroupings()).toHaveLength(2);
    expect(g.hiddenByProject).toEqual({});
  });

  it('setActiveGrouping flips the global active id', () => {
    const g = addGrouping('Servers');
    setActiveGrouping(g.id);
    expect(getActiveGroupingId()).toBe(g.id);
  });

  it('hiding in one grouping does not bleed into another', () => {
    const g = addGrouping('Servers');
    setTerminalHiddenInGrouping('s1', g.id, 'claude', true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'claude')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', 'default', 'claude')).toBe(false);
  });

  it('toggling visibility lands in the correct project, not just the dialog scope (HS-7826 follow-up regression coverage)', () => {
    const g = addGrouping('Servers');
    setActiveGrouping(g.id);
    setTerminalHiddenInGrouping('s2', g.id, 'claude-id', true);
    expect(isTerminalHiddenInGrouping('s2', g.id, 'claude-id')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'claude-id')).toBe(false);
    expect(filterVisible('s2', [{ id: 'claude-id' }, { id: 'server-id' }]))
      .toEqual([{ id: 'server-id' }]);
  });
});

describe('hydratePersistedGlobalState (HS-8290)', () => {
  it('seeds the global state and notifies subscribers', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    hydratePersistedGlobalState({
      groupings: [
        { id: 'default', name: 'Default', hiddenByProject: { s1: ['claude'] } },
      ],
      activeId: 'default',
    });
    expect(isTerminalHidden('s1', 'claude')).toBe(true);
    expect(fires).toBe(1);
    unsub();
  });

  it('drops dynamic ids on hydrate (defense in depth)', () => {
    hydratePersistedGlobalState({
      groupings: [
        { id: 'default', name: 'Default', hiddenByProject: { s1: ['claude', 'dyn-abc'] } },
      ],
      activeId: 'default',
    });
    expect(isTerminalHidden('s1', 'claude')).toBe(true);
    expect(isTerminalHidden('s1', 'dyn-abc')).toBe(false);
  });

  it('is a no-op when the new state matches the current one (no fire)', () => {
    hydratePersistedGlobalState(initialGlobalState());
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    hydratePersistedGlobalState(initialGlobalState());
    expect(fires).toBe(0);
    unsub();
  });
});

describe('hideNewTerminalInNonDefaultGroupings (HS-7949 follow-up, HS-8290 global state)', () => {
  it('hides the new id in every non-Default grouping but leaves Default alone', () => {
    const claude = addGrouping('Claude');
    const server = addGrouping('Server');
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    expect(isTerminalHiddenInGrouping('s1', 'default', 'dyn-new')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', claude.id, 'dyn-new')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', server.id, 'dyn-new')).toBe(true);
  });

  it('is idempotent', () => {
    const claude = addGrouping('Claude');
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    const g = getGroupings().find(x => x.id === claude.id)!;
    expect(g.hiddenByProject['s1'].filter(id => id === 'dyn-new')).toHaveLength(1);
  });

  it('is a no-op when the project has no non-Default groupings', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    hideNewTerminalInNonDefaultGroupings('s1', 'dyn-new');
    expect(fires).toBe(0);
    unsub();
  });
});

describe('pruneHiddenForProject (HS-8016 / HS-8290)', () => {
  it('drops ids that are not in the live list and decreases the count', () => {
    setTerminalHidden('s1', 'a', true);
    setTerminalHidden('s1', 'b', true);
    setTerminalHidden('s1', 'c', true);
    expect(countHiddenForProject('s1')).toBe(3);
    pruneHiddenForProject('s1', ['a', 'c']);
    expect(countHiddenForProject('s1')).toBe(2);
    expect(isTerminalHidden('s1', 'b')).toBe(false);
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

  it('prunes from non-active groupings as well', () => {
    const g = addGrouping('Server');
    setTerminalHiddenInGrouping('s1', 'default', 'a', true);
    setTerminalHiddenInGrouping('s1', g.id, 'a', true);
    setTerminalHiddenInGrouping('s1', g.id, 'b', true);
    pruneHiddenForProject('s1', ['b']);
    expect(isTerminalHiddenInGrouping('s1', 'default', 'a')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'a')).toBe(false);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'b')).toBe(true);
  });
});

describe('hideAllInGrouping (HS-8063 / HS-8290)', () => {
  it('hides every supplied id in the target grouping', () => {
    const g = addGrouping('Server');
    setActiveGrouping(g.id);
    hideAllInGrouping('s1', g.id, ['a', 'b', 'c']);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'a')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'b')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'c')).toBe(true);
  });

  it('symmetric with unhideAllInGrouping — round trip yields empty grouping', () => {
    const g = addGrouping('Server');
    hideAllInGrouping('s1', g.id, ['a', 'b', 'c']);
    unhideAllInGrouping('s1', g.id);
    setActiveGrouping(g.id);
    expect(getHiddenTerminals('s1').size).toBe(0);
  });

  it('empty terminalIds is a no-op (no notify)', () => {
    let calls = 0;
    const unsub = subscribeToHiddenChanges(() => { calls += 1; });
    hideAllInGrouping('s1', 'default', []);
    expect(calls).toBe(0);
    unsub();
  });
});
