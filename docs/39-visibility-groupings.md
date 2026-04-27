# 39. Visibility groupings (HS-7826)

## 39.1 Overview

The Show / Hide Terminals dialog (§25.10.6 / §36.6.5) and the persistence layer added in §38 (HS-7825) treat hidden state as **one** flat list per project. That works when a user has a single mental model — "these are the terminals I don't want to see." It breaks down when the user has multiple competing contexts: maybe the user wants a "claude only" view to focus on a coding session, a "server logs" view to triage a deploy, a "single app" view to keep one project front-and-center. Pre-HS-7826 the only option was to keep toggling rows back and forth as the focus changed.

HS-7826 introduces named **visibility groupings**. Each grouping carries its own `hiddenIds` array and the user switches between them via a tab bar in the dialog and (when more than one grouping exists) a dropdown next to the eye icon in the dashboard / drawer-grid toolbar. The active grouping drives the dashboard / drawer-grid filter. State is per-project and persisted across app launches alongside the existing `hidden_terminals` shape.

## 39.2 Data model

A grouping is `{ id, name, hiddenIds }`. Each project carries a list of groupings + an active id. The Default grouping is always present, identifiable by the literal id `'default'`, and refused for deletion (rename works since the id is the invariant — name is just a label).

```ts
interface VisibilityGrouping {
  id: string;          // 'default' for the Default tab; `g-…` for user-added
  name: string;        // display name shown in the tab bar + dropdown
  hiddenIds: string[]; // configured terminal ids hidden in this grouping
}

interface ProjectVisibilityState {
  groupings: VisibilityGrouping[];
  activeId: string;
}
```

Pure helpers in `src/client/visibilityGroupings.ts` (`addGrouping`, `renameGrouping`, `deleteGrouping`, `reorderGroupings`, `setActiveGroupingId`, `toggleHiddenInGrouping`, `parsePersistedState`, `pruneStaleIdsInGroupings`) own every state transition. 42 unit tests in `visibilityGroupings.test.ts`.

## 39.3 Persistence

Two new keys per project in `.hotsheet/settings.json` (both added to `JSON_VALUE_KEYS` in `src/file-settings.ts`):

| Key | Type | Default | Notes |
|---|---|---|---|
| `visibility_groupings` | `VisibilityGrouping[]` | `[{ id: 'default', name: 'Default', hiddenIds: [] }]` | One entry per grouping, displayed in array order. |
| `active_visibility_grouping_id` | `string` | `'default'` | Id of the currently-active grouping. |

**Backward compatibility.** `hidden_terminals` (HS-7825) is still written to settings.json — it mirrors the *active* grouping's `hiddenIds` so an older client reading the same settings.json continues to see the user's filter. Migration on first read: when `visibility_groupings` is absent but `hidden_terminals` is present, the persistence layer synthesises a single Default grouping seeded with the legacy ids (`parsePersistedState` handles the merge).

**Writing.** `src/client/persistedHiddenTerminals.ts` subscribes to every `subscribeToHiddenChanges` fire and PATCHes the new shape (groupings + active id + legacy mirror) with a 250 ms debounce per project. Dynamic-terminal ids (`dyn-*`) are filtered out at write time. Sorted hiddenIds keep the serialised payload byte-stable so unchanged sets short-circuit the network call.

**Stale-id cleanup.** `prunedVisibilityGroupings(currentGroupings, configuredIds)` in `src/file-settings.ts` walks every grouping's `hiddenIds` and strips ids that no longer correspond to a configured terminal — same idea as `prunedHiddenTerminals` from HS-7829, generalised across groupings. The `/file-settings` PATCH handler runs both helpers whenever `terminals[]` changes, so deleting a configured terminal cleans every grouping in one shot.

## 39.4 Show / Hide Terminals dialog (HS-7826 changes)

The dialog gains a **tab bar** at the top, between the header and the body:

- **Default tab** — always present, leftmost in fresh projects, uppercase initial-cap label. Cannot be deleted (right-click menu greys the entry).
- **User-added tabs** — created via the trailing **+** button (Lucide `plus` glyph). Clicking the **+** opens a tiny in-app prompt for the new grouping's name.
- **Tab strip is horizontally scrollable.** When the user has many groupings, the strip overflows with a thin scrollbar; the **+** button scrolls with the tabs.
- **Right-click on a tab** → context menu with **Rename…** and **Delete** entries. Rename opens the same name prompt with the current name pre-selected; Delete confirms via the in-app `confirmDialog`. Delete is disabled (greyed) on the Default tab.
- **Drag tabs to reorder.** HTML5 drag-and-drop with `.dragging` (0.4 opacity on the dragged tab) + `.drag-over` (leading-edge accent inset) feedback. Default can be moved away from index 0 — its identity is the id, not its position.

Switching tabs flips `state.activeId` for the project, fires the change subscription, and re-renders the body to reflect the new grouping's `hiddenIds`. Toggling a row in the body writes against the active grouping's `hiddenIds`, NOT the legacy flat shape. The "Show all in this grouping" footer button (renamed from "Show all" in HS-7661) clears the *active* grouping only — other groupings are untouched.

## 39.5 Grouping selector dropdown

When a project has more than one grouping, a `<select>` element appears next to the eye icon in:

- **Dashboard header** — `#terminal-dashboard-grouping-select`. Scope: the first project in registered order (groupings are per-project, so cross-project mode picks one canonical project for the dropdown — typically the active project or the first registered one).
- **Drawer-grid toolbar** — `#drawer-grid-grouping-select`. Scope: the active project.

Both dropdowns are populated by `src/client/visibilityGroupingSelect.ts` (`refreshGroupingSelect` + `wireGroupingSelectChange`). Hidden when `groupings.length === 1` (only Default exists) per the ticket: "when there are multiple visibility groupings, show a dropdown menu". Picking a different grouping fires `setActiveGroupingForProject`, which in turn triggers the same change subscription that re-renders the dashboard / drawer-grid filter.

## 39.6 Implementation

- **Pure helpers** (`src/client/visibilityGroupings.ts`): `initialProjectState`, `generateGroupingId`, `getActiveGrouping`, `addGrouping`, `renameGrouping`, `deleteGrouping`, `reorderGroupings`, `setActiveGroupingId`, `toggleHiddenInGrouping`, `updateGroupingById`, `parsePersistedState`, `pruneStaleIdsInGroupings`. 42 unit tests.
- **In-memory state** (`src/client/dashboardHiddenTerminals.ts`): refactored from the pre-HS-7826 flat `Map<secret, Set<terminalId>>` to a `Map<secret, ProjectVisibilityState>`. The pre-HS-7826 public API (`isTerminalHidden`, `setTerminalHidden`, `getHiddenTerminals`, `filterVisible`, `unhideAllInProject`, `unhideAllEverywhere`, `countHiddenForProject`, `countHiddenAcrossAllProjects`) all delegate to the active grouping, so callers that don't know about groupings keep working. New exports (`getGroupings`, `getActiveGroupingId`, `setActiveGroupingForProject`, `addGroupingForProject`, `renameGroupingForProject`, `deleteGroupingForProject`, `reorderGroupingsForProject`, `setTerminalHiddenInGrouping`, `isTerminalHiddenInGrouping`, `unhideAllInGrouping`, `hydratePersistedStateForProject`) drive the new dialog UI + persistence layer.
- **Persistence** (`src/client/persistedHiddenTerminals.ts`): hydrates from the new shape on app boot, falls back to `parsePersistedState`'s legacy migration when only `hidden_terminals` is present. Writes the new shape + legacy mirror in a single PATCH per debounce window.
- **Dialog UI** (`src/client/hideTerminalDialog.tsx`): tab bar with `<button class="hide-terminal-tab">` per grouping + `<button class="hide-terminal-tab-add">` plus button at end. Right-click context menu (`showTabContextMenu`) for rename / delete. Tiny in-app prompt for name input (`promptForName`).
- **Dropdown helper** (`src/client/visibilityGroupingSelect.ts`): `refreshGroupingSelect({ selectEl, getSecret })` rebuilds the `<option>` list and toggles visibility based on count; `wireGroupingSelectChange` attaches a one-time `change` listener.
- **Dashboard wiring** (`src/client/terminalDashboard.tsx`): `groupingSelect` element ref, `refreshDashboardGroupingSelect()` helper called from the change subscription + on dedicated-view exit. Hidden alongside other chrome on dedicated view.
- **Drawer-grid wiring** (`src/client/drawerTerminalGrid.tsx`): same pattern — `groupingSelect` ref, `refreshDrawerGroupingSelect()` helper called from the change subscription + `showGridChrome()`. Hidden by `hideGridChrome()`.
- **SCSS** (`src/client/styles.scss`): `.hide-terminal-dialog-tabs`, `.hide-terminal-tab` (+ `.is-active`, `.dragging`, `.drag-over`), `.hide-terminal-tab-label`, `.hide-terminal-tab-add`, `.context-menu-item.is-disabled`, `.grouping-prompt-overlay` + dialog, `.terminal-dashboard-grouping-select`, `.drawer-grid-grouping-select`.

## 39.7 Cross-project fan-out (HS-7826 follow-up)

Original v1 stored per-project state and the dialog wrote everything against the FIRST project's groupings (`dialogScope`). When the dashboard's eye icon opens the dialog in `'global'` mode (every project's terminals together), that meant a hide-toggle on a row from any project but the first wrote into the wrong project's state — the dashboard's per-project filter (`filterVisible(secret, …)`) reads each project's OWN active grouping, so the dialog said "hidden" while the dashboard kept showing the tile (the user-reported HS-7826 follow-up: "terminal visibility doesn't match what's described in dialog").

The dialog now treats grouping CRUD operations as cross-project fan-out and routes visibility toggles to the terminal's actual project:

- **`dialogScopes(opts)`** — deduplicated list of every secret in `opts.groups`. In `'single-project'` mode this is one secret; in `'global'` mode it's every project on the dashboard.
- **Add grouping** — `generateGroupingIdAcrossProjects(scopes)` mints one id that doesn't collide in any scope; `addGroupingForProjectWithId(secret, id, name)` is then called for every scope. The shared id is what makes `setActiveGroupingForProject` (also fanned out) consistent across projects.
- **Rename / delete / reorder grouping** — fanned out across every scope so the per-project tab order, names, and grouping list stay aligned.
- **Activate grouping** (tab click + dropdown change) — fanned out across every scope. The dashboard's `<select>` wiring uses the new `getAdditionalSecrets` callback in `GroupingSelectOptions` to pick up every other section's project.
- **Toggle visibility row** — uses `group.secret` (the terminal's own project) instead of `dialogScope`, so the toggle lands in the correct per-project grouping.
- **Show all in this grouping** — fanned out, so the footer button empties the active grouping in every project (consistent with the dashboard's cross-project view).

The persistence layer is unchanged — each project still serialises its own `visibility_groupings` + `active_visibility_grouping_id` keys. The fan-out happens in the in-memory state layer and the dialog logic, not in the file shape. New tests in `dashboardHiddenTerminals.test.ts` (`generateGroupingIdAcrossProjects`, `addGroupingForProjectWithId` idempotence, the cross-project "active id stays aligned" + "toggle on terminal's own project" cases) plus the `addGroupingWithId` cases in `visibilityGroupings.test.ts` lock down the regression.

`'single-project'` mode (drawer-grid eye icon) is functionally unchanged — `dialogScopes` returns one entry and the fan-out reduces to a single-project call. The drawer-grid's `<select>` wiring doesn't pass `getAdditionalSecrets`, so its change handler still flips only the active project.

## 39.8 Out of scope (deferred)

- **Duplicate grouping affordance** — copy an existing grouping's hiddenIds into a new one. Useful when the user wants a slight variant of an existing setup. Tracked as a follow-up.
- **Keyboard shortcuts** for switching groupings (e.g. Cmd/Ctrl+1..9 to flip to the Nth tab).
- **Cross-window sync** — when a second Hot Sheet window changes the active grouping, the first window's dropdown only updates after a settings reload. Live cross-window sync would require a long-poll subscription channel (out of scope for v1).

## 39.9 Manual test plan

See [docs/manual-test-plan.md §13 (Show / Hide Terminals dialog)] for the existing flows. HS-7826 adds:

1. Default tab is always present. Right-clicking it → "Delete" entry is disabled / greyed.
2. Click the trailing **+** button → name prompt → confirm with non-empty name → new tab appears + becomes active.
3. Click the new tab → the dialog body shows that grouping's hidden state (initially empty → all visible). Toggling a row writes against this grouping's `hiddenIds` only.
4. Switch back to Default → the Default grouping's hidden state is preserved verbatim (was untouched while the user was on the new tab).
5. Right-click the new tab → Rename → enter a different name → tab label updates.
6. Right-click the new tab → Delete → confirm → tab disappears, active grouping falls back to Default.
7. Drag a tab to a new position → strip reorders + persists.
8. Reload Hot Sheet → tab bar order, names, and active id all restored.
9. Quit + relaunch Hot Sheet → same as reload above.
10. **Cross-project fan-out (HS-7826 follow-up)** — open the dashboard's eye icon dialog with multiple projects registered. Create a "Servers" grouping, click the new tab, then hide a terminal in EACH project. Close the dialog and confirm the dashboard tiles match the dialog: the hidden Claude / app terminals are gone in every project. Pre-fix, only the FIRST project's hidden state was honoured; everything else stayed visible.
11. Same flow but switch the active grouping via the dashboard's `<select>` dropdown — every project's filter should swap together.
10. Create a second grouping → grouping selector dropdown appears next to the eye icon (dashboard + drawer-grid). Pick a grouping in the dropdown → dashboard / drawer-grid filter updates.
11. Delete every non-Default grouping → grouping selector disappears.
12. Delete a configured terminal in Settings → Terminal → check `.hotsheet/settings.json`: the deleted id is gone from EVERY grouping's `hiddenIds`, not just `hidden_terminals`.

## 39.9 Cross-references

- §38 (Persisted terminal visibility) — single-grouping precursor; HS-7826 generalises §38's flat `hidden_terminals` shape.
- §25.10 (Show / Hide Terminals dialog — global mode).
- §36.6.5 (Show / Hide Terminals dialog — drawer-grid mode).
- §22.10 (per-project terminal config; ids the persistence layer keys against).

**Status:** Shipped (HS-7826).
