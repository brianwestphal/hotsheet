// @vitest-environment happy-dom
/**
 * §60 / HS-8235 — re-export sanity check. Confirms the four primitive
 * functions are wired through `kerfjs` and behave as documented.
 *
 * Behavioural coverage of `effect` / `computed` / `batch` lives upstream
 * in `kerfjs`'s own test suite; these tests pin only the surface contract
 * Hot Sheet relies on.
 */
import { describe, expect, it } from 'vitest';

import { batch, computed, defineStore, effect, resetAllStores, signal } from './reactive.js';

describe('reactive — primitive re-exports (HS-8235)', () => {
  it('signal exposes .value reads + writes', () => {
    const s = signal(0);
    expect(s.value).toBe(0);
    s.value = 5;
    expect(s.value).toBe(5);
  });

  it('computed re-evaluates when its dependency changes', () => {
    const a = signal(2);
    const b = signal(3);
    const sum = computed(() => a.value + b.value);
    expect(sum.value).toBe(5);
    a.value = 10;
    expect(sum.value).toBe(13);
  });

  it('effect runs synchronously on creation and on every dep change; disposer stops further runs', () => {
    const s = signal(0);
    const log: number[] = [];
    const dispose = effect(() => { log.push(s.value); });
    expect(log).toEqual([0]);
    s.value = 1;
    s.value = 2;
    expect(log).toEqual([0, 1, 2]);
    dispose();
    s.value = 3;
    expect(log).toEqual([0, 1, 2]);
  });

  it('batch coalesces multiple writes into one effect run', () => {
    const a = signal(1);
    const b = signal(2);
    const log: number[] = [];
    effect(() => { log.push(a.value + b.value); });
    expect(log).toEqual([3]);
    batch(() => {
      a.value = 10;
      b.value = 20;
    });
    expect(log).toEqual([3, 30]);
  });
});

describe('reactive — defineStore / resetAllStores re-exports (HS-8238)', () => {
  it('defineStore returns a Store with state, actions, and reset', () => {
    const counter = defineStore({
      initial: () => ({ count: 0 }),
      actions: (set, get) => ({
        inc: () => set({ count: get().count + 1 }),
        dec: () => set({ count: get().count - 1 }),
      }),
    });
    expect(counter.state.value).toEqual({ count: 0 });
    counter.actions.inc();
    expect(counter.state.value).toEqual({ count: 1 });
    counter.actions.inc();
    counter.actions.inc();
    expect(counter.state.value).toEqual({ count: 3 });
    counter.actions.dec();
    expect(counter.state.value).toEqual({ count: 2 });
    counter.reset();
    expect(counter.state.value).toEqual({ count: 0 });
  });

  it('store state.value is reactive — effects re-run on action calls', () => {
    const counter = defineStore({
      initial: () => ({ count: 0 }),
      actions: (set, get) => ({
        inc: () => set({ count: get().count + 1 }),
      }),
    });
    const log: number[] = [];
    const dispose = effect(() => { log.push(counter.state.value.count); });
    expect(log).toEqual([0]);
    counter.actions.inc();
    counter.actions.inc();
    expect(log).toEqual([0, 1, 2]);
    dispose();
  });

  it('resetAllStores resets every store registered via defineStore', () => {
    const a = defineStore({
      initial: () => ({ n: 1 }),
      actions: (set) => ({ set5: () => set({ n: 5 }) }),
    });
    const b = defineStore({
      initial: () => ({ s: 'init' }),
      actions: (set) => ({ setX: () => set({ s: 'x' }) }),
    });
    a.actions.set5();
    b.actions.setX();
    expect(a.state.value.n).toBe(5);
    expect(b.state.value.s).toBe('x');
    resetAllStores();
    expect(a.state.value.n).toBe(1);
    expect(b.state.value.s).toBe('init');
  });
});
