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
