# 61. Composable testable stores (Design Spike)

HS-8167. Follow-up to the HS-8165 investigation. Depends on [§60. Fine-grained reactivity primitive](60-reactivity-primitive.md) shipping first — stores are a thin convention layered on top of the signals primitive HS-8166 introduces.

> **Status:** Phase 1 (HS-8238) shipped 2026-05-09. **HS-8240 (Phase 3 umbrella) closed 2026-05-10 as discharged into per-store sub-tickets HS-8317 (`projectsStore`), HS-8318 (`commandLogStore` + paired view-layer per the HS-8311 deferral), HS-8319 (`terminalsStore`), HS-8320 (`channelStore`).** HS-8321 added as prep for HS-8239 — defines the `ticketsStore` factory + types in isolation so HS-8239's atomic flip becomes a smaller, more reviewable diff. Phase 2 (HS-8239) itself still queued pending HS-8321.
> **Verdict:** Adopt `defineStore` / `resetAllStores` from `kerfjs` (already pulled in for §60 — see HS-8235 / `docs/60-reactivity-primitive.md` §60.3). The local `defineStore()` factory described in §61.3 below is NOT implemented locally — kerf ships the same shape. The §61.3 module-surface description still applies as an *API* spec; the implementation is `kerfjs` re-exported through `src/client/reactive.ts`.

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

### `src/client/reactive.ts` (re-export of `kerfjs`)

```ts
// Implementation lives in `kerfjs`; Hot Sheet re-exports through
// `src/client/reactive.ts` per §61.3 / HS-8238.
import { defineStore, resetAllStores } from 'kerfjs';
import type { Store } from 'kerfjs';
//   Store<TState, TActions>:
//     state:   ReadonlySignal<TState>
//     actions: TActions
//     reset(): void
//   defineStore<TState, TActions>({ initial: () => TState,
//                                   actions: (set, get) => TActions })
//     → Store<TState, TActions>
//   resetAllStores(): walks every store registered via defineStore() and
//                     calls each .reset(). For tests + lifecycle hooks.
```

Three rules:

1. **`state` is read-only.** Consumers read via `state.value` or subscribe via `effect()` from §60. They cannot write.
2. **`actions` is the only mutation surface.** All writes go through named action functions; no exposed `state.set`. This is what makes stores testable — assert against actions, not against arbitrary writes.
3. **`reset()` resets to `initial()`.** Always defined; tests use it for setup, project-switch lifecycle uses it for tear-down.

### `resetAllStores()` lifecycle hook

A module-level registry tracks every store created via `defineStore()`. The registry walk is exposed via `resetAllStores()`.

**HS-8238 implementation note (2026-05-09):** the original §61.3 design called for wiring `resetAllStores()` into `switchProject` / `reloadAppState` so per-project state resets automatically on switch. In practice, every Hot Sheet store landed so far holds *cross-project* state (attention dots, busy indicators, channel state) — none of which should reset on switch. So the hook is currently **not** wired into any production path; tests use it via `beforeEach(() => resetAllStores())` for isolation. If a future per-project store lands, it should NOT participate in `defineStore()` (kerf has no opt-out — see kerf §3.4); use a raw signal instead. Re-evaluate the production wiring once HS-8239 (`ticketsStore`) lands — that one IS per-project and is the natural first caller.

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

### Phase 1 — store factory + one trial (HS-8238) — **shipped 2026-05-09**

- ✅ `src/client/reactive.ts` re-exports `defineStore` / `resetAllStores` / `Store` from `kerfjs` (NO local factory implementation — kerf provides the same shape per §61.3 above).
- ✅ Trial migration: the project-tab attention-dot state in `src/client/channelUI.tsx`. `attentionProjects: Set<string>` became a `defineStore({ initial, actions: markAttention/clearAttention })`. Public surface (`getProjectAttentionSecrets()`, `markProjectAttention()`, `clearProjectAttention()`) unchanged — consumers still see a `ReadonlySet<string>`. New test-only export `_projectAttentionStoreForTesting` for direct `.reset()` access. Each action does an immutable update (`new Set(get().secrets)`) so downstream `effect()` consumers see a fresh reference per change.
- ✅ Tests: 3 new cases under `reactive — defineStore / resetAllStores re-exports (HS-8238)` in `src/client/reactive.test.ts` cover the kerf re-export contract; 7 cases in `src/client/channelUI.test.ts` cover the attention-store migration end-to-end.
- ⏭️ Production `resetAllStores()` wiring: skipped per §61.3 implementation note (no per-project store landed yet that would benefit). Re-evaluate during HS-8239.
- 📄 Test pattern: documented inline at the top of `channelUI.test.ts` (`beforeEach(() => store.reset())` for isolation; `afterEach` mirrors it; tests assert against actions, not against direct state writes).

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

**HS-8240 closed 2026-05-10 as umbrella-discharged into per-store sub-tickets:**

- **HS-8317** — `projectsStore` migration. **Shipped 2026-05-10.** New `src/client/projectsStore.ts` consolidates the pre-fix `state.tsx::activeProject` raw `let` + `projectTabs.tsx::projectListSignal` + `activeSecretSignal` (HS-8235) into a single kerf `defineStore`. Public surface (`getActiveProject()` / `setActiveProject(project)`) unchanged — the 88 callsites across 18 files see no behavioural change. Per-row active-class effect in `renderTabRow` reads from the new `activeProjectSignal` computed; the bindList parent uses a thin `projectsListSignal = computed(() => projectsStore.state.value.projects)` wrapper. 15 unit tests in `projectsStore.test.ts` + every existing `state.test.ts` / `projectTabs.test.ts` / `channelUI.test.ts` case still passes.
- **HS-8318** — `commandLogStore` + `commandLog.tsx::renderEntries` bindList migration (paired per the HS-8311 deferral). MEDIUM risk; ~full session.
- **HS-8319** — `terminalsStore` migration. HIGH risk (multi-surface — drawer tabs + dashboard + drawer-grid + visibility groupings); 1-2 sessions including the shape-decision investigation (one store vs three).
- **HS-8320** — `channelStore` migration. MEDIUM-HIGH risk (permission-overlay critical path); ~half-to-full session.

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
- **HS-8239 — Phase 2: `ticketsStore` migration.** Single atomic PR; biggest win. Prep work in HS-8321 (factory + types + tests, no consumers wired) lands first to shrink the atomic-flip surface.
- **HS-8321 — Phase 2 prep: `ticketsStore` factory + types.** Pure addition; lands the store + tests in isolation so HS-8239's atomic flip is a smaller diff.
- **HS-8240 — Phase 3: long tail.** Closed 2026-05-10 as umbrella-discharged into HS-8317 (`projectsStore`), HS-8318 (`commandLogStore` + view-layer), HS-8319 (`terminalsStore`), HS-8320 (`channelStore`). Each sub-ticket scheduleable independently.

## 61.13 Rejected alternative: nanostores as the backbone

HS-8248 evaluated [`nanostores`](https://github.com/nanostores/nanostores) (~294 bytes core, atom / map / computed / cleanStores primitives) as a drop-in replacement for the bespoke `defineStore` factory. **Rejected.** A future contributor finding nanostores attractive can stop here.

### The compatibility blocker

§60's binding helpers (`bindText` / `bindAttr` / `bindList`) are built on `@preact/signals-core`'s `effect()`, which auto-tracks dependencies via the `signal.value` getter — read a signal inside an `effect()` and the effect re-runs when that signal changes. **Nanostores does not participate in this protocol.** Per the upstream source (`atom/index.js`), `.get()` is a plain accessor that reads `$atom.value`; subscriptions go through explicit `.listen(cb)` / `.subscribe(cb)`; cross-store derivation is the explicit `computed([$a, $b], fn)` constructor that wires its own listeners.

Consequence: every §60 helper would need a parallel nanostores variant (`bindTextNano(el, $store)`), OR every nanostore would need a manual signal mirror at the consumer (`const sig = signal($store.get()); $store.listen(v => { sig.value = v })`) — either way, **two reactivity systems on the client**, exactly the smell §60 + §61 exist to remove. The whole point of the bespoke factory is that its `state` field IS a `@preact/signals-core` signal, so §60 helpers consume stores for free with no adapter layer.

The decision criterion in HS-8248 was explicit: adopt nanostores only if §60 helpers integrate cleanly. They don't. That alone settles it.

### Secondary findings (each independently insufficient, but pile up)

1. **Bundle-size win is illusory.** Nanostores core is 294 bytes; the bespoke factory is ~50 lines (a few hundred bytes minified). Both are negligible against the 1.4 KB `@preact/signals-core` baseline either approach already pays. Nanostores doesn't displace any code we'd otherwise write — it sits *on top of* signals-core, not instead of it.
2. **`cleanStores` ≠ `resetAllStores`.** Nanostores' `cleanStores(...stores)` tears stores down entirely (subscribers detach, listeners cleared) — designed for test cleanup, not for runtime project-switch reset. §61.3's `resetAllStores()` resets to `initial()` *while keeping subscribers attached*, so binding helpers stay live across the project switch and just see the new initial state. Fundamentally different semantics; we'd be wrapping nanostores anyway to re-implement `reset()`. The wrapper is the bespoke factory.
3. **Actions-only convention costs a wrapper either way.** Nanostores' `set()` / `setKey()` are publicly callable by any consumer. §61.3's three rules (read-only state, actions-only mutation, reset-to-initial) require hiding `.set` / `.setKey` behind named action functions. Wrapping `atom` to enforce that isn't simpler than just exposing a `set` to the action-builder closure ourselves — the closure is the bespoke factory, give or take 10 lines.
4. **`task()` is not a need we have.** Async actions in §61 are plain `async` functions calling existing actions; we don't need nanostores' built-in racing primitive. If a real need surfaces, it's a 20-line helper on top of the factory rather than a reason to adopt a second library.
5. **TypeScript ergonomics — wash.** Both produce reasonable inference. Nanostores' `map` types are slightly nicer for partial updates; the bespoke factory's `actions: (set, get) => TActions` shape is slightly nicer for the action surface. Neither is a tipping point.

### What this investigation validated

- **§60 IS the reactivity backbone.** The bespoke factory is a thin convention layer over `@preact/signals-core` signals — that's a feature, not an interim. The signals primitive *is* the reactivity system; stores are just a structured way to organise consumers + mutations on top. Adopting any second reactive library — nanostores or otherwise — would have been a regression toward the "two reactivity systems" smell HS-8165 already ruled out at framework scale.
- **The §61.2 rule (one consumer = signal, two+ = store) holds.** Nanostores' atom-as-default culture nudges every callsite toward an atom even when a raw signal would do. Our convention pushes the other direction, which is correct for our codebase size.

### Bottom line

Nanostores is well-built and small, but its compatibility cost (parallel binding helpers OR a manual signal-mirror layer) exceeds its size win, and the wrapper required to enforce §61's three rules is the bespoke factory regardless. Stay with the §61.3 spec as written. **HS-8238 ships the factory from scratch.** Do not re-open this question without a new piece of evidence that invalidates the auto-tracking analysis above.

## 61.14 Cross-refs

- [§60. Fine-grained reactivity primitive](60-reactivity-primitive.md) — hard dependency. HS-8166 must ship before HS-8167 phases start.
- [§62. Unified JSX render targets](62-unified-jsx-render-targets.md) — independent track. No dependency either direction.
- HS-8165 — investigation that produced the verdict driving this doc.
- HS-8189 / HS-8190 / HS-8222 / HS-8223 / HS-8224 — prior bundling of per-file module-level `let`s; this doc is the next step that makes those bundles testable.
- HS-8248 — pre-implementation investigation that confirmed the bespoke factory; rationale archived in §61.13.
- §18 (plugin system) — plugin-defined stores deferred per §61.8.
