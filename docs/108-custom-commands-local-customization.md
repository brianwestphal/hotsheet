# 108. Local Customization for Custom Commands (group-aware)

**Status: SHIPPED** (HS-9014 / HS-9010c, 2026-06-26). The "group-aware" sibling of
the element-level local-override work in [95-settings-sharing-classification.md](95-settings-sharing-classification.md)
§95.3. The flat list editors (`custom_views`, `terminals`, `auto_context`) share
the `ArrayDelta` model (`src/settingsDelta.ts`); `custom_commands` is a nested
**tree** (top-level commands + groups holding child commands) that the flat model
can't target, so it gets its own **tree-aware** delta + resolver.

The Custom Commands editor (Settings → Experimental) now participates in the
dialog-wide **Shared | Local overrides | Resolved** scope control (§95 / docs/2
§2.3.1) at element granularity, and supports moving a command/group between the
shared and local layers.

## 108.1 What Local mode can do (docs/95 §95.3, maintainer-specified)

In **Local** mode the local layer (`settings.local.json`) holds a *delta*, not a
whole-array replacement:

- **Hide** individual shared commands, shared groups, or shared children
  (per-machine; the shared/committed tree is untouched).
- **Add** local-only commands/groups at the top level…
- …**including adding a local child into a SHARED-defined group** (`childAdded`).
- **Override** a shared command/group's own fields (shallow merge).
- **Orphan survival**: if a shared parent group later disappears from
  `settings.json`, its local children still survive — materialized into a
  standalone local group.
- **No order override** — the local layer can't reorder shared items. Resolved
  order = shared items in shared order (minus hidden, each with its override),
  shared groups gaining their `childAdded` children after their kept shared
  children, then top-level local additions, then orphan-survival groups.

**Shared** mode edits the committed `settings.json` tree directly. **Resolved**
mode edits the effective tree and routes writes to the default (shared) layer —
exactly the pre-scope-control behavior.

## 108.2 Stable element ids

Commands/groups historically had no id (identified by name/position), so a delta
couldn't target them across renames/reorders. Every command/group now carries an
optional `id`; `backfillCommandIds` (`src/settingsCommandDelta.ts`) assigns a
uuid to any item lacking one, and the editor **persists** the backfilled ids into
the shared `settings.json` on load (idempotent). A delta is only ever written
after ids exist, so `hidden`/`overrides`/`childAdded` always reference stable ids.

## 108.3 Delta model

The local `custom_commands` value is a `CommandTreeDelta`:

```
interface CommandTreeDelta {
  hidden?: string[];                       // shared top-level OR child ids to hide
  overrides?: Record<string, Partial<CommandItem>>;  // by id (group override = own fields only)
  added?: CommandItem[];                   // local-only top-level items
  childAdded?: Record<string, {            // local children into a shared group, keyed by group id
    group: { id: string; name: string };   // the parent's {id,name} — survives the parent disappearing
    children: CustomCommand[];
  }>;
}
```

Pure functions in `src/settingsCommandDelta.ts` (server-safe, no fs/DOM — shared
by the server resolve + the client editor, unit-tested in isolation):

- `resolveCommandTreeDelta(shared, delta)` → the effective tree.
- `computeCommandTreeDelta(shared, edited)` → the inverse (what the editor saves
  in Local mode). A materialized orphan group is tagged via a module `WeakMap`
  (`orphanGroupIdOf`) so it round-trips back to `childAdded`, not a top-level
  `added` group.
- `isCommandTreeDelta` — the strict gate (object carrying ≥1 delta field).
- `backfillCommandIds` — id assignment.
- `moveTopLevelToLocal` / `moveTopLevelToShared` — the two-layer moves (§108.5).

## 108.4 Wiring

- **Server**: `readFileSettings` (`src/file-settings.ts`) resolves `custom_commands`
  with a dedicated tree-aware branch when the local value is a tree delta (strict
  delta-object gate — a plain-array / absent local is left untouched, preserving
  legacy whole-replacement + stringified-array shapes; a **true no-op until the
  editor writes a delta**). `custom_commands` is intentionally NOT in the flat
  `DELTA_LIST_KEYS`.
- **Client**: `experimentalSettings.tsx` holds the scope-aware editing state.
  `loadScopedCommands` derives the mode-specific tree (+ id backfill);
  `saveCommandItems` routes per mode (Shared writes the tree; Local writes the
  computed delta, *clearing* the local key when the delta is empty so an empty
  `{}` can't wipe commands; Resolved unchanged). The editor's working tree
  (`editTree`) is decoupled from the sidebar's effective tree (`commandItems`):
  in Resolved mode they're the same array; in Shared/Local mode the sidebar is
  refreshed from the server's resolved view after each save
  (`refreshSidebarFromResolved`) and on dialog close
  (`refreshCommandsAfterDialogClose`).
- **Editor UI** (`commandEditor.tsx`): per-row origin tags (shared/local) + a
  scope hint banner; in Local mode a shared item's delete is an **eye-off "Hide
  on this machine"** button (HS-9183 — not a trash delete; resolves to a `hidden`
  delta entry), and the hidden command then renders as a **dimmed `.cmd-outline-row-hidden`
  row with an eye "restore" button** (`getHiddenSharedCommands` computes the hidden
  set LIVE as the shared ids absent from `editTree`, so a just-hidden command shows
  immediately; `unhideCommand` drops the id from the local delta's `hidden`). This
  mirrors the custom-views (§107) + terminals hide/show affordance. The `#settings-commands-list`
  container is no longer locked via `data-scope-complex` (it's element-level
  scope-aware).

## 108.5 Move between layers (maintainer request)

A per-row **shared↔local move** (top-level commands/groups):

- **Move to Local** ("make this machine-only"): drop the item from `settings.json`
  and add it as a local addition, so the resolved list still contains it (now
  appended among the local items — the local layer can't reorder, so it joins the
  bottom) but it's no longer committed. A moved group folds its shared children +
  any `childAdded` local children into one local group.
- **Move to Shared** ("promote to shared"): append a local-only item to the shared
  tree and drop it from the local delta's `added`.

**Child-level move (HS-9094):** the same two directions for an individual command
inside a group — `moveChildToLocal` physically removes the child from its shared
group (it leaves `settings.json`) and adds it as a local `childAdded` child of the
same group; `moveChildToShared` appends a local `childAdded` child into its parent
shared group's `children` and drops it from the delta (no-op if the parent group
is gone from shared — an orphan can't be promoted child-by-child). The editor's
move button shows on child rows too; `moveCommandLayer(id, direction, 'child')`
routes to these.

`moveCommandLayer` edits both layer files in one action, then reloads the editor
+ refreshes the sidebar.

## 108.6 Follow-ups (not in this build)

- *(done — HS-9094)* Child-level shared↔local move shipped (see §108.5).

## 108.8 Group collapse is per-device (HS-9095)

Sidebar group-collapse is a **per-machine display preference**, so it does NOT
ride on the command tree (which would force a wholesale shared write that leaks a
local delta). It's stored in `localStorage` via `src/client/commandGroupCollapse.ts`
(`isGroupCollapsed`/`setGroupCollapsed`, keyed `${secret}::${groupId-or-name}`),
reads falling back to a group's legacy `collapsed` field for migration. The
sidebar no longer writes `custom_commands` on collapse (`saveCommandItemsExternal`
removed). Tests: `commandGroupCollapse.test.ts` + an `e2e/commands.spec.ts` case
asserting collapse leaves `settings.json` byte-identical and survives a reload.

## 108.7 Tests

- **Unit** (`src/settingsCommandDelta.test.ts`): hide top-level / group / child,
  override round-trip, group-scoped add, **orphaned-parent-group survival**,
  id-backfill idempotence, both moves (incl. group-fold + promote round-trip).
- **Server resolve** (`src/file-settings.test.ts`): a local tree delta resolves
  (hide/override/group-add); a plain-array local is left untouched.
- **e2e** (`e2e/settings-sharing.spec.ts`): Local mode hides a shared command +
  the delta lands in `settings.local.json` while `settings.json` is unchanged.
