/**
 * HS-9010a (HS-9012, docs/95 §95.3) — element-level local-override delta model
 * for the complex list settings (`custom_views`, `terminals`, `auto_context`;
 * `custom_commands` gets a tree-aware variant in HS-9010c/HS-9014).
 *
 * The HS-9002 shared/local split resolves most keys as "local wins the whole
 * key". For these list editors that's too coarse — a person wants to hide one
 * shared item or add a local-only one without forking the whole array. So the
 * LOCAL layer may instead hold an {@link ArrayDelta}: a set of shared-item ids
 * to hide, per-item field overrides, and local-only additions. The resolved
 * list is the shared array (in shared order, minus hidden, each shallow-merged
 * with its override) followed by the local additions (in local order) — i.e.
 * **reordering is per-layer; the local layer can't reorder shared items**.
 *
 * Pure (no fs, no DOM) so it's shared by the server resolve (`file-settings.ts`)
 * and the client editors, and unit-tested in isolation.
 */

/** A local-layer element-level override of a shared list. All fields optional. */
export interface ArrayDelta<T> {
  /** Ids (per the key's `idOf`) of shared items to hide from the resolved list. */
  hidden?: string[];
  /** Local-only items appended after the (kept) shared items. */
  added?: T[];
  /** Per-shared-item-id partial overrides, shallow-merged onto the shared item. */
  overrides?: Record<string, Partial<T>>;
}

/** A local-layer value for a list key: a full array (legacy whole-replacement),
 *  an element-level delta, or absent. */
export type LayeredArrayValue<T> = T[] | ArrayDelta<T> | undefined;

/** True when `v` is an {@link ArrayDelta} (a non-array object carrying at least
 *  one delta field) rather than a plain array or scalar. */
export function isArrayDelta(v: unknown): v is ArrayDelta<unknown> {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) &&
    ('hidden' in v || 'added' in v || 'overrides' in v)
  );
}

/**
 * Resolve a shared list against its local-layer value.
 *
 * - `local` absent → the shared array unchanged.
 * - `local` is an array → that array (legacy whole-replacement; back-compat with
 *   pre-delta `settings.local.json` files — local wins, exactly as today).
 * - `local` is an {@link ArrayDelta} → shared minus `hidden`, each surviving item
 *   shallow-merged with its `overrides[id]`, then `added` appended.
 * - `local` is anything else (malformed) → the shared array (ignore local).
 *
 * `idOf` extracts the stable identity used by `hidden`/`overrides`.
 */
export function resolveDeltaArray<T>(
  shared: readonly T[],
  local: unknown,
  idOf: (item: T) => string,
): T[] {
  if (local === undefined || local === null) return [...shared];
  if (Array.isArray(local)) return local as T[];
  if (!isArrayDelta(local)) return [...shared];

  // `isArrayDelta` narrows to `ArrayDelta<unknown>`; re-narrow to `T` since the
  // caller's `idOf` + element type define what these items are.
  const delta = local as ArrayDelta<T>;
  const hidden = new Set(delta.hidden ?? []);
  const overrides = delta.overrides ?? {};
  const kept = shared
    .filter((item) => !hidden.has(idOf(item)))
    .map((item) => {
      const id = idOf(item);
      // `in` is a runtime presence check (a missing override key is a no-op).
      return id in overrides ? { ...item, ...overrides[id] } : item;
    });
  const added = Array.isArray(delta.added) ? delta.added : [];
  return [...kept, ...added];
}

/**
 * Inverse of {@link resolveDeltaArray}: derive the local delta from an edited
 * list (what an editor produced in Local mode) against the shared list.
 *
 * - A shared item missing from `edited` → `hidden`.
 * - An edited item whose id isn't in `shared` → `added` (local-only, in edited
 *   order).
 * - A shared item present but changed → `overrides[id]` (the full edited item;
 *   `resolveDeltaArray` shallow-merges it over the shared one).
 *
 * Order is NOT captured (the local layer can't reorder shared items — docs/95
 * §95.3); `resolveDeltaArray(shared, computeArrayDelta(shared, edited)) `
 * round-trips `edited` modulo shared-item reordering. Empty fields are omitted
 * so a no-change edit yields `{}` (which resolves back to the shared list).
 *
 * HS-9212 — `forceHidden` carries ids that must be marked `hidden` even though
 * they're still present in `edited`. This lets an editor keep a HIDDEN shared
 * item in `edited` (so its local customization is still captured as an
 * `overrides[id]` entry) while flagging it hidden — so hide → un-hide round-trips
 * the customization instead of reverting to the shared value. Without this a
 * hidden item must be dropped from `edited`, which loses its override.
 */
export function computeArrayDelta<T>(
  shared: readonly T[],
  edited: readonly T[],
  idOf: (item: T) => string,
  forceHidden: Iterable<string> = [],
): ArrayDelta<T> {
  const sharedById = new Map(shared.map((s) => [idOf(s), s]));
  const editedIds = new Set(edited.map(idOf));
  // Only shared ids can be hidden (a local-only item is deleted, not hidden).
  const forced = new Set([...forceHidden].filter((id) => sharedById.has(id)));

  const hidden = [...new Set([
    ...shared.map(idOf).filter((id) => !editedIds.has(id)),
    ...forced,
  ])];
  // A force-hidden item stays out of `added`/`overrides`-as-addition; it's a
  // shared item so it's already excluded from `added`, and its override (if any)
  // is still emitted below since it remains in `edited`.
  const added = edited.filter((e) => !sharedById.has(idOf(e)));
  const overrides: Record<string, T> = {};
  for (const e of edited) {
    const id = idOf(e);
    const s = sharedById.get(id);
    if (s !== undefined && JSON.stringify(s) !== JSON.stringify(e)) overrides[id] = e;
  }

  const delta: ArrayDelta<T> = {};
  if (hidden.length > 0) delta.hidden = hidden;
  if (added.length > 0) delta.added = added;
  if (Object.keys(overrides).length > 0) delta.overrides = overrides;
  return delta;
}
