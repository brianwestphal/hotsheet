# 61. Composable testable stores (Design Spike)

HS-8167. Follow-up to the HS-8165 investigation. Depends on [§60. Fine-grained reactivity primitive](60-reactivity-primitive.md) shipping first — stores are a thin convention layered on top of the signals primitive HS-8166 introduces.

> **Status:** Design only. No code under HS-8167 itself — phases ship under HS-8238 / HS-8239 / HS-8240 (filed alongside this doc).
> **Verdict:** Adopt a small `defineStore()` factory after HS-8166 Phase 1 lands. Convert one trial store, validate the testing pattern, then migrate `ticketsStore` end-to-end as the highest-impact win.

## 61.1 Problem statement

Today client state lives in three overlapping shapes, none of which compose well:

- **Module-level globals** in `src/client/state.tsx` — open tickets, active project, settings, drawer position, channel state. Some are mutable arrays / objects with ad-hoc subscriber registries; others are read directly off the module export.
- **Per-feature module-level maps** — `src/client/terminalDashboard.tsx::dashboardState`, `src/client/drawerTerminalGrid.tsx::drawerGridState`, `src/client/terminal.tsx::terminalState` (after HS-8189 / HS-8222 / HS-8223 / HS-8224 bundled the per-file `let`s into single state slots). Each file's state has its own private subscriber model.
- **Ad-hoc `subscribeTo*` helpers** — every feature that wants to be notified when its slice changes ships its own pub/sub. Some files have 5+ different subscription primitives.

The cost shows up in three places:

1. **Tests** — every test has to set up the right combination of globals before it can assert anything. Most client tests bypass this by mounting a fake DOM and asserting against it; very few test state transitions in isolation because there's no clean seam.
2. **Composition** — there's no reusable way to derive a piece of UI state from another (`tickets filtered by category` derived from `tickets + activeFilter`). Today every consumer recomputes ad-hoc.
3. **Lifetime** — when does `terminalState` reset on project switch? When does the channel state? Some are per-project, some are global; the reset hooks are scattered and frequently miss a field. (HS-8189 etc. consolidated the *fields* but didn't introduce a lifecycle convention.)

## 61.2 Why a thin store layer beats raw signals

A raw signal is fine when one piece of UI owns one piece of state. A store earns its keep when:

- (a) Multiple consumers read the same state.
- (b) Mutations are non-trivial — multi-step, validating, or derived (e.g. `applyServerUpdate(ticket)` has to merge fields, preserve client-only state, and re-sort).
- (c) The state survives across navigation / project switches and needs an explicit `reset()` hook.

We don't need both raw signals and stores everywhere. The convention is:

> **One consumer = signal. Two+ consumers, multi-step mutations, or cross-navigation lifetime = store.**

A store is just a signal + helpers. The convention is the value, not the abstraction.

## 61.3 Module surface

Single new client module. The shape below is the *target* API; exact field names tune during Phase 1.

### `src/client/store.ts`

```ts
// Conceptual — exact API tuned during HS-8238 Phase 1.
export interface Store<TState, TActions> {
  state: ReadonlySignal<TState>;     // read-only reactive view
  actions: TActions;                  // mutators — the only way to change state
  reset(): void;                      // for tests + project-switch lifecycle
}

export function defineStore<TState, TActions>(spec: {
  initial: () => TState;
  actions: (set: (next: TState) => void, get: () => TState) => TActions;
}): Store<TState, TActions>;
```

Three rules:

1. **`state` is read-only.** Consumers read via `state.value` or subscribe via `effect()` from §60. They cannot write.
2. **`actions` is the only mutation surface.** All writes go through named action functions; no exposed `state.set`. This is what makes stores testable — assert against actions, not against arbitrary writes.
3. **`reset()` resets to `initial()`.** Always defined; tests use it for setup, project-switch lifecycle uses it for tear-down.

### `resetAllStores()` lifecycle hook

A module-level registry tracks every store created via `defineStore()`. On project switch (`switchProject` / `reloadAppState`), `resetAllStores()` walks the registry and calls each `reset()`. This closes the lifetime hole called out in §61.1: today every per-feature reset is hand-wired and easy to miss; with the registry, opting *out* of project-switch reset is the explicit decision (and rare).

## 61.4 Candidate stores — ordered by pain today

From most-painful-today to least:

### 1. `ticketsStore` — highest impact

Today scattered across `ticketList.tsx`, `state.tsx`, `detail.tsx`, plus a handful of ad-hoc subscribe paths in `commandLog.tsx` (last-touched indicator) and `searchBar.tsx`.

- **State:** `{ tickets: Ticket[], filter: FilterState, selectedId: number | null, derived: { filtered, grouped } }`. The `derived` slice is `computed()` on top of `tickets + filter`.
- **Actions:** `loadTickets(force?)`, `setFilter(filter)`, `select(id)`, `applyServerUpdate(ticket)` (merge a single-ticket update from the WS push or the existing poll), `removeTicket(id)`, `optimisticUpdate(id, patch)` (for inline edits — paired with rollback on server reject).
- **UI** subscribes via `bindList(ticketListEl, ticketsStore.state.value.derived.filtered, t => t.id, renderRow)`.

This migration is the bulk of HS-8167's value; it touches the most callsites and has the most ad-hoc subscriber plumbing.

### 2. `projectsStore`

- **State:** `{ projects: Project[], activeSecret: string | null, byId: Map<string, Project> }` (the byId map is `computed`).
- **Actions:** `setActive(secret)`, `applyServerUpdate(project)`, `addProject(p)`, `removeProject(secret)`.
- **Lifetime:** does NOT reset on project switch (it's the source of truth for what to switch *to*).

### 3. `terminalsStore`

- **State:** checked-out terminal entries, visibility groupings, drawer-grid layout, dashboard zoom level.
- **Actions:** `attachEntry(id, secret)`, `detachEntry(id)`, `setVisibility(id, hidden)`, `setActiveGrouping(name)`, `magnify(id)`, `unmagnify()`.
- **Notes:** Today this is split across `terminal.tsx` + `terminalDashboard.tsx` + `drawerTerminalGrid.tsx`. Could be ONE store with derived views per surface, or three stores with a shared base. Phase 3 decision — needs a closer look during migration.

### 4. `commandLogStore`

- **State:** rolling 100-entry log + filter chip state.
- **Actions:** `append(entry)`, `setFilter(kind)`, `clear()`.
- **Notes:** small, contained, good Phase 3 candidate.

### 5. `channelStore`

- **State:** Claude channel busy state, pending-permission, minimized-popup state, last-error.
- **Actions:** `setBusy(busy)`, `setPending(perm)`, `clearPending()`, `minimizePopup()`.
- **Notes:** today spread across `channelUI.tsx` + `permissionOverlay.tsx`. Worth a close read of HS-8190 before migrating — that ticket bundled `permissionOverlay.tsx`'s module-level `let`s into one container; the store is the next step.

### What stays as a raw global

Not every existing global needs a store. These should stay as plain values or single signals:

- `appSettings` (read-mostly, single mutation path is `PATCH /api/settings`).
- `currentDate` / `appBootTime` (constants).
- Per-feature module-level constants (icon sets, key bindings, theme tables).

## 61.5 Migration plan

Phase 1 lands the factory. Phase 2 is the highest-impact migration. Phase 3 is opportunistic.

### Phase 1 — store factory + one trial (HS-8238)

- Build `defineStore` + `resetAllStores` + their tests.
- Convert ONE small global into a store. Suggested trial: **project-tab attention-dot state** (the per-tab "unseen events" indicator). Small, contained, has clear actions (`markAttention(secret)`, `clearAttention(secret)`), and the rendering surface is a single `bindList` already migrated by the §60 trial in HS-8235.
- Ship the test pattern document — what an example store-test looks like, what `reset()` enables in test setup.

### Phase 2 — `ticketsStore` (HS-8239)

This is the highest-impact migration. Tickets touch the most callsites and have the most ad-hoc subscriber plumbing. Migrate the load → render → mutate → reload loop end-to-end:

1. Define the store + actions + derived signals.
2. Convert `loadTickets` to call `ticketsStore.actions.loadTickets()`; remove the global `let openTickets`.
3. Convert `ticketList.tsx`'s rebuild loop to `bindList(parentEl, ticketsStore.state.value.derived.filtered, t => t.id, renderRow)`.
4. Convert single-ticket mutations (status flip, note add, category change) to `ticketsStore.actions.applyServerUpdate(updated)`.
5. End-to-end test pass: load → filter → mutate → server-push → re-render.

Big migration; budget 2–3 days including the test pass. Land it as a single PR (atomic — partial migration leaves the codebase in a worse state than either side).

### Phase 3 — long tail (HS-8240)

Convert `projectsStore` / `terminalsStore` / `commandLogStore` / `channelStore` opportunistically. Each is its own sub-ticket when picked up, so the work can land in pieces.

## 61.6 Test patterns

The whole point of the store layer is testability. Every store gets its own `*.test.ts` with happy-dom env (or pure happy-dom-free if the store doesn't touch DOM):

- Actions update state — `loadTickets` populates `state.value.tickets`.
- Derived signals recompute — `setFilter('bug')` shrinks `state.value.derived.filtered`.
- `reset()` clears state — fresh store after `reset()` matches `initial()` deeply.
- Selectors are pure — given the same state, the same derived value.
- No DOM mounting required — that's the whole point.

Stores should be testable WITHOUT mounting any DOM. The DOM rendering is the §60 helpers' job, tested separately.

## 61.7 What stays the same

- Every existing global keeps working until its callsite is migrated.
- No URL routing changes, no API changes.
- The signals primitive (HS-8166) is the dependency, not Solid.
- Server-side code untouched.
- `jsx-runtime.ts` and `toElement` untouched.

## 61.8 Open questions / deferred decisions

- **Action middleware** (logging, devtools, time-travel) — explicitly out of scope. If a real debugging need surfaces, add a thin `withLogging(store)` wrapper later. Don't pre-build Redux.
- **Cross-store derivation** (e.g. `selectedTicketStore` derived from `ticketsStore + selectionStore`) — falls out of `computed()` from §60 across two stores' `state` signals. No new machinery needed; document the pattern in Phase 1.
- **Persistence** — some stores might want `localStorage`-backed persistence (e.g. drawer position). Add `defineStore({...persist: 'key'})` later; not Phase-1 work.
- **Plugin-defined stores** — out of scope. Plugins today don't reach into client state directly, and exposing a `defineStore` from `PluginContext` opens a different design. Defer until a plugin asks for it.
- **`ticketsStore` derived-view granularity** — should the store own `filtered` + `grouped` or should each consumer derive its own? Default to "store owns the common shapes; consumers derive bespoke ones". Settle during HS-8239.

## 61.9 Risks

- **Over-engineering** — adding a store layer where a raw signal would do. Mitigate via the §61.2 rule and reviewer pushback during migration PRs.
- **Migration footgun: forgetting `reset()`** — leaves stale state visible after project switch. Closed by §61.3's automatic registry + `resetAllStores()` hook firing in `switchProject`.
- **Atomicity** — `ticketsStore` migration MUST land atomically. A half-migrated state where some consumers read the global and others read the store is the worst possible interim.
- **Test pattern drift** — if Phase 1 doesn't pin down "what does a good store test look like", Phase 2/3 tests will diverge. Phase 1 ships a written test pattern (in this doc or a sibling) before the trial migration is approved.

## 61.10 Open-source angle

`defineStore` + `resetAllStores` + the §60 reactivity primitive + the `reactive-bind` helpers together form a complete "micro state-management library" — competes with Zustand / Jotai but at ~2 KB total instead of 10–20 KB, with no React assumption. Could be its own package once both pieces prove out across all migration phases. Not a priority; just keeps the boundary clean.

## 61.11 Cost estimate

- Phase 1 (HS-8238): ~half a day. Factory + tests + trial conversion + test-pattern doc.
- Phase 2 (HS-8239 — `ticketsStore`): 2–3 days including end-to-end tests. Single atomic PR.
- Phase 3 (HS-8240): opportunistic; budget per sub-ticket as picked up.

## 61.12 Status & follow-up tickets

- **HS-8167 — this design.** Status: design only; closes once the doc lands.
- **HS-8238 — Phase 1: `defineStore` factory + trial.** Project-tab attention-dot the proposed trial.
- **HS-8239 — Phase 2: `ticketsStore` migration.** Single atomic PR; biggest win.
- **HS-8240 — Phase 3: long tail.** Opportunistic; each sub-store is its own sub-ticket.

## 61.13 Cross-refs

- [§60. Fine-grained reactivity primitive](60-reactivity-primitive.md) — hard dependency. HS-8166 must ship before HS-8167 phases start.
- [§62. Unified JSX render targets](62-unified-jsx-render-targets.md) — independent track. No dependency either direction.
- HS-8165 — investigation that produced the verdict driving this doc.
- HS-8189 / HS-8190 / HS-8222 / HS-8223 / HS-8224 — prior bundling of per-file module-level `let`s; this doc is the next step that makes those bundles testable.
- §18 (plugin system) — plugin-defined stores deferred per §61.8.
