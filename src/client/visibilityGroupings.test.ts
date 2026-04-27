import { describe, expect, it } from 'vitest';

import {
  addGrouping,
  addGroupingWithId,
  DEFAULT_GROUPING_ID,
  DEFAULT_GROUPING_NAME,
  deleteGrouping,
  generateGroupingId,
  getActiveGrouping,
  initialProjectState,
  parsePersistedState,
  pruneStaleIdsInGroupings,
  renameGrouping,
  reorderGroupings,
  setActiveGroupingId,
  toggleHiddenInGrouping,
  updateGroupingById,
  type VisibilityGrouping,
} from './visibilityGroupings.js';

describe('initialProjectState (HS-7826)', () => {
  it('returns a single Default grouping when no seed is given', () => {
    const s = initialProjectState();
    expect(s.groupings).toHaveLength(1);
    expect(s.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
    expect(s.groupings[0].name).toBe(DEFAULT_GROUPING_NAME);
    expect(s.groupings[0].hiddenIds).toEqual([]);
    expect(s.activeId).toBe(DEFAULT_GROUPING_ID);
  });

  it('seeds the Default grouping with the supplied hidden ids', () => {
    const s = initialProjectState(['default', 'claude']);
    expect(s.groupings[0].hiddenIds).toEqual(['default', 'claude']);
  });

  it('clones the seed array (mutating the original does not affect state)', () => {
    const seed = ['a'];
    const s = initialProjectState(seed);
    seed.push('b');
    expect(s.groupings[0].hiddenIds).toEqual(['a']);
  });
});

describe('generateGroupingId (HS-7826)', () => {
  it('returns an id with the g- prefix', () => {
    const id = generateGroupingId([]);
    expect(id.startsWith('g-')).toBe(true);
  });

  it('avoids collisions with existing ids', () => {
    const existing: VisibilityGrouping[] = [
      { id: 'g-existing-1', name: 'X', hiddenIds: [] },
      { id: 'g-existing-2', name: 'Y', hiddenIds: [] },
    ];
    const id = generateGroupingId(existing);
    expect(id).not.toBe('g-existing-1');
    expect(id).not.toBe('g-existing-2');
  });
});

describe('getActiveGrouping (HS-7826)', () => {
  it('returns the grouping whose id matches activeId', () => {
    const s = initialProjectState();
    const g = getActiveGrouping(s);
    expect(g.id).toBe(DEFAULT_GROUPING_ID);
  });

  it('falls back to the first grouping when activeId does not match', () => {
    const state = {
      groupings: [
        { id: 'a', name: 'A', hiddenIds: [] },
        { id: 'b', name: 'B', hiddenIds: [] },
      ],
      activeId: 'unknown',
    };
    expect(getActiveGrouping(state).id).toBe('a');
  });

  it('returns a synthesized empty Default when groupings list is empty', () => {
    const g = getActiveGrouping({ groupings: [], activeId: '' });
    expect(g.id).toBe(DEFAULT_GROUPING_ID);
    expect(g.hiddenIds).toEqual([]);
  });
});

describe('addGrouping (HS-7826)', () => {
  it('appends a new grouping with the trimmed name', () => {
    const s0 = initialProjectState();
    const { state, grouping } = addGrouping(s0, '  Server logs  ');
    expect(grouping.name).toBe('Server logs');
    expect(state.groupings).toHaveLength(2);
    expect(state.groupings[1]).toBe(grouping);
  });

  it('falls back to "New grouping" when name is empty', () => {
    const s0 = initialProjectState();
    const { grouping } = addGrouping(s0, '   ');
    expect(grouping.name).toBe('New grouping');
  });

  it('starts the new grouping with empty hiddenIds', () => {
    const s0 = initialProjectState(['some', 'hidden']);
    const { grouping } = addGrouping(s0, 'Other');
    expect(grouping.hiddenIds).toEqual([]);
  });

  it('does not mutate the input state', () => {
    const s0 = initialProjectState();
    addGrouping(s0, 'X');
    expect(s0.groupings).toHaveLength(1);
  });
});

describe('addGroupingWithId (HS-7826 follow-up — cross-project fan-out)', () => {
  it('appends a new grouping under the supplied id', () => {
    const s0 = initialProjectState();
    const { state, grouping } = addGroupingWithId(s0, 'g-shared-1', 'Servers');
    expect(grouping.id).toBe('g-shared-1');
    expect(grouping.name).toBe('Servers');
    expect(state.groupings).toHaveLength(2);
    expect(state.groupings[1]).toBe(grouping);
  });

  it('is a no-op when the id is already present (returns the existing grouping)', () => {
    const s0 = initialProjectState();
    const { state: s1, grouping: g1 } = addGroupingWithId(s0, 'g-shared', 'Servers');
    const { state: s2, grouping: g2 } = addGroupingWithId(s1, 'g-shared', 'Apps');
    expect(s2).toBe(s1);
    expect(g2).toBe(g1);
    expect(s2.groupings).toHaveLength(2);
    expect(s2.groupings[1].name).toBe('Servers');
  });

  it('falls back to "New grouping" when name is empty', () => {
    const s0 = initialProjectState();
    const { grouping } = addGroupingWithId(s0, 'g-new', '   ');
    expect(grouping.name).toBe('New grouping');
  });

  it('does not mutate the input state', () => {
    const s0 = initialProjectState();
    addGroupingWithId(s0, 'g-x', 'X');
    expect(s0.groupings).toHaveLength(1);
  });
});

describe('renameGrouping (HS-7826)', () => {
  it('updates the name of the matching grouping', () => {
    const s0 = initialProjectState();
    const s1 = renameGrouping(s0, DEFAULT_GROUPING_ID, 'My Default');
    expect(s1.groupings[0].name).toBe('My Default');
  });

  it('is a no-op when name is empty after trimming', () => {
    const s0 = initialProjectState();
    const s1 = renameGrouping(s0, DEFAULT_GROUPING_ID, '   ');
    expect(s1).toBe(s0);
  });

  it('is a no-op when id does not match any grouping', () => {
    const s0 = initialProjectState();
    const s1 = renameGrouping(s0, 'unknown', 'X');
    expect(s1).toBe(s0);
  });

  it('returns the same state reference when nothing changed', () => {
    const s0 = initialProjectState();
    const s1 = renameGrouping(s0, DEFAULT_GROUPING_ID, DEFAULT_GROUPING_NAME);
    expect(s1).toBe(s0);
  });
});

describe('deleteGrouping (HS-7826)', () => {
  it('refuses to delete the Default grouping', () => {
    const s0 = initialProjectState();
    const s1 = deleteGrouping(s0, DEFAULT_GROUPING_ID);
    expect(s1).toBe(s0);
  });

  it('removes the matching non-Default grouping', () => {
    const s0 = initialProjectState();
    const { state: s1, grouping: g } = addGrouping(s0, 'Other');
    const s2 = deleteGrouping(s1, g.id);
    expect(s2.groupings).toHaveLength(1);
    expect(s2.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
  });

  it('falls back to Default when the active grouping is deleted', () => {
    const s0 = initialProjectState();
    const { state: s1, grouping: g } = addGrouping(s0, 'Other');
    const s2 = setActiveGroupingId(s1, g.id);
    expect(s2.activeId).toBe(g.id);
    const s3 = deleteGrouping(s2, g.id);
    expect(s3.activeId).toBe(DEFAULT_GROUPING_ID);
  });

  it('keeps activeId unchanged when deleting a non-active grouping', () => {
    const s0 = initialProjectState();
    const { state: s1, grouping: g1 } = addGrouping(s0, 'A');
    const { state: s2, grouping: g2 } = addGrouping(s1, 'B');
    const s3 = setActiveGroupingId(s2, g1.id);
    const s4 = deleteGrouping(s3, g2.id);
    expect(s4.activeId).toBe(g1.id);
  });
});

describe('reorderGroupings (HS-7826)', () => {
  it('moves fromId into the slot occupied by toId', () => {
    const s0 = {
      groupings: [
        { id: 'a', name: 'A', hiddenIds: [] },
        { id: 'b', name: 'B', hiddenIds: [] },
        { id: 'c', name: 'C', hiddenIds: [] },
      ],
      activeId: 'a',
    };
    const s1 = reorderGroupings(s0, 'a', 'c');
    expect(s1.groupings.map(g => g.id)).toEqual(['b', 'c', 'a']);
  });

  it('is a no-op when fromId === toId', () => {
    const s0 = initialProjectState();
    const s1 = reorderGroupings(s0, DEFAULT_GROUPING_ID, DEFAULT_GROUPING_ID);
    expect(s1).toBe(s0);
  });

  it('preserves activeId', () => {
    const s0 = {
      groupings: [
        { id: 'a', name: 'A', hiddenIds: [] },
        { id: 'b', name: 'B', hiddenIds: [] },
      ],
      activeId: 'b',
    };
    const s1 = reorderGroupings(s0, 'a', 'b');
    expect(s1.activeId).toBe('b');
  });
});

describe('setActiveGroupingId (HS-7826)', () => {
  it('flips activeId when the target grouping exists', () => {
    const s0 = initialProjectState();
    const { state: s1, grouping: g } = addGrouping(s0, 'Other');
    const s2 = setActiveGroupingId(s1, g.id);
    expect(s2.activeId).toBe(g.id);
  });

  it('is a no-op when the target id does not exist', () => {
    const s0 = initialProjectState();
    const s1 = setActiveGroupingId(s0, 'unknown');
    expect(s1).toBe(s0);
  });
});

describe('toggleHiddenInGrouping (HS-7826)', () => {
  it('adds the terminal id to hiddenIds when hide=true', () => {
    const g0: VisibilityGrouping = { id: 'a', name: 'A', hiddenIds: [] };
    const g1 = toggleHiddenInGrouping(g0, 'term-1', true);
    expect(g1.hiddenIds).toEqual(['term-1']);
  });

  it('removes the terminal id when hide=false', () => {
    const g0: VisibilityGrouping = { id: 'a', name: 'A', hiddenIds: ['term-1', 'term-2'] };
    const g1 = toggleHiddenInGrouping(g0, 'term-1', false);
    expect(g1.hiddenIds).toEqual(['term-2']);
  });

  it('is a no-op when hide=true and the id is already present', () => {
    const g0: VisibilityGrouping = { id: 'a', name: 'A', hiddenIds: ['term-1'] };
    const g1 = toggleHiddenInGrouping(g0, 'term-1', true);
    expect(g1).toBe(g0);
  });

  it('is a no-op when hide=false and the id is not present', () => {
    const g0: VisibilityGrouping = { id: 'a', name: 'A', hiddenIds: [] };
    const g1 = toggleHiddenInGrouping(g0, 'term-1', false);
    expect(g1).toBe(g0);
  });
});

describe('updateGroupingById (HS-7826)', () => {
  it('replaces the matching grouping with the transformed value', () => {
    const s0 = initialProjectState();
    const s1 = updateGroupingById(s0, DEFAULT_GROUPING_ID, g => ({ ...g, hiddenIds: ['x'] }));
    expect(s1.groupings[0].hiddenIds).toEqual(['x']);
  });

  it('returns the same state reference when transform returns the same grouping', () => {
    const s0 = initialProjectState();
    const s1 = updateGroupingById(s0, DEFAULT_GROUPING_ID, g => g);
    expect(s1).toBe(s0);
  });
});

describe('parsePersistedState (HS-7826)', () => {
  it('parses the new groupings shape verbatim', () => {
    const raw = [
      { id: 'default', name: 'Default', hiddenIds: ['t1'] },
      { id: 'g-abc', name: 'Server logs', hiddenIds: ['t2'] },
    ];
    const s = parsePersistedState(raw, 'g-abc');
    expect(s.groupings).toHaveLength(2);
    expect(s.activeId).toBe('g-abc');
  });

  it('ensures Default exists even when the persisted list is missing it', () => {
    const raw = [{ id: 'g-abc', name: 'Other', hiddenIds: [] }];
    const s = parsePersistedState(raw, 'g-abc');
    expect(s.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
    expect(s.groupings[1].id).toBe('g-abc');
  });

  it('falls back to the legacy hidden_terminals list when groupings is missing', () => {
    const s = parsePersistedState(undefined, undefined, ['legacy-1', 'legacy-2']);
    expect(s.groupings).toHaveLength(1);
    expect(s.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
    expect(s.groupings[0].hiddenIds).toEqual(['legacy-1', 'legacy-2']);
  });

  it('returns an empty-Default state when both new and legacy shapes are absent', () => {
    const s = parsePersistedState(undefined, undefined, undefined);
    expect(s.groupings).toHaveLength(1);
    expect(s.groupings[0].hiddenIds).toEqual([]);
  });

  it('tolerates the stringified-JSON shape', () => {
    const raw = JSON.stringify([{ id: 'default', name: 'Default', hiddenIds: ['t1'] }]);
    const s = parsePersistedState(raw, 'default');
    expect(s.groupings[0].hiddenIds).toEqual(['t1']);
  });

  it('drops malformed grouping entries (missing id, wrong type) and de-duplicates by id', () => {
    const raw = [
      { id: 'a', name: 'A', hiddenIds: ['t1'] },
      { id: 'a', name: 'A-dupe', hiddenIds: ['t2'] }, // duplicate id — drop
      { name: 'B', hiddenIds: [] },                    // no id — drop
      'not-an-object',                                  // wrong type — drop
    ];
    const s = parsePersistedState(raw, 'a');
    // Default prepended + 'a' kept (first seen wins for dupes).
    expect(s.groupings.map(g => g.id)).toEqual([DEFAULT_GROUPING_ID, 'a']);
    expect(s.groupings.find(g => g.id === 'a')!.hiddenIds).toEqual(['t1']);
  });

  it('falls back to the first grouping when activeId does not match any', () => {
    const raw = [{ id: 'default', name: 'Default', hiddenIds: [] }];
    const s = parsePersistedState(raw, 'unknown');
    expect(s.activeId).toBe(DEFAULT_GROUPING_ID);
  });
});

describe('pruneStaleIdsInGroupings (HS-7826 / HS-7829 generalisation)', () => {
  it('returns null when every hidden id is still configured', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'a', name: 'A', hiddenIds: ['t1'] },
      { id: 'b', name: 'B', hiddenIds: ['t1', 't2'] },
    ];
    expect(pruneStaleIdsInGroupings(groupings, new Set(['t1', 't2']))).toBeNull();
  });

  it('returns null when every grouping has empty hiddenIds', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'a', name: 'A', hiddenIds: [] },
    ];
    expect(pruneStaleIdsInGroupings(groupings, new Set(['t1']))).toBeNull();
  });

  it('strips ids that are no longer configured from every grouping', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'a', name: 'A', hiddenIds: ['t1', 'gone'] },
      { id: 'b', name: 'B', hiddenIds: ['gone', 't2'] },
    ];
    const next = pruneStaleIdsInGroupings(groupings, new Set(['t1', 't2']));
    expect(next).not.toBeNull();
    expect(next![0].hiddenIds).toEqual(['t1']);
    expect(next![1].hiddenIds).toEqual(['t2']);
  });

  it('preserves grouping order, ids, and names', () => {
    const groupings: VisibilityGrouping[] = [
      { id: 'a', name: 'A', hiddenIds: ['gone'] },
      { id: 'b', name: 'B', hiddenIds: [] },
    ];
    const next = pruneStaleIdsInGroupings(groupings, new Set([]))!;
    expect(next.map(g => g.id)).toEqual(['a', 'b']);
    expect(next.map(g => g.name)).toEqual(['A', 'B']);
  });
});
