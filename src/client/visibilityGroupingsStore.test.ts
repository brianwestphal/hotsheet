// @vitest-environment happy-dom
/**
 * §61 Phase 3c (narrowed) / HS-8319 — unit tests for
 * `visibilityGroupingsStore`. The store lifts the bespoke `let globalState`
 * + `subscribers: Set<() => void>` pub/sub in `dashboardHiddenTerminals.tsx`
 * onto a kerf `defineStore`. These tests pin the store action contract +
 * the `subscribeToVisibilityGroupings` no-fire-on-subscribe semantics in
 * isolation; integration with the wide public API (`isTerminalHidden`,
 * `addGrouping`, etc.) is covered by `dashboardHiddenTerminals.test.ts`,
 * and the persistence hydrate path by `persistedHiddenTerminals.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_GROUPING_ID, initialGlobalState } from './visibilityGroupings.js';
import {
  _resetSubscribersForTesting,
  _visibilityGroupingsStoreForTesting,
  subscribeToVisibilityGroupings,
  visibilityGroupingsStore,
} from './visibilityGroupingsStore.js';

beforeEach(() => {
  _visibilityGroupingsStoreForTesting.reset();
  _resetSubscribersForTesting();
});

afterEach(() => {
  _visibilityGroupingsStoreForTesting.reset();
  _resetSubscribersForTesting();
});

describe('visibilityGroupingsStore — initial state', () => {
  it('starts with the Default grouping and active = Default', () => {
    const s = visibilityGroupingsStore.state.value;
    expect(s.groupings).toHaveLength(1);
    expect(s.groupings[0].id).toBe(DEFAULT_GROUPING_ID);
    expect(s.activeId).toBe(DEFAULT_GROUPING_ID);
  });

  it('reset() returns to initial after mutations', () => {
    visibilityGroupingsStore.actions.setState({
      ...initialGlobalState(),
      activeId: 'something-else',
    });
    _visibilityGroupingsStoreForTesting.reset();
    expect(visibilityGroupingsStore.state.value.activeId).toBe(DEFAULT_GROUPING_ID);
  });
});

describe('visibilityGroupingsStore — setState', () => {
  it('replaces the whole state when the reference changes', () => {
    const next = { ...initialGlobalState(), activeId: 'g-other' };
    visibilityGroupingsStore.actions.setState(next);
    expect(visibilityGroupingsStore.state.value).toBe(next);
  });

  it('short-circuits when the reference is identical (no effect() churn)', () => {
    const ref = visibilityGroupingsStore.state.value;
    let fires = 0;
    const unsub = subscribeToVisibilityGroupings(() => { fires++; });
    visibilityGroupingsStore.actions.setState(ref);
    expect(fires).toBe(0);
    unsub();
  });
});

describe('subscribeToVisibilityGroupings — no-fire-on-subscribe', () => {
  it('does NOT fire on subscribe', () => {
    let fires = 0;
    const unsub = subscribeToVisibilityGroupings(() => { fires++; });
    expect(fires).toBe(0);
    unsub();
  });

  it('fires on every actual state change', () => {
    let fires = 0;
    const unsub = subscribeToVisibilityGroupings(() => { fires++; });
    visibilityGroupingsStore.actions.setState({ ...initialGlobalState(), activeId: 'g-a' });
    expect(fires).toBe(1);
    visibilityGroupingsStore.actions.setState({ ...initialGlobalState(), activeId: 'g-b' });
    expect(fires).toBe(2);
    unsub();
  });

  it('stops firing after unsubscribe', () => {
    let fires = 0;
    const unsub = subscribeToVisibilityGroupings(() => { fires++; });
    unsub();
    visibilityGroupingsStore.actions.setState({ ...initialGlobalState(), activeId: 'g-a' });
    expect(fires).toBe(0);
  });

  it('multiple subscribers all fire on a single state change', () => {
    let a = 0;
    let b = 0;
    const unsubA = subscribeToVisibilityGroupings(() => { a++; });
    const unsubB = subscribeToVisibilityGroupings(() => { b++; });
    visibilityGroupingsStore.actions.setState({ ...initialGlobalState(), activeId: 'g-x' });
    expect(a).toBe(1);
    expect(b).toBe(1);
    unsubA();
    unsubB();
  });

  it('a throwing handler does NOT stop other handlers from firing', () => {
    let other = 0;
    const unsubBad = subscribeToVisibilityGroupings(() => { throw new Error('bad'); });
    const unsubOk = subscribeToVisibilityGroupings(() => { other++; });
    visibilityGroupingsStore.actions.setState({ ...initialGlobalState(), activeId: 'g-z' });
    expect(other).toBe(1);
    unsubBad();
    unsubOk();
  });
});

describe('_resetSubscribersForTesting — leak protection', () => {
  it('disposes every live subscriber so a forgotten unsub does not leak across tests', () => {
    let fires = 0;
    subscribeToVisibilityGroupings(() => { fires++; }); // intentionally not unsubbed
    _resetSubscribersForTesting();
    visibilityGroupingsStore.actions.setState({ ...initialGlobalState(), activeId: 'g-leak' });
    expect(fires).toBe(0);
  });
});
