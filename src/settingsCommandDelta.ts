/**
 * HS-9010c / HS-9014 (docs/95 §95.3) — tree-aware element-level local-override
 * delta for the `custom_commands` setting.
 *
 * `custom_commands` is a nested TREE (top-level commands + groups holding child
 * commands), unlike the flat list keys (`custom_views`, `terminals`,
 * `auto_context`) that the {@link file://./settingsDelta.ts} `ArrayDelta` model
 * covers. The flat resolver can't target a child inside a group, so commands get
 * this tree-aware sibling.
 *
 * LOCAL-mode semantics (docs/95 §95.3):
 *  - **Hide** individual shared commands, shared groups, or shared children.
 *  - **Add** local-only commands/groups at the top level…
 *  - …**including adding a local child into a SHARED-defined group** (`childAdded`).
 *  - **Override** a shared command/group's own fields (shallow merge).
 *  - **Orphan survival**: if a shared parent group later disappears, its local
 *    children still survive — materialized into a standalone local group.
 *  - **No order override** (the local layer can't reorder shared items), matching
 *    the flat model.
 *
 * Stable element ids: commands/groups historically had no id (identified by
 * name/position), so `hidden`/`overrides`/`childAdded` couldn't target them
 * across renames/reorders. {@link backfillCommandIds} assigns a uuid to any item
 * lacking one; the client persists the backfilled ids into the shared
 * `settings.json` so the delta always references stable ids.
 *
 * Pure (no fs, no DOM) so it's shared by the server resolve (`file-settings.ts`)
 * and the client editor (`commandEditor.tsx`), and unit-tested in isolation.
 * The canonical command/group types + `isGroup` live here (re-exported from
 * `experimentalSettings.tsx` for back-compat) so this server-safe module owns
 * them without importing the client.
 */

// --- Canonical command tree types (SSOT; re-exported by experimentalSettings) ---

export interface CustomCommand {
  /** HS-9014 — stable id, backfilled on edit so deltas can target this item. */
  id?: string;
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
  target?: 'claude' | 'shell';
  autoShowLog?: boolean;
  launchInNewTerminal?: boolean;
  /** HS-9102 (docs/103 §103.2/§103.4) — marks a Claude command as idempotent /
   *  maintenance-safe so the §103.3 "Run on…" worker picker can fan it out to a
   *  busy worker WITHOUT the §9084 busy-worker confirm (`workerTargetWarning`). */
  workerSafe?: boolean;
}

export interface CommandGroup {
  type: 'group';
  /** HS-9014 — stable id (see {@link CustomCommand.id}). */
  id?: string;
  name: string;
  collapsed?: boolean;
  children: CustomCommand[];
}

export type CommandItem = CustomCommand | CommandGroup;

export function isGroup(item: CommandItem): item is CommandGroup {
  // `'type' in item` fully narrows: `CustomCommand` has no `type` field.
  return 'type' in item;
}

// --- Delta model ---

/** A local child added into a (shared or once-shared) group. Stores the parent
 *  group's `{id,name}` so the child survives the parent disappearing (orphan
 *  survival materializes a local group from this). */
export interface ChildAddition {
  group: { id: string; name: string };
  children: CustomCommand[];
}

/** The local-layer tree delta for `custom_commands`. All fields optional. */
export interface CommandTreeDelta {
  /** Ids of shared top-level items OR shared children to hide. */
  hidden?: string[];
  /** Per-id partial overrides, shallow-merged onto the shared command/group
   *  (a group override carries only its own fields — never `children`). */
  overrides?: Record<string, Partial<CommandItem>>;
  /** Local-only top-level items, appended after the (kept) shared tree. */
  added?: CommandItem[];
  /** Local children injected into a shared group, keyed by the group id. */
  childAdded?: Record<string, ChildAddition>;
}

/** True when `v` is a {@link CommandTreeDelta} (a non-array object carrying at
 *  least one delta field) rather than a plain array or scalar. */
export function isCommandTreeDelta(v: unknown): v is CommandTreeDelta {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    ('hidden' in v || 'added' in v || 'overrides' in v || 'childAdded' in v)
  );
}

/** Stable identity for hide/override/childAdded targeting. An item lacking an id
 *  (not yet backfilled) yields `''`, which matches no delta entry — so it's
 *  always kept as-is. The client guarantees ids before writing any delta. */
function idOf(item: CommandItem): string {
  return typeof item.id === 'string' ? item.id : '';
}

/**
 * Module-level origin map for materialized orphan groups (resolve → compute
 * round-trip). When {@link resolveCommandTreeDelta} synthesizes a local group
 * because its shared parent disappeared, it records the original group id here
 * so {@link computeCommandTreeDelta} re-emits it as a `childAdded` entry rather
 * than a top-level `added` group (which would orphan it again, or duplicate it
 * if the shared group reappears). A `WeakMap` keeps this invisible to JSON and
 * GC-friendly — the resolved objects the client edits in-memory carry the
 * association without polluting the persisted shape. */
const orphanGroupOrigin = new WeakMap<object, string>();

/** Read the original (shared) group id a resolved group was orphaned from, if
 *  this group was materialized by {@link resolveCommandTreeDelta} for orphan
 *  survival. */
export function orphanGroupIdOf(item: CommandItem): string | undefined {
  return orphanGroupOrigin.get(item);
}

function applyOverride<T extends CommandItem>(item: T, override: Partial<CommandItem> | undefined): T {
  return override === undefined ? { ...item } : { ...item, ...override };
}

/** Group override carries only the group's own fields (never `children`); strip
 *  `children` defensively so a malformed override can't smuggle a child list in. */
function groupOwnProps(group: CommandGroup): Partial<CommandGroup> {
  const out: Partial<CommandGroup> = { name: group.name };
  if (group.collapsed !== undefined) out.collapsed = group.collapsed;
  return out;
}

/**
 * Resolve a shared command tree against a local-layer {@link CommandTreeDelta}.
 *
 * Result = shared tree (in shared order) minus `hidden`, each surviving item
 * shallow-merged with its `overrides`, with shared groups gaining any
 * `childAdded` local children appended after their kept shared children; then
 * top-level `added` items; then orphan-survival groups for any `childAdded`
 * whose parent group id is gone from shared.
 *
 * Every returned object is a fresh clone, so the caller can edit the resolved
 * tree without mutating the shared array it's diffed against.
 */
export function resolveCommandTreeDelta(shared: readonly CommandItem[], delta: CommandTreeDelta): CommandItem[] {
  const hidden = new Set(delta.hidden ?? []);
  const overrides = delta.overrides ?? {};
  const childAdded = delta.childAdded ?? {};
  const out: CommandItem[] = [];
  const seenGroupIds = new Set<string>();

  for (const item of shared) {
    const id = idOf(item);
    if (hidden.has(id)) continue;
    if (isGroup(item)) {
      seenGroupIds.add(id);
      const children: CustomCommand[] = [];
      for (const child of item.children) {
        const cid = idOf(child);
        if (hidden.has(cid)) continue;
        children.push(applyOverride(child, overrides[cid]));
      }
      if (id in childAdded) for (const c of childAdded[id].children) children.push({ ...c });
      const merged = applyOverride(item, overrides[id]);
      out.push({ ...merged, children });
    } else {
      out.push(applyOverride(item, overrides[id]));
    }
  }

  for (const item of delta.added ?? []) {
    out.push(isGroup(item) ? { ...item, children: item.children.map(c => ({ ...c })) } : { ...item });
  }

  // Orphan survival: a childAdded group whose id is gone from shared becomes a
  // standalone local group holding its children (tagged via `orphanGroupOrigin`
  // so compute re-emits it as childAdded).
  for (const [gid, add] of Object.entries(childAdded)) {
    if (seenGroupIds.has(gid)) continue;
    const group: CommandGroup = {
      type: 'group',
      id: add.group.id,
      name: add.group.name,
      children: add.children.map(c => ({ ...c })),
    };
    orphanGroupOrigin.set(group, gid);
    out.push(group);
  }

  return out;
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Inverse of {@link resolveCommandTreeDelta}: derive the local delta from an
 * edited tree (what the editor produced in Local mode) against the shared tree.
 *
 *  - A shared top-level item absent from `edited` → `hidden`.
 *  - A shared child absent from its group in `edited` → `hidden`.
 *  - An edited top-level item whose id isn't a shared top-level item → `added`.
 *  - An edited child whose id isn't a shared child of that group → `childAdded`.
 *  - A shared command/group present but changed → `overrides` (full item for a
 *    command; own-props only for a group).
 *  - A resolved orphan group (tagged by resolve) → re-emitted as `childAdded`.
 *
 * Order is not captured (the local layer can't reorder shared items). Empty
 * fields are omitted so a no-change edit yields `{}`.
 */
export function computeCommandTreeDelta(shared: readonly CommandItem[], edited: readonly CommandItem[]): CommandTreeDelta {
  const sharedTop = new Map<string, CommandItem>();
  const sharedGroupChildren = new Map<string, Map<string, CustomCommand>>();
  for (const item of shared) {
    const id = idOf(item);
    sharedTop.set(id, item);
    if (isGroup(item)) {
      const m = new Map<string, CustomCommand>();
      for (const ch of item.children) m.set(idOf(ch), ch);
      sharedGroupChildren.set(id, m);
    }
  }

  const hidden: string[] = [];
  const overrides: Record<string, Partial<CommandItem>> = {};
  const added: CommandItem[] = [];
  const childAdded: Record<string, ChildAddition> = {};
  const editedTopIds = new Set<string>();
  const seenSharedChildIds = new Set<string>();

  for (const item of edited) {
    const id = idOf(item);

    // Materialized orphan group → re-emit as childAdded under its origin id.
    const orphanOrigin = isGroup(item) ? orphanGroupIdOf(item) : undefined;
    if (isGroup(item) && orphanOrigin !== undefined) {
      childAdded[orphanOrigin] = {
        group: { id: item.id ?? orphanOrigin, name: item.name },
        children: item.children.map(c => ({ ...c })),
      };
      continue;
    }

    const sharedItem = sharedTop.get(id);

    if (isGroup(item) && sharedItem !== undefined && isGroup(sharedItem)) {
      // A kept shared group: diff its own props + its children.
      editedTopIds.add(id);
      if (!jsonEq(groupOwnProps(sharedItem), groupOwnProps(item))) overrides[id] = groupOwnProps(item);
      const sharedChildren = sharedGroupChildren.get(id) ?? new Map<string, CustomCommand>();
      const localChildren: CustomCommand[] = [];
      for (const ch of item.children) {
        const cid = idOf(ch);
        const sharedChild = sharedChildren.get(cid);
        if (sharedChild !== undefined) {
          seenSharedChildIds.add(cid);
          if (!jsonEq(sharedChild, ch)) overrides[cid] = ch;
        } else {
          localChildren.push({ ...ch });
        }
      }
      if (localChildren.length > 0) childAdded[id] = { group: { id, name: item.name }, children: localChildren };
    } else if (sharedItem !== undefined && !isGroup(sharedItem) && !isGroup(item)) {
      // A kept shared top-level command.
      editedTopIds.add(id);
      if (!jsonEq(sharedItem, item)) overrides[id] = item;
    } else {
      // Local-only top-level item (command or group), OR a type mismatch with a
      // shared item of the same id — treat as a fresh local addition.
      added.push(item);
    }
  }

  // Hidden: shared top-level items not present in edited.
  for (const [id, item] of sharedTop) {
    if (editedTopIds.has(id)) continue;
    hidden.push(id);
    void item;
  }
  // Hidden: shared children of KEPT shared groups that vanished from edited.
  for (const [gid, children] of sharedGroupChildren) {
    if (!editedTopIds.has(gid)) continue; // whole group hidden — covered above
    for (const cid of children.keys()) {
      if (!seenSharedChildIds.has(cid)) hidden.push(cid);
    }
  }

  const delta: CommandTreeDelta = {};
  if (hidden.length > 0) delta.hidden = hidden;
  if (Object.keys(overrides).length > 0) delta.overrides = overrides;
  if (added.length > 0) delta.added = added;
  if (Object.keys(childAdded).length > 0) delta.childAdded = childAdded;
  return delta;
}

// --- Shared ↔ Local layer moves (HS-9014, maintainer request 2026-06-25) ---

/** The two layer files a move edits together. */
export interface CommandLayers {
  /** The committed shared tree (`settings.json` `custom_commands`). */
  shared: CommandItem[];
  /** The local delta (`settings.local.json` `custom_commands`). */
  delta: CommandTreeDelta;
}

function cloneCommandItem(item: CommandItem): CommandItem {
  return isGroup(item) ? { ...item, children: item.children.map(c => ({ ...c })) } : { ...item };
}

function cloneDelta(delta: CommandTreeDelta): CommandTreeDelta {
  const out: CommandTreeDelta = {};
  if (delta.hidden !== undefined) out.hidden = [...delta.hidden];
  if (delta.added !== undefined) out.added = delta.added.map(cloneCommandItem);
  if (delta.overrides !== undefined) out.overrides = { ...delta.overrides };
  if (delta.childAdded !== undefined) {
    const childAdded: Record<string, ChildAddition> = {};
    for (const [k, v] of Object.entries(delta.childAdded)) {
      childAdded[k] = { group: { ...v.group }, children: v.children.map(c => ({ ...c })) };
    }
    out.childAdded = childAdded;
  }
  return out;
}

/** Return a copy of `record` without `key` (avoids `delete` on a computed key). */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _dropped, ...rest } = record;
  void _dropped;
  return rest;
}

/**
 * Move a SHARED top-level command/group into the LOCAL layer ("make this
 * local-only"): drop it from the shared tree and add it as a local addition, so
 * the resolved list still contains it (now appended among the local items — the
 * local layer can't reorder, so it joins the bottom) but it's no longer
 * committed. A moved group brings its shared children + any `childAdded` local
 * children together as one local group. No-op if `id` isn't a shared top-level
 * item. Pure — returns the new layer pair.
 */
export function moveTopLevelToLocal(layers: CommandLayers, id: string): CommandLayers {
  const idx = layers.shared.findIndex(i => idOf(i) === id);
  if (idx < 0) return layers;
  const item = layers.shared[idx];
  const shared = layers.shared.filter((_, i) => i !== idx);
  const delta = cloneDelta(layers.delta);

  // Drop any delta entries that targeted the now-removed shared item.
  if (delta.hidden !== undefined) delta.hidden = delta.hidden.filter(h => h !== id);
  if (delta.overrides !== undefined) delta.overrides = omitKey(delta.overrides, id);

  let localItem: CommandItem;
  if (isGroup(item)) {
    // Fold the group's shared children (each with its override applied + minus
    // hidden) plus any local children added into it, into one local group.
    const hidden = new Set(delta.hidden ?? []);
    const overrides = delta.overrides ?? {};
    const children: CustomCommand[] = [];
    for (const ch of item.children) {
      const cid = idOf(ch);
      if (hidden.has(cid)) continue;
      children.push(applyOverride(ch, overrides[cid]));
      if (delta.hidden !== undefined) delta.hidden = delta.hidden.filter(h => h !== cid);
      if (delta.overrides !== undefined) delta.overrides = omitKey(delta.overrides, cid);
    }
    if (delta.childAdded !== undefined && id in delta.childAdded) {
      for (const c of delta.childAdded[id].children) children.push({ ...c });
      delta.childAdded = omitKey(delta.childAdded, id);
    }
    localItem = { ...item, children };
  } else {
    localItem = { ...item };
  }

  delta.added = [...(delta.added ?? []), localItem];
  return { shared, delta: pruneDelta(delta) };
}

/**
 * Move a LOCAL-only top-level command/group into the SHARED layer ("promote to
 * shared"): append it to the shared tree and drop it from the local delta's
 * `added`. No-op if `id` isn't a local top-level addition. Pure.
 */
export function moveTopLevelToShared(layers: CommandLayers, id: string): CommandLayers {
  const added = layers.delta.added ?? [];
  const idx = added.findIndex(i => idOf(i) === id);
  if (idx < 0) return layers;
  const item = added[idx];
  const delta = cloneDelta(layers.delta);
  delta.added = added.filter((_, i) => i !== idx);
  const shared = [...layers.shared, isGroup(item) ? { ...item, children: item.children.map(c => ({ ...c })) } : { ...item }];
  return { shared, delta: pruneDelta(delta) };
}

/**
 * HS-9094 — move a SHARED child command (one living in a shared group's
 * `children`) into the LOCAL layer: physically remove it from the shared group
 * (so it leaves `settings.json`, like the top-level move) and add it as a local
 * `childAdded` child of the same group. The resolved group still contains it
 * (now appended among the group's local children — no reorder), but it's no
 * longer committed. No-op if `childId` isn't a shared child. Pure.
 */
export function moveChildToLocal(layers: CommandLayers, childId: string): CommandLayers {
  // Locate the parent group + the child (plain for-loop so the narrowing is
  // tracked — a `.map` closure assignment would not be).
  let found: { group: CommandGroup; child: CustomCommand } | undefined;
  for (const item of layers.shared) {
    if (!isGroup(item)) continue;
    const child = item.children.find(c => idOf(c) === childId);
    if (child !== undefined) { found = { group: item, child }; break; }
  }
  if (found === undefined) return layers;
  const gid = idOf(found.group);
  const movedChild = found.child;

  const shared = layers.shared.map((item): CommandItem =>
    isGroup(item) && idOf(item) === gid
      ? { ...item, children: item.children.filter(c => idOf(c) !== childId) }
      : item);

  const delta = cloneDelta(layers.delta);
  // Defensively drop any delta entries that targeted the now-removed shared child.
  if (delta.hidden !== undefined) delta.hidden = delta.hidden.filter(h => h !== childId);
  if (delta.overrides !== undefined) delta.overrides = omitKey(delta.overrides, childId);

  const childAdded = delta.childAdded ?? {};
  childAdded[gid] = gid in childAdded
    ? { group: childAdded[gid].group, children: [...childAdded[gid].children, { ...movedChild }] }
    : { group: { id: gid, name: found.group.name }, children: [{ ...movedChild }] };
  delta.childAdded = childAdded;
  return { shared, delta: pruneDelta(delta) };
}

/**
 * HS-9094 — move a LOCAL `childAdded` child into the SHARED layer: append it to
 * its parent shared group's `children` and drop it from the local delta. No-op
 * if `childId` isn't a local child addition, or its parent group is gone from
 * shared (an orphaned local group can't be promoted child-by-child). Pure.
 */
export function moveChildToShared(layers: CommandLayers, childId: string): CommandLayers {
  const delta = cloneDelta(layers.delta);
  const childAdded = delta.childAdded ?? {};
  let groupId: string | null = null;
  let child: CustomCommand | null = null;
  for (const [gid, add] of Object.entries(childAdded)) {
    const idx = add.children.findIndex(c => idOf(c) === childId);
    if (idx >= 0) { groupId = gid; child = add.children[idx]; break; }
  }
  if (groupId === null || child === null) return layers;
  // The parent group must still exist in shared to receive the child.
  const sharedGroupIdx = layers.shared.findIndex(i => idOf(i) === groupId && isGroup(i));
  if (sharedGroupIdx < 0) return layers;
  const movedChild: CustomCommand = child;
  const gid: string = groupId;

  // Remove from childAdded (drop the entry when it empties).
  const remaining = childAdded[gid].children.filter(c => idOf(c) !== childId);
  delta.childAdded = remaining.length > 0
    ? { ...childAdded, [gid]: { group: childAdded[gid].group, children: remaining } }
    : omitKey(childAdded, gid);

  const shared = layers.shared.map((item, i): CommandItem => {
    if (i !== sharedGroupIdx || !isGroup(item)) return item;
    return { ...item, children: [...item.children, { ...movedChild }] };
  });
  return { shared, delta: pruneDelta(delta) };
}

/** Drop empty delta fields so a fully-reconciled delta serializes as `{}`. */
function pruneDelta(delta: CommandTreeDelta): CommandTreeDelta {
  const out: CommandTreeDelta = {};
  if (delta.hidden !== undefined && delta.hidden.length > 0) out.hidden = delta.hidden;
  if (delta.overrides !== undefined && Object.keys(delta.overrides).length > 0) out.overrides = delta.overrides;
  if (delta.added !== undefined && delta.added.length > 0) out.added = delta.added;
  if (delta.childAdded !== undefined && Object.keys(delta.childAdded).length > 0) out.childAdded = delta.childAdded;
  return out;
}

/** Generate a stable element id. `crypto.randomUUID` exists in the browser
 *  (incl. Tauri's WKWebView) and Node 20; the fallback keeps non-secure-context
 *  edge cases working. */
function genId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `cmd-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Assign a stable id to any command/group (and child) lacking one. Returns the
 * (possibly new) tree + whether anything changed, so the caller can persist the
 * backfilled ids into the shared `settings.json` only when needed. Idempotent:
 * a second pass over a fully-id'd tree returns `changed: false` and the same ids.
 */
/**
 * HS-8857 — strip the stable ids off a command tree (item + any group children),
 * so a tree pasted/imported from ANOTHER project can't collide with the current
 * project's ids. The caller runs {@link backfillCommandIds} afterward to assign
 * fresh, unique ids. Pure — returns new objects, leaves the input untouched.
 */
export function stripCommandTreeIds(items: readonly CommandItem[]): CommandItem[] {
  return items.map((item): CommandItem => isGroup(item)
    ? { ...item, id: undefined, children: item.children.map(c => ({ ...c, id: undefined })) }
    : { ...item, id: undefined });
}

export function backfillCommandIds(items: readonly CommandItem[]): { items: CommandItem[]; changed: boolean } {
  let changed = false;
  const out = items.map((item): CommandItem => {
    let next = item;
    if (next.id === undefined || next.id === '') {
      next = { ...next, id: genId() };
      changed = true;
    }
    if (isGroup(next)) {
      const prevChildren = next.children;
      const children = prevChildren.map((ch): CustomCommand =>
        ch.id === undefined || ch.id === '' ? { ...ch, id: genId() } : ch);
      if (children.some((c, i) => c !== prevChildren[i])) {
        next = { ...next, children };
        changed = true;
      }
    }
    return next;
  });
  return { items: out, changed };
}
