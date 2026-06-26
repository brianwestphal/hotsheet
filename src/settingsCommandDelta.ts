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
