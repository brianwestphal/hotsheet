import { describe, expect, it } from 'vitest';

import {
  backfillCommandIds,
  type CommandItem,
  type CommandTreeDelta,
  computeCommandTreeDelta,
  isCommandTreeDelta,
  moveChildToLocal,
  moveChildToShared,
  moveTopLevelToLocal,
  moveTopLevelToShared,
  resolveCommandTreeDelta,
} from './settingsCommandDelta.js';

/** A shared tree fixture: two top-level commands + one group with two children. */
function sharedTree(): CommandItem[] {
  return [
    { id: 'cmd-a', name: 'A', prompt: 'pa' },
    { id: 'cmd-b', name: 'B', prompt: 'pb' },
    {
      type: 'group', id: 'grp-1', name: 'Group 1', children: [
        { id: 'cmd-c', name: 'C', prompt: 'pc' },
        { id: 'cmd-d', name: 'D', prompt: 'pd' },
      ],
    },
  ];
}

/** Resolve then re-derive the delta; the second delta must equal the first
 *  (round-trip stability) and re-resolving must give the same tree. */
function roundTrip(shared: CommandItem[], delta: CommandTreeDelta): { resolved: CommandItem[]; redelta: CommandTreeDelta } {
  const resolved = resolveCommandTreeDelta(shared, delta);
  const redelta = computeCommandTreeDelta(shared, resolved);
  return { resolved, redelta };
}

describe('isCommandTreeDelta', () => {
  it('recognizes a delta object but not arrays/scalars', () => {
    expect(isCommandTreeDelta({ hidden: ['x'] })).toBe(true);
    expect(isCommandTreeDelta({ childAdded: {} })).toBe(true);
    expect(isCommandTreeDelta([])).toBe(false);
    expect(isCommandTreeDelta('str')).toBe(false);
    expect(isCommandTreeDelta(null)).toBe(false);
    expect(isCommandTreeDelta({ unrelated: 1 })).toBe(false);
  });
});

describe('resolveCommandTreeDelta', () => {
  it('returns a clone of shared when the delta is empty', () => {
    const shared = sharedTree();
    const out = resolveCommandTreeDelta(shared, {});
    expect(out.map(i => i.id)).toEqual(['cmd-a', 'cmd-b', 'grp-1']);
    expect(out[0]).not.toBe(shared[0]); // cloned, not aliased
  });

  it('hides a top-level command', () => {
    const out = resolveCommandTreeDelta(sharedTree(), { hidden: ['cmd-a'] });
    expect(out.map(i => i.id)).toEqual(['cmd-b', 'grp-1']);
  });

  it('hides a whole group', () => {
    const out = resolveCommandTreeDelta(sharedTree(), { hidden: ['grp-1'] });
    expect(out.map(i => i.id)).toEqual(['cmd-a', 'cmd-b']);
  });

  it('hides an individual child inside a shared group', () => {
    const out = resolveCommandTreeDelta(sharedTree(), { hidden: ['cmd-c'] });
    const grp = out.find(i => i.id === 'grp-1');
    expect(grp && 'children' in grp ? grp.children.map(c => c.id) : []).toEqual(['cmd-d']);
  });

  it('applies a command override (shallow merge)', () => {
    const out = resolveCommandTreeDelta(sharedTree(), { overrides: { 'cmd-a': { name: 'A2', color: '#fff' } } });
    const a = out.find(i => i.id === 'cmd-a');
    expect(a?.name).toBe('A2');
    expect(a && 'color' in a ? a.color : undefined).toBe('#fff');
    expect(a && 'prompt' in a ? a.prompt : undefined).toBe('pa'); // untouched field preserved
  });

  it('adds a local child into a shared group', () => {
    const out = resolveCommandTreeDelta(sharedTree(), {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    });
    const grp = out.find(i => i.id === 'grp-1');
    expect(grp && 'children' in grp ? grp.children.map(c => c.id) : []).toEqual(['cmd-c', 'cmd-d', 'cmd-local']);
  });

  it('appends top-level local additions after the shared tree', () => {
    const out = resolveCommandTreeDelta(sharedTree(), { added: [{ id: 'cmd-x', name: 'X', prompt: 'px' }] });
    expect(out.map(i => i.id)).toEqual(['cmd-a', 'cmd-b', 'grp-1', 'cmd-x']);
  });

  it('survives an orphaned parent group: a local child outlives its shared group disappearing', () => {
    // Shared no longer contains grp-1, but the local delta still adds a child into it.
    const sharedWithoutGroup: CommandItem[] = [
      { id: 'cmd-a', name: 'A', prompt: 'pa' },
    ];
    const delta: CommandTreeDelta = {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    };
    const out = resolveCommandTreeDelta(sharedWithoutGroup, delta);
    expect(out.map(i => i.id)).toEqual(['cmd-a', 'grp-1']);
    const grp = out.find(i => i.id === 'grp-1');
    expect(grp && 'type' in grp).toBe(true); // materialized as a local group
    expect(grp && 'children' in grp ? grp.children.map(c => c.id) : []).toEqual(['cmd-local']);
  });
});

describe('computeCommandTreeDelta (round-trip with resolve)', () => {
  it('empty edit yields an empty delta', () => {
    const shared = sharedTree();
    expect(computeCommandTreeDelta(shared, resolveCommandTreeDelta(shared, {}))).toEqual({});
  });

  it('round-trips a hide of a top-level command', () => {
    const { redelta } = roundTrip(sharedTree(), { hidden: ['cmd-a'] });
    expect(redelta.hidden).toEqual(['cmd-a']);
  });

  it('round-trips a hidden child', () => {
    const { redelta } = roundTrip(sharedTree(), { hidden: ['cmd-c'] });
    expect(redelta.hidden).toEqual(['cmd-c']);
  });

  it('round-trips a command override', () => {
    const { redelta } = roundTrip(sharedTree(), { overrides: { 'cmd-a': { name: 'A2' } } });
    expect(redelta.overrides?.['cmd-a']?.name).toBe('A2');
  });

  it('round-trips a group-scoped add (childAdded)', () => {
    const { redelta } = roundTrip(sharedTree(), {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    });
    expect(redelta.childAdded?.['grp-1']?.children.map(c => c.id)).toEqual(['cmd-local']);
  });

  it('round-trips a top-level local addition', () => {
    const { redelta } = roundTrip(sharedTree(), { added: [{ id: 'cmd-x', name: 'X', prompt: 'px' }] });
    expect(redelta.added?.map(i => i.id)).toEqual(['cmd-x']);
  });

  it('round-trips an orphaned group back into childAdded (not added)', () => {
    const sharedWithoutGroup: CommandItem[] = [{ id: 'cmd-a', name: 'A', prompt: 'pa' }];
    const delta: CommandTreeDelta = {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    };
    const { redelta } = roundTrip(sharedWithoutGroup, delta);
    // Crucially NOT promoted to a top-level `added` group — stays childAdded so it
    // re-attaches if grp-1 ever returns to shared.
    expect(redelta.added).toBeUndefined();
    expect(redelta.childAdded?.['grp-1']?.children.map(c => c.id)).toEqual(['cmd-local']);
  });

  it('computes a hide when the editor removed a shared command', () => {
    const shared = sharedTree();
    const edited = shared.filter(i => i.id !== 'cmd-b'); // user removed B in Local mode
    const delta = computeCommandTreeDelta(shared, edited);
    expect(delta.hidden).toEqual(['cmd-b']);
  });
});

describe('moveTopLevelToLocal / moveTopLevelToShared', () => {
  it('moves a shared top-level command to local: removed from shared, added to delta, resolved unchanged in membership', () => {
    const shared = sharedTree();
    const { shared: shared2, delta } = moveTopLevelToLocal({ shared, delta: {} }, 'cmd-a');
    expect(shared2.map(i => i.id)).toEqual(['cmd-b', 'grp-1']); // dropped from shared
    expect(delta.added?.map(i => i.id)).toEqual(['cmd-a']); // now a local addition
    // The resolved effective list still contains cmd-a (now appended after shared).
    const resolved = resolveCommandTreeDelta(shared2, delta);
    expect(resolved.map(i => i.id).sort()).toEqual(['cmd-a', 'cmd-b', 'grp-1']);
  });

  it('moves a shared group to local, folding its shared children + childAdded into one local group', () => {
    const shared = sharedTree();
    const delta: CommandTreeDelta = {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    };
    const moved = moveTopLevelToLocal({ shared, delta }, 'grp-1');
    expect(moved.shared.map(i => i.id)).toEqual(['cmd-a', 'cmd-b']); // group gone from shared
    expect(moved.delta.childAdded).toBeUndefined(); // childAdded folded in
    const localGroup = moved.delta.added?.find(i => i.id === 'grp-1');
    expect(localGroup && 'children' in localGroup ? localGroup.children.map(c => c.id) : [])
      .toEqual(['cmd-c', 'cmd-d', 'cmd-local']);
  });

  it('is a no-op when the id is not a shared top-level item', () => {
    const shared = sharedTree();
    const result = moveTopLevelToLocal({ shared, delta: {} }, 'nope');
    expect(result.shared).toBe(shared);
  });

  it('moves a local-only addition to shared (promote): appended to shared, dropped from delta.added', () => {
    const shared = sharedTree();
    const delta: CommandTreeDelta = { added: [{ id: 'cmd-x', name: 'X', prompt: 'px' }] };
    const moved = moveTopLevelToShared({ shared, delta }, 'cmd-x');
    expect(moved.shared.map(i => i.id)).toEqual(['cmd-a', 'cmd-b', 'grp-1', 'cmd-x']);
    expect(moved.delta.added).toBeUndefined();
  });

  it('promote is a no-op when the id is not a local addition', () => {
    const shared = sharedTree();
    const delta: CommandTreeDelta = { added: [{ id: 'cmd-x', name: 'X', prompt: 'px' }] };
    const result = moveTopLevelToShared({ shared, delta }, 'cmd-a');
    expect(result.shared).toBe(shared);
  });

  it('round-trips: promote-to-local then back-to-shared restores shared membership', () => {
    const shared = sharedTree();
    const toLocal = moveTopLevelToLocal({ shared, delta: {} }, 'cmd-b');
    const back = moveTopLevelToShared(toLocal, 'cmd-b');
    expect(back.shared.map(i => i.id).sort()).toEqual(['cmd-a', 'cmd-b', 'grp-1']);
    expect(back.delta.added).toBeUndefined();
  });
});

describe('moveChildToLocal / moveChildToShared (HS-9094)', () => {
  const childrenOf = (tree: CommandItem[], gid: string): string[] => {
    const g = tree.find(i => i.id === gid);
    return g && 'children' in g ? g.children.map(c => c.id ?? '') : [];
  };

  it('moves a shared child to local: removed from the shared group, added as childAdded, resolved membership unchanged', () => {
    const { shared, delta } = moveChildToLocal({ shared: sharedTree(), delta: {} }, 'cmd-c');
    // Physically left the shared group in settings.json.
    expect(childrenOf(shared, 'grp-1')).toEqual(['cmd-d']);
    // Now a local child of the same group.
    expect(delta.childAdded?.['grp-1']?.children.map(c => c.id)).toEqual(['cmd-c']);
    // Resolved still shows both children in the group (cmd-c appended after cmd-d).
    expect(childrenOf(resolveCommandTreeDelta(shared, delta), 'grp-1')).toEqual(['cmd-d', 'cmd-c']);
  });

  it('is a no-op when the id is not a shared child', () => {
    const layers = { shared: sharedTree(), delta: {} };
    expect(moveChildToLocal(layers, 'nope')).toBe(layers);
  });

  it('moves a local child back to shared: appended to the shared group, dropped from childAdded', () => {
    const delta: CommandTreeDelta = {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    };
    const moved = moveChildToShared({ shared: sharedTree(), delta }, 'cmd-local');
    expect(childrenOf(moved.shared, 'grp-1')).toEqual(['cmd-c', 'cmd-d', 'cmd-local']);
    expect(moved.delta.childAdded).toBeUndefined(); // entry emptied + dropped
  });

  it('child move round-trips: shared→local then local→shared restores shared membership', () => {
    const toLocal = moveChildToLocal({ shared: sharedTree(), delta: {} }, 'cmd-c');
    const back = moveChildToShared(toLocal, 'cmd-c');
    expect(childrenOf(back.shared, 'grp-1').sort()).toEqual(['cmd-c', 'cmd-d']);
    expect(back.delta.childAdded).toBeUndefined();
  });

  it('promote-to-shared is a no-op when the parent group is gone from shared (orphan)', () => {
    const sharedWithoutGroup: CommandItem[] = [{ id: 'cmd-a', name: 'A', prompt: 'pa' }];
    const delta: CommandTreeDelta = {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'cmd-local', name: 'L', prompt: 'pl' }] } },
    };
    const layers = { shared: sharedWithoutGroup, delta };
    expect(moveChildToShared(layers, 'cmd-local')).toBe(layers);
  });

  it('appends to an existing childAdded entry rather than replacing it', () => {
    const delta: CommandTreeDelta = {
      childAdded: { 'grp-1': { group: { id: 'grp-1', name: 'Group 1' }, children: [{ id: 'pre-existing', name: 'P', prompt: 'pp' }] } },
    };
    const moved = moveChildToLocal({ shared: sharedTree(), delta }, 'cmd-c');
    expect(moved.delta.childAdded?.['grp-1']?.children.map(c => c.id)).toEqual(['pre-existing', 'cmd-c']);
  });
});

describe('backfillCommandIds', () => {
  it('assigns ids to items lacking them and reports changed', () => {
    const items: CommandItem[] = [
      { name: 'A', prompt: 'pa' },
      { type: 'group', name: 'G', children: [{ name: 'C', prompt: 'pc' }] },
    ];
    const { items: out, changed } = backfillCommandIds(items);
    expect(changed).toBe(true);
    expect(typeof out[0].id).toBe('string');
    expect(out[0].id).not.toBe('');
    const grp = out[1];
    expect(grp.id).toBeDefined();
    expect('children' in grp ? grp.children[0].id : undefined).toBeDefined();
  });

  it('is idempotent: a second pass reports no change and preserves ids', () => {
    const first = backfillCommandIds([
      { name: 'A', prompt: 'pa' },
      { type: 'group', name: 'G', children: [{ name: 'C', prompt: 'pc' }] },
    ]);
    const second = backfillCommandIds(first.items);
    expect(second.changed).toBe(false);
    expect(second.items[0].id).toBe(first.items[0].id);
    const g1 = first.items[1], g2 = second.items[1];
    expect('children' in g1 && 'children' in g2 ? g2.children[0].id === g1.children[0].id : false).toBe(true);
  });

  it('leaves a fully-id\'d tree untouched', () => {
    const { changed } = backfillCommandIds(sharedTree());
    expect(changed).toBe(false);
  });
});
