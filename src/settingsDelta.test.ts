import { describe, expect, it } from 'vitest';

import { type ArrayDelta, isArrayDelta, resolveDeltaArray } from './settingsDelta.js';

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
