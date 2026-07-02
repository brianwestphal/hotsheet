# 40. Search "include archive + backlog" rows (HS-7756)

## 40.1 Overview

The default ticket views (All, Up Next, category filters, custom views without `includeArchived`) hide tickets whose status is `backlog` or `archive`. That makes sense for normal browsing — the user wants to see active work, not the long tail. But when **searching**, the user is already narrowing by an explicit query and the cost of including those buckets is one extra row per match. Hiding them here means the user types a query, sees no result, gives up, and never realises there was a perfect match buried in archive from six months ago.

HS-7756 fixes this by counting search matches in the hidden buckets and surfacing them as **opt-in** "Include {N} backlog items" / "Include {N} archive items" rows under the multi-select toolbar. Click → those rows mix into the result set (sorted alongside the active matches). The counts and the rows only appear while a search is active; clearing the search clears the rows.

**HS-8618 interaction.** Since search is now view-independent (a non-empty query behaves as the All Tickets view for every standard view — see [4-user-interface.md](4-user-interface.md) §4.8), the active result set is always the active scope while searching, so these include rows surface backlog/archive matches uniformly no matter which view the user started from. In particular, searching from the Backlog or Archive view no longer confines results to that bucket — it returns the active scope and offers that bucket back via its include row.

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

`src/client/searchExtraRows.tsx` exposes `renderSearchExtraRows(reload)`. It paints into a new `<div id="search-extra-rows">` element that lives directly above the multi-select toolbar (`#batch-toolbar`) in `pages.tsx` — DOM order is `#search-extra-rows` → `#batch-toolbar` → `#ticket-list`. Each row is a flex pill with a Lucide icon (`calendar` for backlog, `archive` for archive), a label, and click + Enter / Space keyboard activation. Active state (`.is-active`) tints the row with the accent so the user can see at a glance which buckets they've already mixed in; the label flips between "Include {N} backlog items" and "Hide {N} backlog items" accordingly.

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
- **Markup:** `src/routes/pages.tsx` adds `<div id="search-extra-rows">` directly above the multi-select toolbar (DOM order: `#search-extra-rows` → `#batch-toolbar` → `#ticket-list`).
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

## 40.8 Exact ticket-id search bypasses the status gate (HS-8100)

When the user types an exact ticket-number reference in the search box (e.g. `HS-100`, `BUG-42`, `MIGRATION_V2-7`), the result must show that ticket regardless of which bucket it lives in — including **trash** (`status = 'deleted'`), which the §40.2 include flags don't cover.

**Detection** — pure helper `isExactTicketIdSearch(s)`. HS-8653 moved the canonical implementation to the dependency-free `src/ticketNumber.ts` so the server (`src/db/tickets.ts`, which re-exports it) and the client (`ticketsStore.ts`) share ONE definition and can't drift. Matches `^\s*[A-Za-z][A-Za-z0-9_]*-\d+\s*$` (case-insensitive, trims whitespace). Same shape as `ticketRefs.ts::buildTicketRefRegex`'s inline-link pattern, anchored to the full string so a query like `HS-100 fix me` (free text containing a ticket id) is NOT treated as exact.

**Server behavior** in `buildTicketWhereClause`:
- The default `status NOT IN ('deleted', 'backlog', 'archive')` guard is dropped — every bucket is visible.
- The search predicate switches from substring `ILIKE %q%` (which would have pulled `HS-1000` for an `HS-1` query) to strict `LOWER(ticket_number) = LOWER($q)` so `HS-1` resolves to exactly that one ticket.
- Other filters (category / priority / up_next) still apply.

**Client behavior (HS-8653)** — the server returning the ticket isn't enough: `ticketsStore.ts::filteredTickets` runs the loaded set through `applyViewFilter`, whose active scope excludes `deleted` / `backlog` / `archive`, so it re-hid the archived/trashed exact match the server had returned (symptom: searching an archived ticket's exact number showed nothing). The fix mirrors the server's exact-id semantics on the client: when `isExactTicketIdSearch(search)` is true, `filteredTickets` bypasses the view-filter exclusion for the ticket whose `ticket_number` strictly equals the search (case-insensitive), prepending it (deduped against the view-filtered set). Falls through to the normal substring filter when no loaded ticket matches the exact id.

**search-counts** (`countSearchMatchesInExcludedStatuses`) returns `{ backlog: 0, archive: 0 }` for exact-id searches — the main query already returned the matched ticket from any bucket, so the §40.2 "Include {N} ..." rows would be redundant.

**Tests:** 8 in `src/db/queries.test.ts`'s `exact ticket-id search bypasses status filter (HS-8100)` describe block (server: backlog / archive / trash hits, case insensitivity, no-substring-drift, suppressed include counts, regex shape) + 8 in `src/client/ticketsStore.test.ts`'s `filteredTickets exact ticket-id search (HS-8653)` block (client: archive / trash / backlog surfacing, case insensitivity, archive-view override, no-dup, non-exact-respects-exclusion, no-match-fallthrough).

## 40.9 Exact ticket-id search ALSO surfaces mentions (HS-9241)

Searching a complete ticket id (e.g. `HS-8838`) returns **the ticket AND every OTHER ticket that mentions it** — a blocked-by note, a "see HS-8838", a cross-reference in another ticket's details. Extends §40.8 (which returned only the exact ticket).

**What counts as a "mention"** — the id appearing as a **boundary-delimited token** in `title` / `details` / `tags` / `notes` (the ticket's own `ticket_number` is the exact match, handled separately). Boundary-delimited so `HS-8838` matches a reference to it but NOT `HS-88380` — the same definition as the §55 cross-reference linkifier (`ticketRefs.ts::buildTicketRefRegex`'s `\b(PREFIX)-(\d+)\b`), so "mentions" == "would linkify as a ref to this ticket".

**Visibility rules (the key nuance):**
- **The exact ticket** stays visible **regardless of status** (archive / backlog / trash), in the "Not Started" column in column view (unchanged from §40.8).
- **Mentions** follow the **normal active gate** — active tickets show inline; mentions hidden in backlog / archive surface via the §40.2 **"Include {N}"** rows (which now count *mentions* in those buckets, **excluding** the always-shown exact ticket — reversing §40.8's `{0,0}` short-circuit for exact-id searches).

**Server** (`src/db/tickets.ts::buildTicketWhereClause`): for an exact-id search the search predicate becomes `(LOWER(ticket_number) = LOWER($q) OR title ~* $m OR details ~* $m OR tags ~* $m OR notes ~* $m)` where `$m` = `\y<id>\y` (Postgres word-boundary regex, via `ticketIdMentionPattern`), and the status clause becomes `(<active-gate + include-flags> OR LOWER(ticket_number) = LOWER($q))` so the exact ticket bypasses the gate while mentions respect it. `countSearchMatchesInExcludedStatuses` counts `\y<id>\y` mentions in backlog / archive, excluding the exact ticket.

**Client** (`src/client/ticketsStore.ts::filteredTickets`): the exact-id branch force-includes the exact ticket at the front (as before) and now ALSO appends `viewFiltered.filter(t => ticketMentionsId(t, target))` — `ticketMentionsId` is the JS mirror (`\b<id>\b`, case-insensitive, over title/details/tags/notes). It falls through to the substring filter only when neither an exact match nor a mention resolves (so a partial number like `HS-12` still finds `HS-1234`, while a real `HS-1` hit never drifts into `HS-100`).

**Auto-scroll (HS-9241):** after a search renders, `ticketList.tsx::scrollSearchMatchIntoView()` scrolls the exact-match ticket into view (`block: 'nearest'`, a no-op when already on screen) — the match is `filteredTickets`'s first entry and may sit far down (e.g. absorbed into the "Not Started" column, or below a run of mentions). Wired into the search-input handler (`sidebar.tsx`) after the debounced reload; a `requestAnimationFrame` lets the reactive list / column bindList paint the row first. Non-exact searches (and ids that match nothing) no-op.

**Tests:** 6 in `src/db/queries.test.ts`'s `exact ticket-id search ALSO returns mentions (HS-9241)` block (server: mention in details / in a note, boundary rejects `HS-<n>0`, exact-shows-regardless-of-status-while-mentions-gated, `include_archive` surfaces an archived mention, count-helper counts backlog/archive mentions excluding the exact ticket) + 5 in `src/client/ticketsStore.test.ts`'s `filteredTickets exact-id mentions (HS-9241)` block (client: mention-in-details with exact-first ordering, mention-in-notes, boundary `HS-5`≠`HS-50`, exact-regardless-of-status vs gated mention, `includeArchiveInSearch` surfacing).

## 40.5 Client-side filter parity (HS-8380)

The server's `getTickets` WHERE clause matches against five columns: `title`, `details`, `ticket_number`, `tags`, `notes`. `countSearchMatchesInExcludedStatuses` uses the same five-column ILIKE union so its `{backlog, archive}` counts agree with what `getTickets` would return for the same search.

Pre-fix, the client-side re-filter in `ticketsStore.ts::ticketMatchesSearch` only checked `title` + `details` + `ticket_number` — the server returned the full five-column match set, then the client dropped any ticket whose match lived solely in `tags` or `notes`. Symptom on the Archive view with a notes-keyword search: "Hide 84 archive items" banner alongside a visible list of only 17 (the count was correct; the list was wrong).

Post-fix, `ticketMatchesSearch` checks all five columns the server does, so the visible list size and the banner's reported count agree.

**Tests:** 2 new in `src/client/ticketsStore.test.ts`'s `filteredTickets derived signal` describe block — covers a notes-only match and a tags-only match against a query that doesn't appear in title / details / ticket_number.

**Status:** Shipped (HS-7756) + extended (HS-8100, HS-8380, HS-8653, HS-9241 — exact-id search also surfaces mentions + auto-scrolls to the exact match).
