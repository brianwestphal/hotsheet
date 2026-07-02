import { describe, expect, it } from 'vitest';

import { type ArrayDelta, computeArrayDelta, isArrayDelta, moveArrayItemToLocal, moveArrayItemToShared, resolveDeltaArray } from './settingsDelta.js';

interface Item { id: string; name: string; n?: number }
const idOf = (i: Item): string => i.id;

const shared: Item[] = [
  { id: 'a', name: 'Alpha' },
  { id: 'b', name: 'Beta' },
  { id: 'c', name: 'Gamma' },
];

describe('isArrayDelta', () => {
  it('is true for objects with at least one delta field', () => {
    expect(isArrayDelta({ hidden: [] })).toBe(true);
    expect(isArrayDelta({ added: [] })).toBe(true);
    expect(isArrayDelta({ overrides: {} })).toBe(true);
  });
  it('is false for arrays, scalars, null, and unrelated objects', () => {
    expect(isArrayDelta([])).toBe(false);
    expect(isArrayDelta(null)).toBe(false);
    expect(isArrayDelta('x')).toBe(false);
    expect(isArrayDelta({ foo: 1 })).toBe(false);
  });
});

describe('resolveDeltaArray', () => {
  it('returns a COPY of shared when local is absent (no delta)', () => {
    const out = resolveDeltaArray(shared, undefined, idOf);
    expect(out).toEqual(shared);
    expect(out).not.toBe(shared); // copy, not the same reference
  });

  it('back-compat: a plain-array local wins wholesale (legacy whole-replacement)', () => {
    const local: Item[] = [{ id: 'z', name: 'Zeta' }];
    expect(resolveDeltaArray(shared, local, idOf)).toEqual(local);
  });

  it('ignores a malformed local value (returns shared)', () => {
    expect(resolveDeltaArray(shared, 'garbage', idOf)).toEqual(shared);
    expect(resolveDeltaArray(shared, 42, idOf)).toEqual(shared);
  });

  it('hides shared items by id, preserving shared order', () => {
    const delta: ArrayDelta<Item> = { hidden: ['b'] };
    expect(resolveDeltaArray(shared, delta, idOf).map(i => i.id)).toEqual(['a', 'c']);
  });

  it('shallow-merges per-item overrides onto the shared item', () => {
    const delta: ArrayDelta<Item> = { overrides: { a: { name: 'Alpha!', n: 1 } } };
    const out = resolveDeltaArray(shared, delta, idOf);
    expect(out[0]).toEqual({ id: 'a', name: 'Alpha!', n: 1 });
    expect(out[1]).toEqual({ id: 'b', name: 'Beta' }); // untouched
  });

  it('appends local-only added items AFTER the kept shared items', () => {
    const delta: ArrayDelta<Item> = { added: [{ id: 'x', name: 'Local X' }] };
    expect(resolveDeltaArray(shared, delta, idOf).map(i => i.id)).toEqual(['a', 'b', 'c', 'x']);
  });

  it('combines hide + override + add (shared order kept, added appended)', () => {
    const delta: ArrayDelta<Item> = {
      hidden: ['c'],
      overrides: { b: { name: 'Beta2' } },
      added: [{ id: 'x', name: 'Local X' }, { id: 'y', name: 'Local Y' }],
    };
    const out = resolveDeltaArray(shared, delta, idOf);
    expect(out.map(i => i.id)).toEqual(['a', 'b', 'x', 'y']); // c hidden, x/y appended
    expect(out.find(i => i.id === 'b')?.name).toBe('Beta2');
  });

  it('hidden ids that do not match any shared item are no-ops', () => {
    expect(resolveDeltaArray(shared, { hidden: ['nope'] }, idOf).map(i => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('works with a composite idOf (auto-context type:key style)', () => {
    interface Ctx { type: string; key: string; text: string }
    const ctxId = (c: Ctx): string => `${c.type}:${c.key}`;
    const ctxShared: Ctx[] = [
      { type: 'category', key: 'bug', text: 'B' },
      { type: 'tag', key: 'urgent', text: 'U' },
    ];
    const delta: ArrayDelta<Ctx> = { hidden: ['tag:urgent'], overrides: { 'category:bug': { text: 'B2' } } };
    const out = resolveDeltaArray(ctxShared, delta, ctxId);
    expect(out).toEqual([{ type: 'category', key: 'bug', text: 'B2' }]);
  });
});

describe('computeArrayDelta', () => {
  it('returns an empty delta when the edited list equals shared', () => {
    expect(computeArrayDelta(shared, [...shared], idOf)).toEqual({});
  });

  it('captures a removed shared item as hidden', () => {
    const edited = shared.filter(i => i.id !== 'b');
    expect(computeArrayDelta(shared, edited, idOf)).toEqual({ hidden: ['b'] });
  });

  it('captures a new (non-shared) item as added', () => {
    const edited = [...shared, { id: 'x', name: 'Local X' }];
    expect(computeArrayDelta(shared, edited, idOf)).toEqual({ added: [{ id: 'x', name: 'Local X' }] });
  });

  it('captures a changed shared item as an override (full item)', () => {
    const edited = shared.map(i => i.id === 'a' ? { ...i, name: 'A!' } : i);
    expect(computeArrayDelta(shared, edited, idOf)).toEqual({ overrides: { a: { id: 'a', name: 'A!' } } });
  });

  it('round-trips with resolveDeltaArray (hide + add + override)', () => {
    const edited: Item[] = [
      { id: 'a', name: 'A2' },          // override
      // 'b' removed → hidden
      { id: 'c', name: 'Gamma' },        // unchanged
      { id: 'x', name: 'Local X' },      // added
    ];
    const delta = computeArrayDelta(shared, edited, idOf);
    expect(resolveDeltaArray(shared, delta, idOf)).toEqual(edited);
  });

  // HS-9212 — a force-hidden shared item kept in `edited` is marked hidden AND
  // keeps its override, so hide → un-hide doesn't lose the local customization.
  describe('forceHidden (HS-9212)', () => {
    it('marks a force-hidden id as hidden even though it is still in edited', () => {
      const delta = computeArrayDelta(shared, [...shared], idOf, ['b']);
      expect(delta.hidden).toEqual(['b']);
    });

    it('retains a force-hidden item\'s override (the customization survives hide)', () => {
      // 'a' was customized locally, then hidden — keep it in `edited` + force-hide.
      const edited = shared.map(i => i.id === 'a' ? { ...i, name: 'A-custom' } : i);
      const delta = computeArrayDelta(shared, edited, idOf, ['a']);
      expect(delta.hidden).toEqual(['a']);
      expect(delta.overrides).toEqual({ a: { id: 'a', name: 'A-custom' } });
    });

    it('merges force-hidden ids with naturally-removed ones (no dupes)', () => {
      // 'b' removed entirely; 'a' kept-but-force-hidden.
      const edited = shared.filter(i => i.id !== 'b');
      const delta = computeArrayDelta(shared, edited, idOf, ['a', 'b']);
      expect(new Set(delta.hidden)).toEqual(new Set(['a', 'b']));
      expect(delta.hidden?.length).toBe(2); // 'b' not duplicated
    });

    it('ignores force-hidden ids that are not shared items', () => {
      const delta = computeArrayDelta(shared, [...shared], idOf, ['nonexistent']);
      expect(delta.hidden).toBeUndefined();
    });
  });
});

describe('moveArrayItemToShared / moveArrayItemToLocal (HS-9209)', () => {
  describe('moveArrayItemToShared', () => {
    it('promotes a local-only addition into the shared array + drops it from added', () => {
      const delta: ArrayDelta<Item> = { added: [{ id: 'x', name: 'Local X' }, { id: 'y', name: 'Local Y' }] };
      const out = moveArrayItemToShared(shared, delta, 'y', idOf);
      expect(out.shared.map(i => i.id)).toEqual(['a', 'b', 'c', 'y']); // appended
      expect(out.delta.added?.map(i => i.id)).toEqual(['x']); // y removed
    });

    it('empties the delta (prunes `added`) when the last local item is promoted', () => {
      const delta: ArrayDelta<Item> = { added: [{ id: 'x', name: 'Local X' }] };
      const out = moveArrayItemToShared(shared, delta, 'x', idOf);
      expect(out.shared.map(i => i.id)).toEqual(['a', 'b', 'c', 'x']);
      expect(out.delta).toEqual({}); // pruned → caller clears the local override
    });

    it('is a no-op when the id is not a local addition (e.g. a shared id)', () => {
      const delta: ArrayDelta<Item> = { added: [{ id: 'x', name: 'X' }] };
      const out = moveArrayItemToShared(shared, delta, 'a', idOf);
      expect(out.shared.map(i => i.id)).toEqual(['a', 'b', 'c']); // unchanged
      expect(out.delta.added?.map(i => i.id)).toEqual(['x']);
    });
  });

  describe('moveArrayItemToLocal', () => {
    it('demotes a shared item into `added` + removes it from shared', () => {
      const out = moveArrayItemToLocal(shared, {}, 'b', idOf);
      expect(out.shared.map(i => i.id)).toEqual(['a', 'c']); // b removed
      expect(out.delta.added).toEqual([{ id: 'b', name: 'Beta' }]);
    });

    it('folds a local override into the demoted item + drops its override/hidden entries', () => {
      const delta: ArrayDelta<Item> = { overrides: { b: { name: 'Beta-custom' } }, hidden: ['b'] };
      const out = moveArrayItemToLocal(shared, delta, 'b', idOf);
      expect(out.shared.map(i => i.id)).toEqual(['a', 'c']);
      // The added item carries the local customization, not the bare shared value.
      expect(out.delta.added).toEqual([{ id: 'b', name: 'Beta-custom' }]);
      expect(out.delta.overrides).toBeUndefined();
      expect(out.delta.hidden).toBeUndefined();
    });

    it('preserves unrelated delta entries when demoting one shared item', () => {
      const delta: ArrayDelta<Item> = { overrides: { a: { name: 'A2' } }, hidden: ['c'], added: [{ id: 'z', name: 'Z' }] };
      const out = moveArrayItemToLocal(shared, delta, 'b', idOf);
      expect(out.delta.overrides).toEqual({ a: { name: 'A2' } });
      expect(out.delta.hidden).toEqual(['c']);
      expect(out.delta.added?.map(i => i.id)).toEqual(['z', 'b']); // b appended after existing adds
    });

    it('is a no-op when the id is not a shared item', () => {
      const delta: ArrayDelta<Item> = { added: [{ id: 'z', name: 'Z' }] };
      const out = moveArrayItemToLocal(shared, delta, 'z', idOf);
      expect(out.shared.map(i => i.id)).toEqual(['a', 'b', 'c']);
      expect(out.delta.added?.map(i => i.id)).toEqual(['z']);
    });

    it('round-trips: demote a shared item then promote it back restores the shared list', () => {
      const demoted = moveArrayItemToLocal(shared, {}, 'b', idOf);
      const restored = moveArrayItemToShared(demoted.shared, demoted.delta, 'b', idOf);
      // 'b' ends up appended (local layer can't reorder shared items — docs/95 §95.3).
      expect(new Set(restored.shared.map(i => i.id))).toEqual(new Set(['a', 'b', 'c']));
      expect(restored.delta).toEqual({});
    });
  });
});
