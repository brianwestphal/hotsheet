import { describe, expect, it } from 'vitest';

import {
  addGrouping,
  DEFAULT_GROUPING_ID,
  DEFAULT_GROUPING_NAME,
  deleteGrouping,
  generateGroupingId,
  getActiveGrouping,
  getHiddenIdsForProject,
  type GlobalVisibilityState,
  initialGlobalState,
  parsePersistedState,
  pruneStaleIdsInGroupings,
  renameGrouping,
  reorderGroupings,
  setActiveGroupingId,
  toggleHiddenInGrouping,
  updateGroupingById,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

const SECRET_A = 'aaaa1111';
const SECRET_B = 'bbbb2222';

describe('initialGlobalState (HS-8290)', () => {
  it('returns a single Default grouping with no per-project hidden ids', () => {
    const s = initialGlobalState();
    expect(s.groupings).toHaveLength(1);
    expect(s.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
    expect(s.groupings[0].name).toBe(DEFAULT_GROUPING_NAME);
    expect(s.groupings[0].hiddenByProject).toEqual({});
    expect(s.activeId).toBe(DEFAULT_GROUPING_ID);
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

describe('getActiveGrouping', () => {
  it('returns the grouping whose id matches activeId', () => {
    const s = initialGlobalState();
    expect(getActiveGrouping(s).id).toBe(DEFAULT_GROUPING_ID);
  });

  it('falls back to the first grouping when activeId does not match', () => {
    const state: GlobalVisibilityState = {
      groupings: [
        { id: 'a', name: 'A', hiddenByProject: {} },
        { id: 'b', name: 'B', hiddenByProject: {} },
      ],
      activeId: 'unknown',
    };
    expect(getActiveGrouping(state).id).toBe('a');
  });

  it('returns a synthesized empty Default when groupings list is empty', () => {
    const g = getActiveGrouping({ groupings: [], activeId: '' });
    expect(g.id).toBe(DEFAULT_GROUPING_ID);
    expect(g.hiddenByProject).toEqual({});
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

  it('removes a non-Default grouping and falls activeId back to Default', () => {
    const s0 = addGrouping(initialGlobalState(), 'Servers');
    const stateWithActive = setActiveGroupingId(s0.state, s0.grouping.id);
    const next = deleteGrouping(stateWithActive, s0.grouping.id);
    expect(next.groupings.find(g => g.id === s0.grouping.id)).toBeUndefined();
    expect(next.activeId).toBe(DEFAULT_GROUPING_ID);
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

describe('parsePersistedState (HS-8290)', () => {
  it('parses the new shape and uses the requested activeId', () => {
    const raw = [
      { id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} },
      { id: 'g-1', name: 'Servers', hiddenByProject: { [SECRET_A]: ['default'] } },
    ];
    const state = parsePersistedState(raw, 'g-1');
    expect(state.activeId).toBe('g-1');
    expect(state.groupings[1].hiddenByProject[SECRET_A]).toEqual(['default']);
  });

  it('falls back to first grouping id when activeId is unknown', () => {
    const raw = [{ id: DEFAULT_GROUPING_ID, name: 'Default', hiddenByProject: {} }];
    expect(parsePersistedState(raw, 'g-nope').activeId).toBe(DEFAULT_GROUPING_ID);
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
