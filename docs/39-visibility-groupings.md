# 39. Visibility groupings (HS-7826 / HS-8290 / HS-8406)

## 39.1 Overview

The Show / Hide Terminals dialog (§25.10.6 / §36.6.5) and the persistence layer added in §38 (HS-7825) treat hidden state as **one** flat list per project. That works when a user has a single mental model — "these are the terminals I don't want to see." It breaks down when the user has multiple competing contexts: maybe the user wants a "claude only" view to focus on a coding session, a "server logs" view to triage a deploy, a "single app" view to keep one project front-and-center. Pre-HS-7826 the only option was to keep toggling rows back and forth as the focus changed.

HS-7826 introduces named **visibility groupings**. Each grouping carries its own hidden ids and the user switches between them via a tab bar in the dialog and (when more than one grouping exists) a dropdown next to the eye icon in the dashboard / drawer-grid toolbar. The active grouping drives the dashboard / drawer-grid filter.

**HS-8290 reshape** — pre-HS-8290 each project had its own grouping list stored under `visibility_groupings` in `.hotsheet/settings.json`, and a cross-project fan-out machinery (§39.7 in the prior revision) mirrored every grouping CRUD operation across every project to keep duplicated lists aligned. Post-HS-8290 the grouping list is **a single global record** in `~/.hotsheet/config.json` under `dashboard.visibilityGroupings`, with each grouping carrying a `hiddenByProject: Record<secret, string[]>` map that holds per-project hidden ids. The fan-out machinery is gone.

**HS-8406 reshape** — HS-8290 collapsed the active-grouping selection into a single global `activeId`, which meant flipping the dropdown in a project's drawer-grid ALSO flipped the dashboard's pick (and every other project's). HS-8406 keeps the grouping list global but re-introduces **per-scope active-grouping selection**: each surface that reads/writes the active grouping uses its own scope key. The dashboard uses `'dashboard'`; each project's drawer-grid + the drawer-grid's hide-terminal dialog uses `'project:<secret>'`. The grouping definitions (the named groupings + their per-project hidden id lists) stay shared so a hide / unhide / rename made anywhere is visible everywhere; only the "which grouping is currently active" pick is scoped.

## 39.2 Data model (HS-8290 → HS-8406)

A grouping is `{ id, name, hiddenByProject }`. The grouping list is global; per-project hidden ids live inside each grouping under `hiddenByProject[secret]`. The Default grouping is always present, identifiable by the literal id `'default'`, and refused for deletion (rename works since the id is the invariant — name is just a label). HS-8406 replaces the single global `activeId` with a `activeIdByScope: Record<string, string>` map keyed by scope.

```ts
interface VisibilityGrouping {
  id: string;          // 'default' for the Default tab; `g-…` for user-added
  name: string;        // display name shown in the tab bar + dropdown
  hiddenByProject: Record<string, string[]>; // secret → hiddenIds for that project
}

interface GlobalVisibilityState {
  groupings: VisibilityGrouping[];
  // HS-8406 — per-scope active grouping. Scope keys: 'dashboard' for the §25
  // terminal dashboard, 'project:<secret>' for a project's §36 drawer-grid.
  // Scopes missing from the map fall back to DEFAULT_GROUPING_ID — the
  // absence of an entry IS Default, so deleting the dashboard's override or
  // setting it back to Default removes the entry to keep the payload byte-stable.
  activeIdByScope: Record<string, string>;
}

// Two scope-key helpers exported from visibilityGroupings.ts:
const DASHBOARD_SCOPE = 'dashboard';
function projectScope(secret: string): string { return `project:${secret}`; }
```

Pure helpers in `src/client/visibilityGroupings.ts` (`addGrouping`, `renameGrouping`, `deleteGrouping`, `reorderGroupings`, `setActiveGroupingIdFor(state, scopeKey, id)`, `getActiveGroupingFor(state, scopeKey)`, `getActiveGroupingIdFor(state, scopeKey)`, `toggleHiddenInGrouping`, `parsePersistedState`, `pruneStaleIdsInGroupings`) own every state transition. Deleting a grouping that's currently the active pick in any scope strips that scope's override (the scope falls back to Default on next read). Unit tests in `visibilityGroupings.test.ts`.

## 39.3 Persistence (HS-8290 → HS-8406)

Two global keys in `~/.hotsheet/config.json` under `dashboard`:

| Key | Type | Default | Notes |
|---|---|---|---|
| `dashboard.visibilityGroupings` | `VisibilityGrouping[]` | `[{ id: 'default', name: 'Default', hiddenByProject: {} }]` | One entry per grouping, displayed in array order. |
| `dashboard.activeVisibilityGroupingIdByScope` | `Record<string, string>` | `{}` | HS-8406 — per-scope active grouping selections. Empty when every scope is on Default. |
| `dashboard.activeVisibilityGroupingId` | `string` | `'default'` | Legacy scalar — kept written for one release as the dashboard scope's mirror so a downgrade-then-upgrade flow doesn't lose the dashboard's pick. `parsePersistedState` migrates it into `{ dashboard: <id> }` when the new map is absent. |

Six per-project keys that USED to live in `.hotsheet/settings.json` (`visibility_groupings`, `active_visibility_grouping_id`, `hidden_terminals`, `dashboard_layout_mode`, `dashboard_columns_per_row`, `dashboard_slider_value`) are now reserved as **dead keys** in `src/file-settings.ts::HS_8290_DEAD_KEYS`. `readFileSettings` strips them on read, and the next `writeFileSettings` PATCH naturally drops them from disk via the read-merge-write flow. No migration step — per the HS-8290 ticket, existing values are dropped because the feature hasn't gone public.

**Writing.** `src/client/persistedHiddenTerminals.ts` subscribes to every `subscribeToHiddenChanges` fire and PATCHes `dashboard.visibilityGroupings` + `dashboard.activeVisibilityGroupingIdByScope` (HS-8406) + `dashboard.activeVisibilityGroupingId` (legacy mirror of the `'dashboard'` scope) to `/api/global-config` with a 250 ms debounce (single global timer; pre-HS-8290 this was a per-project debounce loop). Dynamic-terminal ids (`dyn-*`) are filtered out at write time. Sorted ids per `hiddenByProject[secret]` keep the serialised payload byte-stable so unchanged sets short-circuit the network call.

**HS-8293 — init is one-shot.** `initPersistedHiddenTerminals` is called once from `initProjectTabs` and bails immediately on subsequent calls (the wired subscription is the marker). Pre-fix `refreshProjectTabs` re-ran it on every poll cycle, which re-fetched `/api/global-config` and re-hydrated the in-memory state. If the user had toggled a row between the moment the previous PATCH landed and the next poll's hydrate fired, the hydrate clobbered the toggle with the (now-stale) server snapshot, and the next debounced write's `lastPersisted` short-circuit suppressed the PATCH that would have rescued it — visible to the user as "fast successive toggles overwrite each other."

**Stale-id cleanup.** `pruneStaleIdsInGroupings(groupings, secret, configuredIds)` (in `src/client/visibilityGroupings.ts`) walks every grouping's `hiddenByProject[secret]` and drops ids that no longer correspond to a configured terminal. Called client-side from `pruneHiddenForProject` whenever a fresh `/terminal/list` round-trip lands. Pre-HS-8290 this lived server-side in `prunedVisibilityGroupings` (file-settings.ts) and fired from the `/file-settings` PATCH handler when `terminals[]` changed; HS-8290 moved it client-side because the data no longer lives per-project on disk.

**HS-7949 follow-up — new terminals default to hidden in non-Default groupings.** `hideNewTerminalInNonDefaultGroupings(secret, terminalId)` in `dashboardHiddenTerminals.ts` runs after a new terminal is registered (settings save / drawer "+"-button). It appends the new id to every non-Default grouping's `hiddenByProject[secret]` so a freshly-added terminal doesn't pop into every named grouping. Default keeps showing it.

## 39.4 Show / Hide Terminals dialog

The dialog has a **tab bar** at the top, between the header and the body:

- **Default tab** — always present, leftmost in fresh installs, uppercase initial-cap label. Cannot be deleted (right-click menu greys the entry).
- **User-added tabs** — created via the trailing **+** button (Lucide `plus` glyph). Clicking the **+** opens a tiny in-app prompt for the new grouping's name.
- **Tab strip is horizontally scrollable.** When the user has many groupings, the strip overflows with a thin scrollbar.
- **Right-click on a tab** → context menu with **Rename…** and **Delete** entries. Rename opens the name prompt with the current name pre-selected; Delete confirms via the in-app `confirmDialog`. Delete is disabled (greyed) on the Default tab.
- **Drag tabs to reorder.** HTML5 drag-and-drop with `.dragging` (0.4 opacity on the dragged tab) + `.drag-over` (leading-edge accent inset) feedback. Default can be moved away from index 0 — its identity is the id, not its position.

Switching tabs flips `globalState.activeId`, fires the change subscription, and re-renders the body. Toggling a row in the body writes against the active grouping's `hiddenByProject[group.secret]` (NOT a flat list). The footer carries paired bulk-toggle buttons:

- **Show All** — clears `hiddenByProject` across every project in the active grouping (one global write — `unhideAllEverywhereInGrouping(activeId)`).
- **Hide All** — hides every terminal currently rendered in the dialog body in the active grouping. Per-project (`hideAllInGrouping(secret, activeId, ids)` per group).

## 39.5 Grouping selector dropdown

When the global state has more than one grouping, a `<select>` appears next to the eye icon in:

- **Dashboard header** — `#terminal-dashboard-grouping-select`.
- **Drawer-grid toolbar** — `#drawer-grid-grouping-select`.

Both dropdowns are populated by `src/client/visibilityGroupingSelect.tsx` (`refreshGroupingSelect` + `wireGroupingSelectChange`). Hidden when `groupings.length === 1` (only Default exists). Picking a different grouping fires `setActiveGrouping(id)`, which triggers the same change subscription that re-renders the dashboard / drawer-grid filter and persists via the global PATCH.

## 39.6 Implementation

- **Pure helpers** (`src/client/visibilityGroupings.ts`): `initialGlobalState`, `generateGroupingId`, `getActiveGrouping`, `getHiddenIdsForProject`, `addGrouping`, `renameGrouping`, `deleteGrouping`, `reorderGroupings`, `setActiveGroupingId`, `toggleHiddenInGrouping`, `updateGroupingById`, `parsePersistedState`, `pruneStaleIdsInGroupings`.
- **In-memory state** (`src/client/dashboardHiddenTerminals.tsx`): refactored from the pre-HS-8290 `Map<secret, ProjectVisibilityState>` to a single global `GlobalVisibilityState`. The pre-HS-7826 public API (`isTerminalHidden`, `setTerminalHidden`, `getHiddenTerminals`, `filterVisible`, `unhideAllInProject`, `unhideAllEverywhere`, `countHiddenForProject`, `countHiddenAcrossAllProjects`) all delegate to the active grouping's `hiddenByProject[secret]` slot, so callers that don't know about groupings keep working. Grouping CRUD (`getGroupings`, `getActiveGroupingId`, `setActiveGrouping`, `addGrouping`, `renameGrouping`, `deleteGrouping`, `reorderGroupings`) takes no `secret` parameter post-HS-8290. Per-grouping toggles (`setTerminalHiddenInGrouping`, `isTerminalHiddenInGrouping`, `unhideAllInGrouping`, `unhideAllEverywhereInGrouping`, `hideAllInGrouping`, `hideNewTerminalInNonDefaultGroupings`, `pruneHiddenForProject`) keep `secret` because they target a specific project's slot inside a grouping. Hydration via `hydratePersistedGlobalState`.
- **Persistence** (`src/client/persistedHiddenTerminals.ts`): hydrates from `/api/global-config` on app boot, writes back via a single global debounced PATCH. Pre-HS-8290 this was a per-project debounce loop hitting `/api/file-settings` for every registered project.
- **Dialog UI** (`src/client/hideTerminalDialog.tsx`): tab bar with `<button class="hide-terminal-tab">` per grouping + `<button class="hide-terminal-tab-add">` plus button at end. Right-click context menu (`showTabContextMenu`) for rename / delete. Tiny in-app prompt for name input (`promptForName`). HS-8290 dropped the `dialogScopes` / `dialogSecret` / `getAdditionalSecrets` cross-project fan-out helpers — every CRUD op is now a single global call.
- **Dropdown helper** (`src/client/visibilityGroupingSelect.tsx`): `refreshGroupingSelect({ selectEl })` rebuilds the `<option>` list and toggles visibility based on count; `wireGroupingSelectChange` attaches a one-time `change` listener that calls `setActiveGrouping`.
- **Dashboard wiring** (`src/client/terminalDashboard.tsx`): single-secret-free invocation of `refreshGroupingSelect` / `wireGroupingSelectChange`. `dashboard.layoutMode` + `dashboard.columnsPerRow` also read from / write to global config (pre-HS-8290 these lived under per-project file-settings).
- **Drawer-grid wiring** (`src/client/drawerTerminalGrid.tsx`): same pattern as dashboard.
- **SCSS** (`src/client/styles.scss`): unchanged — the same selectors apply since the DOM shape didn't change.

## 39.7 Out of scope (deferred)

- **Duplicate grouping affordance** — copy an existing grouping's `hiddenByProject` into a new one. Useful when the user wants a slight variant of an existing setup.
- **Keyboard shortcuts** for switching groupings (e.g. Cmd/Ctrl+1..9 to flip to the Nth tab).
- **Cross-window sync** — when a second Hot Sheet window changes the active grouping, the first window's dropdown only updates after a settings reload. Live cross-window sync would require a long-poll subscription channel.

## 39.8 Manual test plan

See `docs/manual-test-plan.md §13` for the existing flows. HS-8290 adds:

1. Default tab is always present. Right-clicking it → "Delete" entry is disabled / greyed.
2. Click the trailing **+** button → name prompt → confirm with non-empty name → new tab appears + becomes active.
3. Click the new tab → the dialog body shows that grouping's hidden state (initially empty → all visible). Toggling a row writes against this grouping's `hiddenByProject[group.secret]`.
4. Switch back to Default → the Default grouping's hidden state is preserved verbatim.
5. Right-click the new tab → Rename → enter a different name → tab label updates.
6. Right-click the new tab → Delete → confirm → tab disappears, active grouping falls back to Default.
7. Drag a tab to a new position → strip reorders + persists.
8. Reload Hot Sheet → tab bar order, names, and active id all restored from `~/.hotsheet/config.json`.
9. Quit + relaunch — same as reload.
10. Dashboard's eye icon dialog with multiple projects registered. Create a "Servers" grouping, hide a terminal in EACH project. Close the dialog and confirm the dashboard tiles match: the hidden terminals are gone in every project. Pre-HS-8290 this required cross-project fan-out machinery to keep the per-project grouping lists aligned; post-HS-8290 there's one source of truth.
11. Switch the active grouping via the dashboard's `<select>` dropdown → every project's filter swaps together (one global flip).
12. Delete every non-Default grouping → grouping selector disappears.

## 39.9 Cross-references

- §38 (Persisted terminal visibility) — single-grouping precursor; HS-7826 generalised §38's flat `hidden_terminals` shape; HS-8290 lifted both into global config.
- §25.10 (Show / Hide Terminals dialog — global mode).
- §36.6.5 (Show / Hide Terminals dialog — drawer-grid mode).
- §22.10 (per-project terminal config; ids the persistence layer keys against).

**Status:** Shipped (HS-7826 / HS-8290).
