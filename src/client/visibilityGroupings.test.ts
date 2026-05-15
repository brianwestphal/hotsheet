import { describe, expect, it } from 'vitest';

import {
  addGrouping,
  DASHBOARD_SCOPE,
  DEFAULT_GROUPING_ID,
  DEFAULT_GROUPING_NAME,
  deleteGrouping,
  generateGroupingId,
  getActiveGroupingFor,
  getActiveGroupingIdFor,
  getHiddenIdsForProject,
  type GlobalVisibilityState,
  initialGlobalState,
  parsePersistedState,
  projectScope,
  pruneStaleIdsInGroupings,
  renameGrouping,
  reorderGroupings,
  setActiveGroupingIdFor,
  toggleHiddenInGrouping,
  updateGroupingById,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

const SECRET_A = 'aaaa1111';
const SECRET_B = 'bbbb2222';

describe('initialGlobalState (HS-8290 → HS-8406)', () => {
  it('returns a single Default grouping with no per-project hidden ids and no scope overrides', () => {
    const s = initialGlobalState();
    expect(s.groupings).toHaveLength(1);
    expect(s.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
    expect(s.groupings[0].name).toBe(DEFAULT_GROUPING_NAME);
    expect(s.groupings[0].hiddenByProject).toEqual({});
    expect(s.activeIdByScope).toEqual({});
    // Every scope falls back to Default when no override is recorded.
    expect(getActiveGroupingIdFor(s, DASHBOARD_SCOPE)).toBe(DEFAULT_GROUPING_ID);
    expect(getActiveGroupingIdFor(s, projectScope('aaaa'))).toBe(DEFAULT_GROUPING_ID);
  });
});

describe('generateGroupingId (HS-7826)', () => {
  it('returns an id with the g- prefix', () => {
    const id = generateGroupingId([]);
    expect(id.startsWith('g-')).toBe(true);
  });

  it('avoids collisions with existing ids', () => {
    const existing: VisibilityGrouping[] = [
      { id: 'g-existing-1', name: 'X', hiddenByProject: {} },
      { id: 'g-existing-2', name: 'Y', hiddenByProject: {} },
    ];
    const id = generateGroupingId(existing);
    expect(id).not.toBe('g-existing-1');
    expect(id).not.toBe('g-existing-2');
  });
});

describe('getActiveGroupingFor (HS-8406)', () => {
  it('returns the Default grouping for any scope without an override', () => {
    const s = initialGlobalState();
    expect(getActiveGroupingFor(s, DASHBOARD_SCOPE).id).toBe(DEFAULT_GROUPING_ID);
    expect(getActiveGroupingFor(s, projectScope(SECRET_A)).id).toBe(DEFAULT_GROUPING_ID);
  });

  it('returns the override-recorded grouping for a scope when it exists', () => {
    const state: GlobalVisibilityState = {
      groupings: [
        { id: 'a', name: 'A', hiddenByProject: {} },
        { id: 'b', name: 'B', hiddenByProject: {} },
      ],
      activeIdByScope: { [DASHBOARD_SCOPE]: 'a', [projectScope(SECRET_B)]: 'b' },
    };
    expect(getActiveGroupingFor(state, DASHBOARD_SCOPE).id).toBe('a');
    expect(getActiveGroupingFor(state, projectScope(SECRET_B)).id).toBe('b');
    // A scope without an override falls back to Default (synthesized
    // when missing — the first grouping wins as a safety net).
    expect(getActiveGroupingFor(state, projectScope(SECRET_A)).id).toBe('a');
  });

  it('falls back to first grouping when override id does not match any grouping', () => {
    const state: GlobalVisibilityState = {
      groupings: [
        { id: 'a', name: 'A', hiddenByProject: {} },
        { id: 'b', name: 'B', hiddenByProject: {} },
      ],
      activeIdByScope: { [DASHBOARD_SCOPE]: 'unknown' },
    };
    expect(getActiveGroupingFor(state, DASHBOARD_SCOPE).id).toBe('a');
  });

  it('returns a synthesized empty Default when groupings list is empty', () => {
    const g = getActiveGroupingFor({ groupings: [], activeIdByScope: {} }, DASHBOARD_SCOPE);
    expect(g.id).toBe(DEFAULT_GROUPING_ID);
    expect(g.hiddenByProject).toEqual({});
  });
});

describe('setActiveGroupingIdFor (HS-8406)', () => {
  it('records an override for the named scope only', () => {
    const s = addGrouping(initialGlobalState(), 'X');
    const next = setActiveGroupingIdFor(s.state, DASHBOARD_SCOPE, s.grouping.id);
    expect(next.activeIdByScope[DASHBOARD_SCOPE]).toBe(s.grouping.id);
    expect(next.activeIdByScope[projectScope(SECRET_A)]).toBeUndefined();
  });

  it('keeps independent overrides per scope', () => {
    const a = addGrouping(initialGlobalState(), 'A');
    const b = addGrouping(a.state, 'B');
    const withDashboard = setActiveGroupingIdFor(b.state, DASHBOARD_SCOPE, a.grouping.id);
    const withBoth = setActiveGroupingIdFor(withDashboard, projectScope(SECRET_A), b.grouping.id);
    expect(getActiveGroupingIdFor(withBoth, DASHBOARD_SCOPE)).toBe(a.grouping.id);
    expect(getActiveGroupingIdFor(withBoth, projectScope(SECRET_A))).toBe(b.grouping.id);
  });

  it('strips the override entry when set back to DEFAULT_GROUPING_ID', () => {
    const a = addGrouping(initialGlobalState(), 'A');
    const withOverride = setActiveGroupingIdFor(a.state, DASHBOARD_SCOPE, a.grouping.id);
    expect(withOverride.activeIdByScope[DASHBOARD_SCOPE]).toBe(a.grouping.id);
    const reset = setActiveGroupingIdFor(withOverride, DASHBOARD_SCOPE, DEFAULT_GROUPING_ID);
    expect(reset.activeIdByScope[DASHBOARD_SCOPE]).toBeUndefined();
    expect(getActiveGroupingIdFor(reset, DASHBOARD_SCOPE)).toBe(DEFAULT_GROUPING_ID);
  });

  it('no-ops when id does not match any grouping', () => {
    const s = initialGlobalState();
    expect(setActiveGroupingIdFor(s, DASHBOARD_SCOPE, 'g-nope')).toBe(s);
  });
});

describe('addGrouping', () => {
  it('appends a new grouping with the trimmed name + empty hiddenByProject', () => {
    const s0 = initialGlobalState();
    const { state, grouping } = addGrouping(s0, '  Server logs  ');
    expect(grouping.name).toBe('Server logs');
    expect(grouping.hiddenByProject).toEqual({});
    expect(state.groupings).toHaveLength(2);
  });

  it('falls back to "New grouping" when name is empty', () => {
    const { grouping } = addGrouping(initialGlobalState(), '   ');
    expect(grouping.name).toBe('New grouping');
  });

  it('does not mutate the input state', () => {
    const s0 = initialGlobalState();
    addGrouping(s0, 'X');
    expect(s0.groupings).toHaveLength(1);
  });
});

describe('renameGrouping', () => {
  it('renames a grouping by id', () => {
    const s0 = initialGlobalState();
    const next = renameGrouping(s0, DEFAULT_GROUPING_ID, 'Show All');
    expect(next.groupings[0].name).toBe('Show All');
  });

  it('no-ops when name is unchanged after trim', () => {
    const s0 = initialGlobalState();
    const next = renameGrouping(s0, DEFAULT_GROUPING_ID, '  Default  ');
    expect(next).toBe(s0);
  });

  it('no-ops when the id does not exist', () => {
    const s0 = initialGlobalState();
    const next = renameGrouping(s0, 'g-nope', 'X');
    expect(next).toBe(s0);
  });
});

describe('deleteGrouping', () => {
  it('refuses to delete the Default grouping', () => {
    const s0 = initialGlobalState();
    const next = deleteGrouping(s0, DEFAULT_GROUPING_ID);
    expect(next).toBe(s0);
  });

  it('removes a non-Default grouping and strips per-scope overrides that pointed at it', () => {
    const s0 = addGrouping(initialGlobalState(), 'Servers');
    const stateWithActive = setActiveGroupingIdFor(
      setActiveGroupingIdFor(s0.state, DASHBOARD_SCOPE, s0.grouping.id),
      projectScope(SECRET_A),
      s0.grouping.id,
    );
    expect(stateWithActive.activeIdByScope[DASHBOARD_SCOPE]).toBe(s0.grouping.id);
    expect(stateWithActive.activeIdByScope[projectScope(SECRET_A)]).toBe(s0.grouping.id);
    const next = deleteGrouping(stateWithActive, s0.grouping.id);
    expect(next.groupings.find(g => g.id === s0.grouping.id)).toBeUndefined();
    // Both scopes that previously pointed at the deleted grouping fall
    // back to Default — `getActiveGroupingIdFor` returns DEFAULT for
    // missing entries.
    expect(next.activeIdByScope[DASHBOARD_SCOPE]).toBeUndefined();
    expect(next.activeIdByScope[projectScope(SECRET_A)]).toBeUndefined();
    expect(getActiveGroupingIdFor(next, DASHBOARD_SCOPE)).toBe(DEFAULT_GROUPING_ID);
    expect(getActiveGroupingIdFor(next, projectScope(SECRET_A))).toBe(DEFAULT_GROUPING_ID);
  });

  it('preserves per-scope overrides that pointed at OTHER groupings', () => {
    const a = addGrouping(initialGlobalState(), 'A');
    const b = addGrouping(a.state, 'B');
    // Dashboard picks A; project picks B. Delete A.
    const withBoth = setActiveGroupingIdFor(
      setActiveGroupingIdFor(b.state, DASHBOARD_SCOPE, a.grouping.id),
      projectScope(SECRET_A),
      b.grouping.id,
    );
    const next = deleteGrouping(withBoth, a.grouping.id);
    expect(next.activeIdByScope[DASHBOARD_SCOPE]).toBeUndefined();
    expect(next.activeIdByScope[projectScope(SECRET_A)]).toBe(b.grouping.id);
  });
});

describe('reorderGroupings', () => {
  it('moves fromId into toId\'s slot', () => {
    const s0 = initialGlobalState();
    const a = addGrouping(s0, 'A');
    const b = addGrouping(a.state, 'B');
    const reordered = reorderGroupings(b.state, b.grouping.id, DEFAULT_GROUPING_ID);
    expect(reordered.groupings[0].id).toBe(b.grouping.id);
  });

  it('no-ops when fromId === toId', () => {
    const s0 = initialGlobalState();
    expect(reorderGroupings(s0, DEFAULT_GROUPING_ID, DEFAULT_GROUPING_ID)).toBe(s0);
  });
});

describe('toggleHiddenInGrouping (per-project)', () => {
  it('hides a terminal id under hiddenByProject[secret]', () => {
    const g: VisibilityGrouping = { id: 'x', name: 'X', hiddenByProject: {} };
    const next = toggleHiddenInGrouping(g, SECRET_A, 'default', true);
    expect(next.hiddenByProject[SECRET_A]).toEqual(['default']);
    expect(next.hiddenByProject[SECRET_B]).toBeUndefined();
  });

  it('unhides without leaving stale entries', () => {
    const g: VisibilityGrouping = { id: 'x', name: 'X', hiddenByProject: { [SECRET_A]: ['default'] } };
    const next = toggleHiddenInGrouping(g, SECRET_A, 'default', false);
    expect(next.hiddenByProject[SECRET_A]).toEqual([]);
  });

  it('returns the same reference when state is unchanged', () => {
    const g: VisibilityGrouping = { id: 'x', name: 'X', hiddenByProject: { [SECRET_A]: ['default'] } };
    expect(toggleHiddenInGrouping(g, SECRET_A, 'default', true)).toBe(g);
    expect(toggleHiddenInGrouping(g, SECRET_A, 'absent', false)).toBe(g);
  });

  it('routes hides to the correct project secret', () => {
    const g: VisibilityGrouping = { id: 'x', name: 'X', hiddenByProject: {} };
    const after = toggleHiddenInGrouping(toggleHiddenInGrouping(g, SECRET_A, 'one', true), SECRET_B, 'two', true);
    expect(after.hiddenByProject[SECRET_A]).toEqual(['one']);
    expect(after.hiddenByProject[SECRET_B]).toEqual(['two']);
  });
});

describe('getHiddenIdsForProject', () => {
  it('returns the hidden ids for a given project', () => {
    const g: VisibilityGrouping = { id: 'x', name: 'X', hiddenByProject: { [SECRET_A]: ['one', 'two'] } };
    expect(getHiddenIdsForProject(g, SECRET_A)).toEqual(['one', 'two']);
  });

  it('returns an empty array when the project has no entry', () => {
    const g: VisibilityGrouping = { id: 'x', name: 'X', hiddenByProject: {} };
    expect(getHiddenIdsForProject(g, SECRET_A)).toEqual([]);
  });
});

describe('updateGroupingById', () => {
  it('applies a transform to one grouping', () => {
    const s0 = initialGlobalState();
    const next = updateGroupingById(s0, DEFAULT_GROUPING_ID, g => toggleHiddenInGrouping(g, SECRET_A, 'default', true));
    expect(next.groupings[0].hiddenByProject[SECRET_A]).toEqual(['default']);
  });

  it('no-ops when the id is absent', () => {
    const s0 = initialGlobalState();
    expect(updateGroupingById(s0, 'g-nope', g => g)).toBe(s0);
  });
});

describe('parsePersistedState (HS-8290 → HS-8406)', () => {
  it('migrates the legacy scalar activeId into the dashboard scope', () => {
    const raw = [
      { id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} },
      { id: 'g-1', name: 'Servers', hiddenByProject: { [SECRET_A]: ['default'] } },
    ];
    const state = parsePersistedState(raw, 'g-1');
    expect(state.activeIdByScope).toEqual({ [DASHBOARD_SCOPE]: 'g-1' });
    expect(state.groupings[1].hiddenByProject[SECRET_A]).toEqual(['default']);
  });

  it('legacy scalar pointing at Default migrates to no override (Default is the implicit fallback)', () => {
    const raw = [{ id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} }];
    expect(parsePersistedState(raw, DEFAULT_GROUPING_ID).activeIdByScope).toEqual({});
  });

  it('legacy scalar pointing at unknown id is dropped (no override recorded)', () => {
    const raw = [{ id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} }];
    expect(parsePersistedState(raw, 'g-nope').activeIdByScope).toEqual({});
  });

  it('reads the new activeIdByScope shape verbatim, dropping unknown ids and Default redundancies', () => {
    const raw = [
      { id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} },
      { id: 'g-1', name: 'A', hiddenByProject: {} },
      { id: 'g-2', name: 'B', hiddenByProject: {} },
    ];
    const byScope = {
      [DASHBOARD_SCOPE]: 'g-1',
      [projectScope(SECRET_A)]: 'g-2',
      [projectScope(SECRET_B)]: 'g-nope',  // dropped — unknown id
      [`project:${SECRET_A}-default`]: DEFAULT_GROUPING_ID,  // dropped — Default is implicit
    };
    const state = parsePersistedState(raw, 'irrelevant', byScope);
    expect(state.activeIdByScope).toEqual({
      [DASHBOARD_SCOPE]: 'g-1',
      [projectScope(SECRET_A)]: 'g-2',
    });
  });

  it('new activeIdByScope wins over legacy scalar when both are present', () => {
    const raw = [
      { id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} },
      { id: 'g-1', name: 'A', hiddenByProject: {} },
    ];
    // Legacy says g-1 for dashboard; new map is empty (no overrides).
    // The new shape wins → no overrides → dashboard falls back to Default.
    const state = parsePersistedState(raw, 'g-1', {});
    expect(state.activeIdByScope).toEqual({});
    expect(getActiveGroupingIdFor(state, DASHBOARD_SCOPE)).toBe(DEFAULT_GROUPING_ID);
  });

  it('synthesises Default when the persisted list lacks it', () => {
    const raw = [{ id: 'g-1', name: 'Other', hiddenByProject: {} }];
    const state = parsePersistedState(raw, 'g-1');
    expect(state.groupings.find(g => g.id === DEFAULT_GROUPING_ID)).toBeDefined();
  });

  it('returns initial state on garbage input', () => {
    const state = parsePersistedState('not-an-array', undefined);
    expect(state.groupings).toEqual(initialGlobalState().groupings);
  });

  it('drops malformed per-project entries (non-array values)', () => {
    const raw = [
      { id: 'g-1', name: 'X', hiddenByProject: { [SECRET_A]: 'oops', [SECRET_B]: ['ok'] } },
    ];
    const state = parsePersistedState(raw, 'g-1');
    expect(state.groupings.find(g => g.id === 'g-1')!.hiddenByProject[SECRET_A]).toBeUndefined();
    expect(state.groupings.find(g => g.id === 'g-1')!.hiddenByProject[SECRET_B]).toEqual(['ok']);
  });
});

describe('pruneStaleIdsInGroupings (HS-8290)', () => {
  it('drops ids no longer in the configured set for a single project', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'g-1', name: 'X', hiddenByProject: { [SECRET_A]: ['stale', 'keep'] } },
    ];
    const pruned = pruneStaleIdsInGroupings(groupings, SECRET_A, new Set(['keep']));
    expect(pruned).not.toBeNull();
    expect(pruned![0].hiddenByProject[SECRET_A]).toEqual(['keep']);
  });

  it('returns null when no prune is needed', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'g-1', name: 'X', hiddenByProject: { [SECRET_A]: ['keep'] } },
    ];
    expect(pruneStaleIdsInGroupings(groupings, SECRET_A, new Set(['keep']))).toBeNull();
  });

  it('removes the secret entry entirely when every id is pruned', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'g-1', name: 'X', hiddenByProject: { [SECRET_A]: ['stale'], [SECRET_B]: ['keep'] } },
    ];
    const pruned = pruneStaleIdsInGroupings(groupings, SECRET_A, new Set([]));
    expect(pruned).not.toBeNull();
    expect(pruned![0].hiddenByProject[SECRET_A]).toBeUndefined();
    expect(pruned![0].hiddenByProject[SECRET_B]).toEqual(['keep']);
  });
});
