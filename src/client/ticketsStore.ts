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
import type { ReadonlySignal, Signal } from './reactive.js';
import { computed, defineStore, signal } from './reactive.js';
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

/**
 * HS-8335 (2026-05-11) — per-ticket reactive bundle. Lives outside
 * the store's `state` object so `setTickets` / `applyServerUpdate` /
 * `optimisticUpdate` can update one ticket's signal without churning
 * the outer state reference (which would re-fire every consumer of
 * the store's top-level state + every list-level computed like
 * `filteredTickets` / `ticketsByStatusSignal`).
 *
 * Modeled on HS-8318's `commandLogStore` per-entry-signals pattern.
 * Each ticket gets a single `Signal<Ticket>` slot; per-row effects
 * inside `createTicketRow` / `createColumnCard` subscribe to it and
 * update the relevant DOM slot (category badge, priority icon, status
 * button, star, completed/up-next/cut-pending classes, unread dot,
 * title input). Status changes that move a ticket between columns
 * are handled by the bindList key-reconcile (different per-column
 * signal → tear down + create), so the per-ticket signal only drives
 * SAME-row reactivity.
 */
interface TicketSignals {
  ticket: Signal<Ticket>;
}

const perTicketSignals = new Map<number, TicketSignals>();

/** Structural equality on the per-row reactive fields. Fields not
 *  visible to the row's per-row effects (e.g., `details`, `notes`
 *  arrays, `created_at`) are excluded — they don't drive any DOM
 *  update so firing the signal for them would be wasted work. */
function ticketEqualForRender(a: Ticket, b: Ticket): boolean {
  return a.status === b.status
    && a.category === b.category
    && a.priority === b.priority
    && a.up_next === b.up_next
    && a.title === b.title
    && a.ticket_number === b.ticket_number
    && a.tags === b.tags
    && a.last_read_at === b.last_read_at
    && a.updated_at === b.updated_at
    && a.notes === b.notes;
}

/** Reconcile the per-ticket signal Map against a new ticket list.
 *  Surviving ids keep their signals (value updated only if data
 *  changed); new ids get fresh signals; removed ids drop. */
function reconcilePerTicketSignals(newTickets: readonly Ticket[]): void {
  const incoming = new Set(newTickets.map(t => t.id));
  for (const id of [...perTicketSignals.keys()]) {
    if (!incoming.has(id)) perTicketSignals.delete(id);
  }
  for (const t of newTickets) {
    const existing = perTicketSignals.get(t.id);
    if (existing !== undefined) {
      if (!ticketEqualForRender(existing.ticket.value, t)) {
        existing.ticket.value = t;
      }
    } else {
      perTicketSignals.set(t.id, { ticket: signal(t) });
    }
  }
}

export const ticketsStore = defineStore({
  initial: (): TicketsStoreState => ({
    tickets: [],
    filter: { ...DEFAULT_FILTER },
    selectedId: null,
  }),
  actions: (set, get) => ({
    /** Replace the entire ticket list. Used by the async
     *  `loadTickets(force?)` helper in `ticketList.tsx` after the API
     *  fetch resolves. HS-8335: also reconciles the per-ticket signal
     *  Map (keyed-merge, structural-compare update). */
    setTickets: (tickets: readonly Ticket[]) => {
      reconcilePerTicketSignals(tickets);
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
     *  list (e.g., the ticket was removed mid-fetch). HS-8335: also
     *  fires the per-ticket signal so per-row effects update in
     *  place. */
    applyServerUpdate: (updated: Ticket) => {
      const current = get();
      // Two-pass to keep the no-op short-circuit free of a `let
      // changed` flag — TS strict-boolean narrowing tags the flag as
      // `always false` inside the closure context.
      if (!current.tickets.some(t => t.id === updated.id)) return;
      const next = current.tickets.map(t => t.id === updated.id ? updated : t);
      const sigs = perTicketSignals.get(updated.id);
      if (sigs !== undefined && !ticketEqualForRender(sigs.ticket.value, updated)) {
        sigs.ticket.value = updated;
      }
      set({ ...current, tickets: next });
    },
    /** Drop a ticket from the list by id. No-ops if the id isn't
     *  present. HS-8335: also disposes the per-ticket signal. */
    removeTicket: (id: number) => {
      const current = get();
      const nextTickets = current.tickets.filter(t => t.id !== id);
      const nextSelected = current.selectedId === id ? null : current.selectedId;
      const ticketsChanged = nextTickets.length !== current.tickets.length;
      const selectedChanged = nextSelected !== current.selectedId;
      if (!ticketsChanged && !selectedChanged) return;
      if (ticketsChanged) perTicketSignals.delete(id);
      set({ ...current, tickets: nextTickets, selectedId: nextSelected });
    },
    /** Optimistically merge a patch into the ticket without an
     *  intervening server round-trip. Used for instant-UI flows like
     *  status flip, star toggle, category change — the server reply
     *  later replaces the ticket via `applyServerUpdate`. HS-8335:
     *  also fires the per-ticket signal so per-row effects update
     *  before the server round-trip completes. */
    optimisticUpdate: (id: number, patch: Partial<Ticket>) => {
      const current = get();
      const existingIdx = current.tickets.findIndex(t => t.id === id);
      if (existingIdx === -1) return;
      const merged: Ticket = { ...current.tickets[existingIdx], ...patch };
      const next = current.tickets.map(t => t.id === id ? merged : t);
      const sigs = perTicketSignals.get(id);
      if (sigs !== undefined && !ticketEqualForRender(sigs.ticket.value, merged)) {
        sigs.ticket.value = merged;
      }
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
    effectiveView(filter.view, filter.search),
    filter.includeBacklogInSearch,
    filter.includeArchiveInSearch,
  );
  if (filter.search === '') return viewFiltered;
  const lc = filter.search.toLowerCase();
  return viewFiltered.filter(t => ticketMatchesSearch(t, lc));
});

/**
 * HS-8618 — search is view-independent: a non-empty search query should
 * return the same results no matter which sidebar view is active, behaving
 * as if "All Tickets" (the `all` view) were selected. Returns the view that
 * narrowing should ACTUALLY use:
 *   - empty search → the real view (no override).
 *   - `trash` → exempt. Trash is a recovery surface; it has no §40
 *     include-row to surface its matches elsewhere, and silently switching
 *     away from it on a keystroke would remove the ability to search trash.
 *   - `custom:*` → exempt. A saved view is a deliberate user-constructed
 *     filter; overriding it on search would defeat its purpose, and the
 *     custom path fetches its matched set server-side via `/tickets/query`.
 *   - every other standard view (`up-next` / `open` / `completed` /
 *     `non-verified` / `verified` / `backlog` / `archive` / `category:*` /
 *     `priority:*`) → `all`, so the search spans the full active scope
 *     (plus whatever the §40 include-row flags mix back in).
 * Used by both the client-side `applyViewFilter` (above) and the
 * coarse server-scope branch in `ticketList.tsx::loadTickets` so the two
 * layers agree.
 */
export function effectiveView(view: string, search: string): string {
  if (search === '') return view;
  if (view === 'trash') return view;
  if (view.startsWith('custom:')) return view;
  return 'all';
}

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
 * rebuild behavior where the rebuild loop iterated `state.tickets`
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
  // HS-8380 — mirror the server's `getTickets` ILIKE clause exactly. Pre-fix
  // this only checked title / details / ticket_number, so when the server's
  // `countSearchMatchesInExcludedStatuses` reported N matches in archive (the
  // count query DOES match against notes + tags too), the client's re-filter
  // pass dropped any ticket whose match lived solely in notes or tags. Result:
  // "Hide 84 archive items" banner alongside a visible list of 17. Now the
  // client filter operates on the same five columns the server does.
  return t.title.toLowerCase().includes(lcSearch)
    || t.details.toLowerCase().includes(lcSearch)
    || t.ticket_number.toLowerCase().includes(lcSearch)
    || t.tags.toLowerCase().includes(lcSearch)
    || t.notes.toLowerCase().includes(lcSearch);
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

/**
 * HS-8335 — read-only handle on the per-ticket signal bundle for
 * `createTicketRow` / `createColumnCard`'s per-row effects. Returns
 * `undefined` for ids the store doesn't know about (race against a
 * mid-render GC pass — the bindList key-reconcile holds a strong ref
 * during the row's lifetime, so this only happens during teardown).
 */
export function getTicketSignals(id: number): { ticket: ReadonlySignal<Ticket> } | undefined {
  return perTicketSignals.get(id);
}

/** **TEST ONLY.** Direct handle on the underlying store for unit tests
 *  to call `.reset()` between cases. Production code goes through the
 *  named exports above. */
export const _ticketsStoreForTesting = ticketsStore;

/** **HS-8335 — TEST ONLY.** Clear the per-ticket signal map. The
 *  store's `.reset()` puts state back to `initial()` but doesn't
 *  dispose the per-ticket signal Map (which lives outside store
 *  state). Tests that need a fully-clean slate call this too. */
export function _clearPerTicketSignalsForTesting(): void {
  perTicketSignals.clear();
}
