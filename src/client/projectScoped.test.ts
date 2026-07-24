// @vitest-environment happy-dom
// HS-9416 (docs/126) — the `projectScoped` primitive itself. The generic
// A→B→A harness over every *registered* cell lives in
// `projectScopedIsolation.test.ts`; this file pins the primitive's contract.
import { beforeEach, describe, expect, it } from 'vitest';

import { evictProjectScope, projectScoped } from './projectScoped.js';
import { projectsStore } from './projectsStore.js';
import type { ProjectInfo } from './state.js';

const project = (secret: string): ProjectInfo =>
  ({ secret, name: `p-${secret}`, dataDir: `/tmp/${secret}` });

const activate = (secret: string | null) =>
  projectsStore.actions.setActive(secret === null ? null : project(secret));

beforeEach(() => { activate(null); });

describe('projectScoped — isolation', () => {
  it('keeps each project\'s value separate', () => {
    const cell = projectScoped(() => 0, 'counter');
    activate('A'); cell.set(1);
    activate('B'); cell.set(2);
    activate('A'); expect(cell.get()).toBe(1);
    activate('B'); expect(cell.get()).toBe(2);
  });

  // The core regression: this is the shape of all nine docs/125 bugs.
  it('never returns another project\'s value', () => {
    const cell = projectScoped<string | null>(() => null, 'label');
    activate('A'); cell.set('project-A-data');
    activate('B'); expect(cell.get()).toBeNull();
  });

  // Leg 3 of the A→B→A walk — what distinguishes correct scoping from a
  // reset-on-switch, which would throw A's value away (see HS-9412).
  it('still has A\'s value after a round trip', () => {
    const cell = projectScoped(() => 0, 'cursor');
    activate('A'); cell.set(500);
    activate('B'); cell.get();
    activate('A'); expect(cell.get()).toBe(500);
  });
});

describe('projectScoped — initial values', () => {
  it('builds the initial lazily, per project', () => {
    let built = 0;
    const cell = projectScoped(() => { built++; return { n: built }; }, 'obj');
    expect(built).toBe(0); // not built at declaration time
    activate('A'); cell.get();
    activate('B'); cell.get();
    expect(built).toBe(2);
  });

  it('gives each project its OWN instance, not a shared one', () => {
    const cell = projectScoped(() => new Map<string, number>(), 'map');
    activate('A'); cell.get().set('x', 1);
    activate('B');
    expect(cell.get().size).toBe(0); // B must not see A's Map
    activate('A');
    expect(cell.get().get('x')).toBe(1);
  });

  it('returns a stable instance within one project', () => {
    const cell = projectScoped(() => new Map<string, number>(), 'map');
    activate('A');
    expect(cell.get()).toBe(cell.get());
  });

  // Boxed storage: a cell whose T includes `undefined` must distinguish
  // "written as undefined" from "never written".
  it('treats an explicit undefined as a written value', () => {
    let built = 0;
    const cell = projectScoped<number | undefined>(() => { built++; return 7; }, 'maybe');
    activate('A');
    cell.set(undefined);
    expect(cell.get()).toBeUndefined();
    expect(built).toBe(0); // the initial was never needed
  });
});

describe('projectScoped — no active project', () => {
  it('returns the initial instead of throwing', () => {
    const cell = projectScoped(() => 'fallback', 'boot');
    expect(cell.get()).toBe('fallback');
  });

  it('retains a value written before any project is active', () => {
    const cell = projectScoped(() => 'fallback', 'boot');
    cell.set('written-at-boot');
    expect(cell.get()).toBe('written-at-boot');
  });

  // The no-project scope must be its own bucket — a boot-time write must not
  // become project A's value the moment A is selected.
  it('does not leak the boot value into a real project', () => {
    const cell = projectScoped(() => 'fallback', 'boot');
    cell.set('written-at-boot');
    activate('A');
    expect(cell.get()).toBe('fallback');
  });
});

describe('projectScoped — clear + eviction', () => {
  it('clear() drops only the active project\'s value', () => {
    const cell = projectScoped(() => 0, 'c');
    activate('A'); cell.set(1);
    activate('B'); cell.set(2);
    activate('A'); cell.clear();
    expect(cell.get()).toBe(0);
    activate('B'); expect(cell.get()).toBe(2);
  });

  it('evictProjectScope drops that secret across EVERY cell', () => {
    const one = projectScoped(() => 'i1', 'one');
    const two = projectScoped(() => 'i2', 'two');
    activate('A'); one.set('a1'); two.set('a2');
    activate('B'); one.set('b1'); two.set('b2');

    evictProjectScope('A');

    activate('A');
    expect(one.get()).toBe('i1');
    expect(two.get()).toBe('i2');
    activate('B'); // untouched
    expect(one.get()).toBe('b1');
    expect(two.get()).toBe('b2');
  });

  it('evicting an unknown secret is a no-op', () => {
    const cell = projectScoped(() => 0, 'c');
    activate('A'); cell.set(9);
    evictProjectScope('never-seen');
    activate('A'); expect(cell.get()).toBe(9);
  });
});
