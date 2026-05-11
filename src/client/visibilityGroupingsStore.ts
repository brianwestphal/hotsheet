/**
 * §61 Phase 3c (narrowed) / HS-8319 — `visibilityGroupingsStore`. Lifts
 * the bespoke pub/sub in `dashboardHiddenTerminals.tsx` (a raw
 * `let globalState: GlobalVisibilityState` + a `const subscribers` Set of
 * `() =\> void` callbacks) onto kerf's `defineStore`. The "lift bespoke pub/sub to kerf" pattern
 * §61 was designed for — `setGlobalState(next)` always replaced the
 * whole reference (no in-place mutation), `subscribers.add(handler)`
 * was a hand-rolled reactivity protocol, and the four consumer files
 * (`visibilityGroupingSelect.tsx` / `hiddenTerminalsResetUI.tsx` /
 * `drawerTerminalGrid.tsx` / `terminalDashboard.tsx`) all wire identical
 * `subscribeToHiddenChanges(() => repaint())` calls.
 *
 * Per the HS-8319 FEEDBACK NEEDED design call: the other four candidates
 * in the original ticket (`instances` Map, `drawerInstancesSignal`,
 * drawer-grid layout state, dashboard zoom level) all turned out to be
 * either lifecycle (not reactive data) or already signal-driven; this
 * store is the one clean §61 win in that group.
 *
 * **Does NOT reset on project switch** — the groupings list + active
 * grouping id are deliberately cross-project (HS-8290 collapsed the
 * pre-existing per-project visibility state into one global source of
 * truth). Same opt-out constraint as `projectsStore` (HS-8317) and
 * `channelStore` (HS-8320).
 *
 * **Public API stays in `dashboardHiddenTerminals.tsx`.** That file's
 * exports (`isTerminalHidden`, `setTerminalHidden`, `addGrouping`, etc.)
 * are byte-identical for callers — they now delegate to this store
 * instead of mutating a local `let`. `subscribeToHiddenChanges(handler)`
 * keeps its no-fire-on-subscribe semantics via a skip-first guard
 * inside an `effect()`.
 */
import { defineStore, effect } from './reactive.js';
import { type GlobalVisibilityState, initialGlobalState } from './visibilityGroupings.js';

export const visibilityGroupingsStore = defineStore({
  initial: (): GlobalVisibilityState => initialGlobalState(),
  actions: (set, get) => ({
    /** Replace the whole state. The bespoke pre-fix `setGlobalState`
     *  short-circuited when the reference didn't change; same guard
     *  here so a no-op call doesn't churn `effect()` subscribers. */
    setState: (next: GlobalVisibilityState) => {
      if (get() === next) return;
      set(next);
    },
  }),
});

/** Set of every live `subscribeToVisibilityGroupings` disposer. Lets
 *  `_resetSubscribersForTesting` tear down every registered subscriber so
 *  a test that forgets to unsub doesn't leak its handler into the next
 *  test (the pre-HS-8319 `subscribers.clear()` did the same). */
const liveSubscriberDisposers = new Set<() => void>();

/** Subscribe to any state change. Returns an unsubscribe function.
 *  No-fire-on-subscribe — matches the pre-HS-8319 bespoke pub/sub
 *  semantics (handler fires only after a state mutation). */
export function subscribeToVisibilityGroupings(handler: () => void): () => void {
  let primed = false;
  const dispose = effect(() => {
    // Track the dep so future state changes re-run this effect.
    visibilityGroupingsStore.state.value; // eslint-disable-line @typescript-eslint/no-unused-expressions
    if (!primed) { primed = true; return; }
    try { handler(); } catch { /* swallow — subscriber callbacks are advisory */ }
  });
  const wrapped = (): void => {
    liveSubscriberDisposers.delete(wrapped);
    dispose();
  };
  liveSubscriberDisposers.add(wrapped);
  return wrapped;
}

/** **HS-8319 — TEST ONLY.** Direct handle on the underlying store for
 *  unit tests to call `.reset()` between cases. Production code goes
 *  through the named exports in `dashboardHiddenTerminals.tsx`. */
export const _visibilityGroupingsStoreForTesting = visibilityGroupingsStore;

/** **HS-8319 — TEST ONLY.** Dispose every live
 *  `subscribeToVisibilityGroupings` subscription. Matches the
 *  pre-HS-8319 `subscribers.clear()` behaviour so a test that forgot
 *  to unsub doesn't leak its handler into the next test. */
export function _resetSubscribersForTesting(): void {
  for (const dispose of [...liveSubscriberDisposers]) dispose();
  liveSubscriberDisposers.clear();
}
