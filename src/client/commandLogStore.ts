/**
 * §61 Phase 3b / HS-8318 — `commandLogStore` for the Commands Log drawer
 * tab. Pairs with the `commandLog.tsx::renderEntries` → `bindList`
 * migration so the log entries land on per-entry signals (each row updates
 * in place via the bindList view-layer, with no DOM thrash on the
 * surrounding rows).
 *
 * Per the FEEDBACK NEEDED design call on HS-8318: keyed-merge entries
 * (option a), fused filter `{ types, search }` (option a), selection /
 * expanded / panelOpen / lastSeenId / runningShellIds / cancelingShellIds
 * / pollTimer stay imperative (option b — scoped follow-ups if needed).
 *
 * ### Why keyed-merge instead of wholesale-replace
 *
 * The HS-8311 deferral note's whole point was per-entry signals so
 * `bindList` rows can `effect()` against their own content. That requires
 * the per-entry signal references to SURVIVE across polls — a wholesale
 * `entries.replace(serverList)` would produce a fresh wrapper Map every
 * tick, defeating the per-row reactivity. Instead, `setEntries`
 * reconciles:
 *
 *   - **Surviving id** (existing in both old and new server response):
 *     the per-entry signal stays; its value is updated ONLY if the
 *     annotated shape (`detail` / `summary` / `isRunningShell`) actually
 *     differs structurally. This keeps poll ticks cheap (no spurious
 *     effect re-fires on no-op polls).
 *   - **New id**: create a fresh `entry` signal; add to the map; append
 *     to the ordering.
 *   - **Removed id** (in old but not new — aged off the server-side
 *     rolling 100 buffer): dispose the signal + drop from the map.
 *
 * ### Does NOT reset on project switch
 *
 * Command log is project-scoped via the API (`GET /command-log` returns
 * the active project's entries), but the data is server-owned; the
 * store is a local mirror that's refreshed wholesale on every project
 * switch via `loadEntries`. No `resetAllStores()` participation.
 */
import type { ReadonlySignal, Signal } from './reactive.js';
import { computed, defineStore, signal } from './reactive.js';

export interface CommandLogEntry {
  id: number;
  event_type: string;
  direction: string;
  summary: string;
  detail: string;
  created_at: string;
}

/** Server-provided entry + the derived `isRunningShell` flag baked in at
 *  reconcile time. The flag drives the row's running-vs-done branching in
 *  `commandLog.tsx::renderLogEntry`. */
export interface AnnotatedEntry extends CommandLogEntry {
  isRunningShell: boolean;
}

export interface FilterState {
  /** Selected event types (subset of `ALL_FILTER_TYPES`). */
  types: ReadonlySet<string>;
  /** Free-text search query (server passes through as `?search=`). */
  search: string;
}

export const ALL_FILTER_TYPE_VALUES = ['trigger', 'done', 'permission_request', 'shell_command'] as const;

/** Default filter: every type selected, no search query. */
function initialFilter(): FilterState {
  return { types: new Set(ALL_FILTER_TYPE_VALUES), search: '' };
}

interface CommandLogStoreState {
  /** Ordered list of entry ids — drives `bindList` keyed-reconcile.
   *  Per-entry data lives in `perEntrySignals` (module-private below). */
  entryIds: readonly number[];
  filter: FilterState;
}

/** Per-entry reactive bundle. Lives outside the store's `state` object so
 *  `setEntries` can update one entry's signal without churning the
 *  outer state reference (which would re-fire every consumer of the
 *  store's top-level state). */
interface EntrySignals {
  entry: Signal<AnnotatedEntry>;
}

const perEntrySignals = new Map<number, EntrySignals>();

/** Structural equality on the annotated entry — used by `setEntries` to
 *  decide whether the per-entry signal should fire. Pre-fix every poll
 *  would have churned the signal even on no-op polls (server returns
 *  fresh object refs); structural compare keeps cheap polls cheap. */
function annotatedEqual(a: AnnotatedEntry, b: AnnotatedEntry): boolean {
  return a.summary === b.summary
    && a.detail === b.detail
    && a.isRunningShell === b.isRunningShell
    && a.event_type === b.event_type
    && a.direction === b.direction
    && a.created_at === b.created_at;
}

export const commandLogStore = defineStore({
  initial: (): CommandLogStoreState => ({
    entryIds: [],
    filter: initialFilter(),
  }),
  actions: (set, get) => ({
    /** Keyed-merge against the latest server snapshot. `serverEntries`
     *  is the response from `GET /command-log`; `runningIds` is the
     *  `ids` field from `GET /shell/running` (used to annotate
     *  `isRunningShell`). */
    setEntries: (
      serverEntries: readonly CommandLogEntry[],
      runningIds: readonly number[],
    ) => {
      const runSet = new Set(runningIds);
      const incomingIds = new Set(serverEntries.map(e => e.id));

      // Drop signals for entries no longer in the server response.
      for (const id of [...perEntrySignals.keys()]) {
        if (!incomingIds.has(id)) perEntrySignals.delete(id);
      }

      // Update or create per-entry signals.
      for (const e of serverEntries) {
        const annotated: AnnotatedEntry = {
          ...e,
          isRunningShell: e.event_type === 'shell_command' && runSet.has(e.id),
        };
        const existing = perEntrySignals.get(e.id);
        if (existing !== undefined) {
          // Structural compare — only fire the signal when the annotated
          // shape actually changed. The vast majority of poll ticks see
          // no change for any given entry; firing here would re-run
          // every row's render effect for nothing.
          if (!annotatedEqual(existing.entry.value, annotated)) {
            existing.entry.value = annotated;
          }
        } else {
          perEntrySignals.set(e.id, {
            entry: signal(annotated),
          });
        }
      }

      // Update the entry-id ordering. Only set if it actually changed
      // (structural compare on length + per-index id) so bindList's
      // top-level effect doesn't re-fire on no-op polls.
      const newIds = serverEntries.map(e => e.id);
      const oldIds = get().entryIds;
      let changed = newIds.length !== oldIds.length;
      if (!changed) {
        for (let i = 0; i < newIds.length; i++) {
          if (newIds[i] !== oldIds[i]) { changed = true; break; }
        }
      }
      if (changed) set({ ...get(), entryIds: newIds });
    },

    setFilterTypes: (types: ReadonlySet<string>) => {
      set({ ...get(), filter: { ...get().filter, types } });
    },
    setFilterSearch: (search: string) => {
      const cur = get();
      if (cur.filter.search === search) return;
      set({ ...cur, filter: { ...cur.filter, search } });
    },

    /** Tear down every entry signal + reset the entry ordering. Used by
     *  tests + the not-currently-exposed user-facing "Clear log" hook. */
    clear: () => {
      perEntrySignals.clear();
      set({ ...get(), entryIds: [] });
    },
  }),
});

/** Read-only handle on the per-entry signals for the consuming bindList
 *  render function. Returns `undefined` for ids the store doesn't know
 *  about (race against a GC pass). */
export function getEntrySignals(id: number): EntrySignals | undefined {
  return perEntrySignals.get(id);
}

/** Derived signal: the ordered list of annotated entries. Drives
 *  `bindList` keyed-reconcile in `commandLog.tsx`.
 *
 *  Reading per-entry signal values inside this computed makes it
 *  re-fire when ANY entry changes. The array reference returned is
 *  fresh each tick, so `bindList`'s top-level effect re-runs — but
 *  surviving rows (same id key) keep their DOM identity; only the
 *  per-row effects react to per-entry data changes. */
export const orderedEntriesSignal: ReadonlySignal<readonly AnnotatedEntry[]> = computed(() => {
  const ids = commandLogStore.state.value.entryIds;
  const entries: AnnotatedEntry[] = [];
  for (const id of ids) {
    const sigs = perEntrySignals.get(id);
    if (sigs !== undefined) entries.push(sigs.entry.value);
  }
  return entries;
});

/** Derived signal: the entry list with the active type-filter applied.
 *  Search is handled server-side via the `?search=` query param on the
 *  `GET /command-log` request, so this filter only applies the
 *  client-side type-filter narrowing. */
export const filteredEntriesSignal: ReadonlySignal<readonly AnnotatedEntry[]> = computed(() => {
  const types = commandLogStore.state.value.filter.types;
  const all = orderedEntriesSignal.value;
  if (types.size === ALL_FILTER_TYPE_VALUES.length) return all;
  return all.filter(e => types.has(e.event_type));
});

/** **HS-8318 — TEST ONLY.** Direct handle on the underlying store for
 *  unit tests to call `.reset()` between cases. Production code goes
 *  through the named actions above. */
export const _commandLogStoreForTesting = commandLogStore;

/** **HS-8318 — TEST ONLY.** Clear the per-entry signal map. The store's
 *  `.reset()` puts state back to `initial()` but doesn't dispose the
 *  per-entry signal Map (which lives outside store state). Tests that
 *  need a fully-clean slate call this too. */
export function _clearPerEntrySignalsForTesting(): void {
  perEntrySignals.clear();
}
