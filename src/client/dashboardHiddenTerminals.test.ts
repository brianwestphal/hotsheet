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
import { DASHBOARD_SCOPE, initialGlobalState, projectScope } from './visibilityGroupings.js';

afterEach(() => {
  _resetForTests();
});

describe('dashboardHiddenTerminals (HS-7661 / HS-8290 global state)', () => {
  it('isTerminalHidden defaults to false for an unknown pair', () => {
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'default')).toBe(false);
  });

  it('setTerminalHidden(true) flips the state and fires subscribers', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'a')).toBe(true);
    expect(fires).toBe(1);
    unsub();
  });

  it('setTerminalHidden(true) twice for the same pair is a no-op (no extra fires)', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    expect(fires).toBe(1);
    unsub();
  });

  it('setTerminalHidden(false) restores visibility and fires subscribers', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', false);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'a')).toBe(false);
    expect(fires).toBe(2);
    unsub();
  });

  it('per-project sets are independent — hiding "a" in s1 does not hide "a" in s2', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'a')).toBe(true);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's2', 'a')).toBe(false);
  });

  it('getHiddenTerminals returns a fresh copy', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    const set = getHiddenTerminals(DASHBOARD_SCOPE, 's1');
    set.add('mutated');
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'mutated')).toBe(false);
  });

  it('filterVisible returns the input unchanged when no entries are hidden', () => {
    const entries = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
    expect(filterVisible(DASHBOARD_SCOPE, 's1', entries)).toBe(entries);
  });

  it('filterVisible drops only the hidden ids', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'c', true);
    const entries = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(filterVisible(DASHBOARD_SCOPE, 's1', entries).map(e => e.id)).toEqual(['b', 'd']);
  });

  it('unhideAllInProject removes every hidden id for that project but leaves others intact', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'b', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's2', 'a', true);
    unhideAllInProject(DASHBOARD_SCOPE, 's1');
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'a')).toBe(false);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'b')).toBe(false);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's2', 'a')).toBe(true);
  });

  it('unhideAllInProject for an empty/non-existent project is a no-op (no fire)', () => {
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    unhideAllInProject(DASHBOARD_SCOPE, 's1');
    expect(fires).toBe(0);
    unsub();
  });

  it('unhideAllEverywhere clears all projects', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's2', 'b', true);
    unhideAllEverywhere(DASHBOARD_SCOPE);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'a')).toBe(false);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's2', 'b')).toBe(false);
  });

  it('countHiddenAcrossAllProjects sums across every project', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'b', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's2', 'x', true);
    expect(countHiddenAcrossAllProjects(DASHBOARD_SCOPE)).toBe(3);
  });

  it('countHiddenForProject scopes the count to the given secret', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'b', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's2', 'x', true);
    expect(countHiddenForProject(DASHBOARD_SCOPE, 's1')).toBe(2);
    expect(countHiddenForProject(DASHBOARD_SCOPE, 's2')).toBe(1);
    expect(countHiddenForProject(DASHBOARD_SCOPE, 's3')).toBe(0);
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

  it('setActiveGrouping flips the dashboard scope independently of project scopes (HS-8406)', () => {
    const g = addGrouping('Servers');
    setActiveGrouping(DASHBOARD_SCOPE, g.id);
    expect(getActiveGroupingId(DASHBOARD_SCOPE)).toBe(g.id);
    // Project scopes still default until they get their own override.
    expect(getActiveGroupingId(projectScope('s1'))).not.toBe(g.id);
  });

  it('hiding in one grouping does not bleed into another', () => {
    const g = addGrouping('Servers');
    setTerminalHiddenInGrouping('s1', g.id, 'claude', true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'claude')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', 'default', 'claude')).toBe(false);
  });

  it('toggling visibility lands in the correct project, not just the dialog scope (HS-7826 follow-up regression coverage)', () => {
    const g = addGrouping('Servers');
    setActiveGrouping(DASHBOARD_SCOPE, g.id);
    setTerminalHiddenInGrouping('s2', g.id, 'claude-id', true);
    expect(isTerminalHiddenInGrouping('s2', g.id, 'claude-id')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'claude-id')).toBe(false);
    expect(filterVisible(DASHBOARD_SCOPE, 's2', [{ id: 'claude-id' }, { id: 'server-id' }]))
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
      activeIdByScope: {},
    });
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'claude')).toBe(true);
    expect(fires).toBe(1);
    unsub();
  });

  it('drops dynamic ids on hydrate (defense in depth)', () => {
    hydratePersistedGlobalState({
      groupings: [
        { id: 'default', name: 'Default', hiddenByProject: { s1: ['claude', 'dyn-abc'] } },
      ],
      activeIdByScope: {},
    });
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'claude')).toBe(true);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'dyn-abc')).toBe(false);
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
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'b', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'c', true);
    expect(countHiddenForProject(DASHBOARD_SCOPE, 's1')).toBe(3);
    pruneHiddenForProject('s1', ['a', 'c']);
    expect(countHiddenForProject(DASHBOARD_SCOPE, 's1')).toBe(2);
    expect(isTerminalHidden(DASHBOARD_SCOPE, 's1', 'b')).toBe(false);
  });

  it('fires the change subscription exactly once per pruning pass', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'b', true);
    let fires = 0;
    const unsub = subscribeToHiddenChanges(() => { fires++; });
    pruneHiddenForProject('s1', []);
    expect(fires).toBe(1);
    unsub();
  });

  it('does not fire when nothing changed', () => {
    setTerminalHidden(DASHBOARD_SCOPE, 's1', 'a', true);
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
    setActiveGrouping(DASHBOARD_SCOPE, g.id);
    hideAllInGrouping('s1', g.id, ['a', 'b', 'c']);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'a')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'b')).toBe(true);
    expect(isTerminalHiddenInGrouping('s1', g.id, 'c')).toBe(true);
  });

  it('symmetric with unhideAllInGrouping — round trip yields empty grouping', () => {
    const g = addGrouping('Server');
    hideAllInGrouping('s1', g.id, ['a', 'b', 'c']);
    unhideAllInGrouping('s1', g.id);
    setActiveGrouping(DASHBOARD_SCOPE, g.id);
    expect(getHiddenTerminals(DASHBOARD_SCOPE, 's1').size).toBe(0);
  });

  it('empty terminalIds is a no-op (no notify)', () => {
    let calls = 0;
    const unsub = subscribeToHiddenChanges(() => { calls += 1; });
    hideAllInGrouping('s1', 'default', []);
    expect(calls).toBe(0);
    unsub();
  });
});
