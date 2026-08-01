// @vitest-environment happy-dom
/**
 * §60 / HS-8235 — re-export sanity check. Confirms the four primitive
 * functions are wired through `kerfjs` and behave as documented.
 *
 * Behavioral coverage of `effect` / `computed` / `batch` lives upstream
 * in `kerfjs`'s own test suite; these tests pin only the surface contract
 * Hot Sheet relies on.
 */
import { describe, expect, it } from 'vitest';

import { batch, computed, defineStore, delegate, delegateCapture, effect, resetAllStores, signal } from './reactive.js';

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

describe('reactive — delegate / delegateCapture re-exports (HS-8613/HS-8614)', () => {
  it('delegate installs one root listener that dispatches via closest() and survives child rebuilds', () => {
    const root = document.createElement('div');
    root.innerHTML = '<button class="btn" data-id="1">a</button><button class="btn" data-id="2">b</button>';
    document.body.appendChild(root);
    const seen: string[] = [];
    const dispose = delegate<HTMLButtonElement>(root, 'click', '.btn', (_e, btn) => {
      seen.push(btn.dataset.id ?? '');
    });
    root.querySelector<HTMLButtonElement>('[data-id="1"]')!.click();
    // Rebuild the children — the single root listener must keep firing on the
    // fresh nodes (the whole point of delegation over per-element listeners).
    root.innerHTML = '<button class="btn" data-id="3">c</button>';
    root.querySelector<HTMLButtonElement>('[data-id="3"]')!.click();
    expect(seen).toEqual(['1', '3']);
    dispose();
    root.querySelector<HTMLButtonElement>('[data-id="3"]')!.click();
    expect(seen).toEqual(['1', '3']);
    root.remove();
  });

  it('delegate fires on a click inside a matched wrapper (closest walk-up), not just the wrapper itself', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="row" data-idx="7"><span class="inner">x</span></div>';
    document.body.appendChild(root);
    let idx = '';
    const dispose = delegate<HTMLElement>(root, 'click', '.row', (_e, row) => { idx = row.dataset.idx ?? ''; });
    root.querySelector<HTMLElement>('.inner')!.click();
    expect(idx).toBe('7');
    dispose();
    root.remove();
  });

  it('delegateCapture fires on the element itself', () => {
    const root = document.createElement('div');
    root.innerHTML = '<input class="field" />';
    document.body.appendChild(root);
    let fired = 0;
    const dispose = delegateCapture<HTMLInputElement>(root, 'focus', '.field', () => { fired += 1; });
    root.querySelector<HTMLInputElement>('.field')!.dispatchEvent(new FocusEvent('focus'));
    expect(fired).toBe(1);
    dispose();
    root.remove();
  });

  // HS-9449 — kerf 2.0 changed `delegateCapture` from strict target matching to
  // `delegate()`-style `closest()` walk-up, handing the handler the matched ANCESTOR
  // rather than the raw target. The test that used to live here asserted only that a
  // direct hit fires, which is true under both semantics — so it would have gone on
  // passing while its name ("strict, no walk-up") became false. These two pin the
  // actual behavior in both directions.
  it('delegateCapture walks up to the matched ancestor by default (kerf 2.0 semantics)', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="row" data-idx="4"><span class="inner">x</span></div>';
    document.body.appendChild(root);
    let idx = '';
    const dispose = delegateCapture<HTMLElement>(root, 'click', '.row', (_e, matched) => { idx = matched.dataset.idx ?? ''; });
    root.querySelector<HTMLElement>('.inner')!.click();
    expect(idx).toBe('4'); // the ancestor, not the clicked <span>
    dispose();
    root.remove();
  });

  it('delegateCapture with { match: "direct" } restores strict target matching', () => {
    const root = document.createElement('div');
    root.innerHTML = '<div class="row" data-idx="4"><span class="inner">x</span></div>';
    document.body.appendChild(root);
    let fired = 0;
    const dispose = delegateCapture<HTMLElement>(root, 'click', '.row', () => { fired += 1; }, { match: 'direct' });
    root.querySelector<HTMLElement>('.inner')!.click(); // descendant — must NOT fire
    expect(fired).toBe(0);
    root.querySelector<HTMLElement>('.row')!.click(); // the element itself — fires
    expect(fired).toBe(1);
    dispose();
    root.remove();
  });
});
