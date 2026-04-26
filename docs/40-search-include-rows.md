# 40. Search "include archive + backlog" rows (HS-7756)

## 40.1 Overview

The default ticket views (All, Up Next, category filters, custom views without `includeArchived`) hide tickets whose status is `backlog` or `archive`. That makes sense for normal browsing — the user wants to see active work, not the long tail. But when **searching**, the user is already narrowing by an explicit query and the cost of including those buckets is one extra row per match. Hiding them here means the user types a query, sees no result, gives up, and never realises there was a perfect match buried in archive from six months ago.

HS-7756 fixes this by counting search matches in the hidden buckets and surfacing them as **opt-in** "Include {N} backlog items" / "Include {N} archive items" rows under the multi-select toolbar. Click → those rows mix into the result set (sorted alongside the active matches). The counts and the rows only appear while a search is active; clearing the search clears the rows.

## 40.2 Server side

A new lightweight endpoint:

```
GET /api/tickets/search-counts?search=<q>
→ { backlog: number, archive: number }
```

Backed by the new pure helper `countSearchMatchesInExcludedStatuses(search)` in `src/db/tickets.ts`. The helper runs two `SELECT COUNT(*)` queries in parallel (one per bucket, search-scoped via the same `(title ILIKE OR details ILIKE OR ticket_number ILIKE OR tags ILIKE OR notes ILIKE)` predicate the main `getTickets` filter uses, so counts and the on-toggle-include result rows stay in sync). Empty `search` returns `{ backlog: 0, archive: 0 }` without hitting the database.

The existing `GET /api/tickets` endpoint gains two new query-string flags:

- `include_backlog=true` — when set, the WHERE clause OR-s in `status = 'backlog'`.
- `include_archive=true` — same for `archive`.

Both extend whatever the normal `status` filter would otherwise return, so the merged set comes back already-sorted by the user's chosen `sort_by` / `sort_dir`. The helpers in `buildTicketWhereClause` (in `src/db/tickets.ts`) detect these flags and wrap the status-condition with `(<original> OR status IN (...))`.

When the explicit `status` filter names a single bucket directly (e.g. `?status=backlog`), the include flags are ignored — picking a specific status is already an explicit request for that bucket only.

## 40.3 Client side

### State

`src/client/state.tsx` adds three fields:

- `includeBacklogInSearch: boolean` (default `false`)
- `includeArchiveInSearch: boolean` (default `false`)
- `viewModeBeforeSearchInclude: 'list' | 'columns' | null` (saved layout to restore on clear)
- `searchExtraCounts: { backlog: number; archive: number }` (last-fetched counts from the new endpoint)

### Render

`src/client/searchExtraRows.tsx` exposes `renderSearchExtraRows(reload)`. It paints into a new `<div id="search-extra-rows">` element that lives between the multi-select toolbar (`#batch-toolbar`) and the ticket list (`#ticket-list`) in `pages.tsx`. Each row is a flex pill with a Lucide icon (`calendar` for backlog, `archive` for archive), a label, and click + Enter / Space keyboard activation. Active state (`.is-active`) tints the row with the accent so the user can see at a glance which buckets they've already mixed in; the label flips between "Include {N} backlog items" and "Hide {N} backlog items" accordingly.

### Fetch + reload flow

`loadTickets()` in `src/client/ticketList.tsx`:

1. If `state.search === ''`: call `clearSearchIncludeState()` to reset both include flags + restore the saved view mode + clear the counts.
2. Send `include_backlog=true` / `include_archive=true` in the URL params if the corresponding flag is on.
3. After the main fetch + render, fire-and-forget `GET /tickets/search-counts?search=...` to refresh the counts, then call `renderSearchExtraRows`.

### View-mode auto-switch

When the user clicks an "Include" row while the layout is `columns`:

1. Save `state.layout` into `state.viewModeBeforeSearchInclude`.
2. Force `state.layout = 'list'` (column view groups by status; mixing backlog/archive in wouldn't fit).
3. Persist the new layout via `PATCH /api/settings { layout: 'list' }`.
4. Reload tickets.

When the user clears the search (`×` button or empties the input), `clearSearchIncludeState()` restores the saved layout (also persisted) and the user is back where they started.

When the user manually clicks the **column view** layout button while either include flag is on (per the spec: "if the user tries to manually switch back to column view, it should restart the search"), the flags are cleared via `clearIncludeFlagsOnly()` and `loadTickets()` runs to refetch the active-only result set. The search itself stays active and the include rows re-render so the user can re-toggle if they change their mind.

## 40.4 Implementation

- **Server:** `src/db/tickets.ts` (`buildTicketWhereClause` extended with the include-flag OR-wrap; new `countSearchMatchesInExcludedStatuses(search)` helper). `src/routes/tickets.ts` (`GET /tickets` parses the new query-string flags; new `GET /tickets/search-counts` route). `src/types.ts` (`TicketFilters` gains `include_backlog?: boolean` + `include_archive?: boolean`).
- **Client:** `src/client/searchExtraRows.tsx` (new module — `renderSearchExtraRows`, `clearSearchIncludeState`, `clearIncludeFlagsOnly`). `src/client/ticketList.tsx` `loadTickets` extended. `src/client/app.tsx` `bindLayoutToggle` extended for the column-view "restart search" path. `src/client/state.tsx` state shape extended.
- **Markup:** `src/routes/pages.tsx` adds `<div id="search-extra-rows">` between the multi-select toolbar and the ticket list.
- **SCSS:** `src/client/styles.scss` adds `.search-extra-rows`, `.search-extra-row` (+ `.is-active`), `.search-extra-row-icon`, `.search-extra-row-label`.
- **Tests:** 4 new unit tests in `src/db/queries.test.ts` cover `include_backlog`, `include_archive`, the `countSearchMatchesInExcludedStatuses` helper, and the empty-search short-circuit. All 126 db tests pass; full test suite (860 unit tests) clean.

## 40.5 Out of scope (deferred)

- **Loading/empty states** for the include rows (e.g. a brief "Searching backlog…" spinner while the count fetch is in flight). The fetch is fire-and-forget after the main fetch + render, so the rows just pop in once results are in.
- **Per-bucket sort indicators** in the merged result set — today the user sees a single sort applied to the union; differentiating backlog/archive entries visually beyond their status badge is a polish item.
- **Saving `includeBacklogInSearch` / `includeArchiveInSearch` per project** — currently session-only. The spec is "active while the search is active"; persisting these would be a different UX entirely.
- **Custom views with `includeArchived: true`** — that path predates HS-7756 and uses its own surface (`/api/tickets/query` with `include_archived` in the body). HS-7756 is purely about the in-line search-bar flow. The two are independent.

## 40.6 Manual test plan

See [docs/manual-test-plan.md] (no §40 entry yet — append):

1. Type a search query that matches only active rows → no include rows appear.
2. Type a query that matches archive entries only → "Include {N} archive items" row shows; backlog row does not.
3. Click the Include row → archive rows mix in, sorted with the rest. Row label flips to "Hide {N} archive items".
4. Click again → archive rows hide; label flips back.
5. Clear the search → include rows disappear; layout reverts to whatever it was before the user clicked Include.
6. With a query active and Include toggled on while in list view, click the **columns** layout button → flags clear, view switches to columns, include rows re-render so the user can re-toggle.
7. Custom view with `includeArchived: true` is unaffected — the include rows don't appear there since the view already pulls in archive.

## 40.7 Cross-references

- §3 (ticket statuses — backlog + archive). The default views exclude these buckets; HS-7756 adds an opt-in mechanism specifically for the search flow.
- §4.3 (List view) + §4.4 (Column view). The auto-switch logic flips between these two.
- §9 (API). `GET /tickets` flags + new `GET /tickets/search-counts`.

**Status:** Shipped (HS-7756).
