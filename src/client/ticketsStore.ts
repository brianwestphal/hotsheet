/**
 * §61 Phase 2 prep / HS-8321 — `ticketsStore` factory + types in
 * isolation. Pure addition: nothing in this file is wired into
 * `ticketList.tsx`, `state.tsx::state.tickets`, or any other consumer
 * yet. The HS-8239 atomic flip is what removes the global `state.tickets`
 * and rewires every reader / mutator to go through this store.
 *
 * The split exists because HS-8239's spec is "single atomic PR — partial
 * migration where some consumers read the global and others read the
 * store is the worst possible interim." Landing the store + types +
 * tests in a separate prep ticket shrinks the atomic-flip surface to
 * the rewiring change alone, which is much more reviewable.
 *
 * Actions match the HS-8239 spec: `setTickets`, `setFilter`,
 * `patchFilter`, `select`, `applyServerUpdate`, `removeTicket`,
 * `optimisticUpdate`. The async `loadTickets(force?)` from HS-8239's
 * spec is intentionally NOT defined here — it owns the API fetch +
 * cache-check loop, lives outside the pure-state store, and lands in
 * HS-8239 alongside the global removal so its callsite becomes the
 * single replacement for today's `state.tickets = await api(...)`
 * pattern.
 *
 * The `filteredTickets` computed signal is intentionally minimal — it
 * only filters by `filter.search` against title / details /
 * ticket_number. The full filter logic (view selection, include
 * backlog / archive flags, sort, group-by-status) lives in
 * `ticketList.tsx::loadTickets` today and gets folded in during HS-8239.
 * The intent here is "establish the computed-derived shape;
 * leave the body extension to the atomic-flip ticket."
 */
import type { ReadonlySignal } from './reactive.js';
import { computed, defineStore } from './reactive.js';
import type { Ticket } from './state.js';

/** Filter state slice used by the `filteredTickets` derived signal +
 *  every consumer that reads "what tickets are visible right now". The
 *  shape mirrors the four toolbar-level globals in `state.tsx` that
 *  affect the visible ticket list (view, search, include flags). HS-8239
 *  may extend with sort / group-by knobs if the ticket-list rebuild
 *  needs them on the store rather than computed locally; for now they
 *  stay as render-time concerns. */
export interface FilterState {
  /** Active view id. `'all'` plus user-defined view ids from
   *  `state.customViews`. */
  view: string;
  /** Free-text search query. Empty string disables search. */
  search: string;
  /** HS-7756 — mix backlog rows into the search result set. */
  includeBacklogInSearch: boolean;
  /** HS-7756 — mix archive rows into the search result set. */
  includeArchiveInSearch: boolean;
}

/** Default filter — matches the boot-time defaults in
 *  `state.tsx::state` for the four filter fields. */
export const DEFAULT_FILTER: FilterState = {
  view: 'all',
  search: '',
  includeBacklogInSearch: false,
  includeArchiveInSearch: false,
};

/** Internal state shape. Marked `readonly` on collections so the kerf
 *  `set()` contract (always replace, never mutate) is enforced at the
 *  type level — accidentally pushing into `state.value.tickets` is a
 *  TS error. */
export interface TicketsStoreState {
  tickets: readonly Ticket[];
  filter: FilterState;
  selectedId: number | null;
}

export const ticketsStore = defineStore({
  initial: (): TicketsStoreState => ({
    tickets: [],
    filter: { ...DEFAULT_FILTER },
    selectedId: null,
  }),
  actions: (set, get) => ({
    /** Replace the entire ticket list. Used by the (future) async
     *  `loadTickets(force?)` helper in HS-8239 after the API fetch
     *  resolves. */
    setTickets: (tickets: readonly Ticket[]) => {
      set({ ...get(), tickets });
    },
    /** Replace the filter wholesale. */
    setFilter: (filter: FilterState) => {
      set({ ...get(), filter });
    },
    /** Merge a partial filter update — the common path for individual
     *  toolbar interactions (typing in the search box, toggling an
     *  include flag, switching views). Equivalent to
     *  `setFilter({ ...current, ...patch })` but spelt out so the
     *  callsite reads naturally. */
    patchFilter: (patch: Partial<FilterState>) => {
      const current = get();
      set({ ...current, filter: { ...current.filter, ...patch } });
    },
    /** Set / clear the selected ticket id. `null` clears selection. */
    select: (id: number | null) => {
      set({ ...get(), selectedId: id });
    },
    /** Apply a server-pushed update for a single ticket. Replaces the
     *  matching entry by id; no-ops if the id isn't in the current
     *  list (e.g., the ticket was removed mid-fetch). */
    applyServerUpdate: (updated: Ticket) => {
      const current = get();
      // Two-pass to keep the no-op short-circuit free of a `let
      // changed` flag — TS strict-boolean narrowing tags the flag as
      // `always false` inside the closure context.
      if (!current.tickets.some(t => t.id === updated.id)) return;
      const next = current.tickets.map(t => t.id === updated.id ? updated : t);
      set({ ...current, tickets: next });
    },
    /** Drop a ticket from the list by id. No-ops if the id isn't
     *  present. Matches the existing imperative `removeTicket(id)`
     *  contract in `ticketList.tsx`. Also clears `selectedId` if it
     *  was pointing at the dropped ticket. */
    removeTicket: (id: number) => {
      const current = get();
      const nextTickets = current.tickets.filter(t => t.id !== id);
      const nextSelected = current.selectedId === id ? null : current.selectedId;
      const ticketsChanged = nextTickets.length !== current.tickets.length;
      const selectedChanged = nextSelected !== current.selectedId;
      if (!ticketsChanged && !selectedChanged) return;
      set({ ...current, tickets: nextTickets, selectedId: nextSelected });
    },
    /** Optimistically merge a patch into the ticket without an
     *  intervening server round-trip. Used for instant-UI flows like
     *  status flip, star toggle, category change — the server reply
     *  later replaces the ticket via `applyServerUpdate`. */
    optimisticUpdate: (id: number, patch: Partial<Ticket>) => {
      const current = get();
      if (!current.tickets.some(t => t.id === id)) return;
      const next = current.tickets.map(t => t.id === id ? { ...t, ...patch } : t);
      set({ ...current, tickets: next });
    },
  }),
});

/**
 * Derived signal — tickets matching the current `filter`. Recomputes
 * on every `tickets` or `filter` write thanks to kerf's `computed()`
 * tracking. **HS-8334 (2026-05-11) — extended to be the single source
 * of filter truth.** Pre-HS-8334 this only narrowed by `filter.search`;
 * post-fix it also narrows by `filter.view` (active sub-views
 * `up-next` / `open` / `completed` / `non-verified` / `verified` /
 * `category:*` / `priority:*`; cross-scope `trash` / `backlog` /
 * `archive`; custom-view passthrough) and by the
 * `includeBacklogInSearch` / `includeArchiveInSearch` toggles. The
 * client server-fetch now sends `?status=active` (or
 * `?status=trash`/`backlog`/`archive`) for the coarse scope only —
 * the per-view narrowing happens here. See `applyViewFilter` for
 * the per-view branches.
 */
export const filteredTickets: ReadonlySignal<readonly Ticket[]> = computed(() => {
  const { tickets, filter } = ticketsStore.state.value;
  const viewFiltered = applyViewFilter(
    tickets,
    filter.view,
    filter.includeBacklogInSearch,
    filter.includeArchiveInSearch,
  );
  if (filter.search === '') return viewFiltered;
  const lc = filter.search.toLowerCase();
  return viewFiltered.filter(t => ticketMatchesSearch(t, lc));
});

/**
 * HS-8331 — derived signal that simply mirrors `state.value.tickets`
 * unfiltered. Exists as the raw `Signal<readonly Ticket[]>` handle
 * for consumers that want the full store contents without view
 * narrowing. The default-list-view bindList itself switched to
 * `filteredTickets` in HS-8334 (since that's the canonical "what's
 * visible" signal).
 */
export const ticketsSignal: ReadonlySignal<readonly Ticket[]> = computed(() =>
  ticketsStore.state.value.tickets,
);

/**
 * HS-8332 (2026-05-11) — per-status partitioning of `filteredTickets`
 * (the narrowed visible set, not raw `ticketsSignal`). Map keyed by
 * the literal `ticket.status` value (e.g., `'not_started'`,
 * `'started'`, `'completed'`, `'verified'`, `'deleted'`,
 * `'backlog'`, `'archive'`, or any future status string). The
 * derived signal returns a fresh `Record` on each recompute — the
 * per-status arrays are also fresh.
 *
 * Consumers: the §61 Phase 2 column-view rewrite mounts one
 * `bindList` per visible column subscribed to a per-column derived
 * signal that pulls from this partitioner (with column-specific
 * fallback logic for the first column's unrecognised-statuses sink
 * + the `hide_verified_column` setting that merges verified into
 * completed). See `columnView.tsx` for the consumer pattern.
 *
 * Derived from `filteredTickets`, not `ticketsSignal` — so view
 * narrowing (HS-8334) + search + include flags all apply BEFORE the
 * partitioning. The column view sees only the tickets the user
 * has currently filtered to (matches the pre-HS-8332 wholesale-
 * rebuild behaviour where the rebuild loop iterated `state.tickets`
 * which post-HS-8334 IS already the filtered set in the store).
 */
export const ticketsByStatusSignal: ReadonlySignal<Partial<Record<string, readonly Ticket[]>>> = computed(() => {
  const tickets = filteredTickets.value;
  const grouped: Partial<Record<string, Ticket[]>> = {};
  for (const t of tickets) {
    if (grouped[t.status] === undefined) {
      grouped[t.status] = [];
    }
    grouped[t.status]!.push(t);
  }
  return grouped;
});

function ticketMatchesSearch(t: Ticket, lcSearch: string): boolean {
  return t.title.toLowerCase().includes(lcSearch)
    || t.details.toLowerCase().includes(lcSearch)
    || t.ticket_number.toLowerCase().includes(lcSearch);
}

/**
 * HS-8334 — per-view narrowing helper. Mirrors the pre-fix
 * `loadTickets` URL-construction switch (which built the
 * `?status=...` / `?up_next=...` / `?category=...` / `?priority=...`
 * query params) plus the pre-fix `loadPreviewTickets` client-side
 * filter pass. Now a single function, used by both fetch paths.
 *
 * Three scope tiers:
 *
 * 1. **Cross-scope views** (`trash` / `backlog` / `archive`) —
 *    narrow to that exact status. For server-fetched data the server
 *    already returns only that status (we send `?status=trash` etc.),
 *    so this branch is an identity pass on live data; for the backup
 *    preview snapshot (which contains every status), it does the
 *    actual narrowing.
 *
 * 2. **Custom views** (`custom:*`) — passthrough. The server's
 *    `/tickets/query` endpoint already evaluates the view's
 *    `conditions` / `logic` and returns the exact matched set;
 *    re-applying client-side narrowing would either double-filter
 *    (correct but wasteful) or, worse, conflict if the custom
 *    conditions don't fit one of the known sub-view shapes.
 *
 * 3. **Active scope** (`all` / `up-next` / `open` / `completed` /
 *    `non-verified` / `verified` / `category:*` / `priority:*`) —
 *    first exclude `deleted` / `backlog` / `archive` (the include
 *    flags can put backlog or archive back), then apply the
 *    sub-view's specific narrowing.
 */
function applyViewFilter(
  tickets: readonly Ticket[],
  view: string,
  includeBacklog: boolean,
  includeArchive: boolean,
): readonly Ticket[] {
  if (view.startsWith('custom:')) return tickets;
  if (view === 'trash') return tickets.filter(t => t.status === 'deleted');
  if (view === 'backlog') return tickets.filter(t => t.status === 'backlog');
  if (view === 'archive') return tickets.filter(t => t.status === 'archive');

  // Active scope — exclude deleted; backlog/archive in only when the
  // include flags say so. (Matches the server-side `status=active`
  // semantics that exclude deleted/backlog/archive by default + the
  // OR-in of backlog/archive when `include_backlog=true` /
  // `include_archive=true` query params are set.)
  const activeScope = tickets.filter(t => {
    if (t.status === 'deleted') return false;
    if (t.status === 'backlog') return includeBacklog;
    if (t.status === 'archive') return includeArchive;
    return true;
  });

  if (view === 'up-next') return activeScope.filter(t => t.up_next);
  if (view === 'open') return activeScope.filter(t => t.status === 'not_started' || t.status === 'started');
  if (view === 'completed') return activeScope.filter(t => t.status === 'completed');
  if (view === 'non-verified') {
    return activeScope.filter(t => t.status === 'not_started' || t.status === 'started' || t.status === 'completed');
  }
  if (view === 'verified') return activeScope.filter(t => t.status === 'verified');
  if (view.startsWith('category:')) {
    const cat = view.split(':')[1];
    return activeScope.filter(t => t.category === cat);
  }
  if (view.startsWith('priority:')) {
    const pri = view.split(':')[1];
    return activeScope.filter(t => t.priority === pri);
  }
  // 'all' (or any unrecognised view): full active scope.
  return activeScope;
}

/** **TEST ONLY.** Direct handle on the underlying store for unit tests
 *  to call `.reset()` between cases. Production code goes through the
 *  named exports above. */
export const _ticketsStoreForTesting = ticketsStore;
