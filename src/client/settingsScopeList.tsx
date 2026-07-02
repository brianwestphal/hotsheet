/**
 * HS-9010 Phase 3 (HS-9014–9016) — helper for making the Settings dialog's
 * complex LIST editors (auto-context, terminals, custom commands) scope-aware,
 * so they participate in the dialog-wide Shared | Local control (docs/95 §95.3)
 * without each editor re-implementing the layer logic.
 *
 * The editors keep their existing whole-list editing UX. The mode only changes
 * which layer they read + write:
 *   - Local (default): edit the effective list; on save the change vs the shared
 *     array is persisted as an element-level delta in `settings.local.json`
 *     (removing a shared item hides it; adding one is local-only; editing one
 *     overrides it).
 *   - Shared: edit the committed `settings.json` array directly.
 *
 * Editors should reload on the `hotsheet:scope-mode-changed` event + on dialog
 * open, and render an origin hint so the user can tell shared from local items.
 */
import { clearLocalSettingOverride, getLayeredFileSettings, updateFileSettingsLayer } from '../api/index.js';
import { type ArrayDelta, computeArrayDelta, isArrayDelta, moveArrayItemToLocal, moveArrayItemToShared } from '../settingsDelta.js';
import { toElement } from './dom.js';
import { getScopeMode } from './settingsScope.js';

/** A short banner explaining how edits behave in the active scope mode.
 *  Appended into a list editor's container. HS-9014–9016. */
const SCOPE_LIST_HINT: Record<'shared' | 'local', string> = {
  shared: 'Editing the shared (committed) list — versioned for your team.',
  local: 'Editing local overrides — removing a shared item hides it on this machine; added items are local-only.',
};
export function renderScopeListHint(container: HTMLElement, mode: 'shared' | 'local'): void {
  container.appendChild(scopeListHintElement(mode));
}

/** The hint as a standalone element — for editors that rebuild via
 *  `replaceChildren(...)` and need to include it in the array. */
export function scopeListHintElement(mode: 'shared' | 'local'): HTMLElement {
  return toElement(<div className={`scope-list-hint scope-list-hint-${mode}`}>{SCOPE_LIST_HINT[mode]}</div>);
}

/** Coerce a layered value to an array, tolerating a legacy stringified array. */
function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON — fall through */ }
  }
  return [];
}

export interface ScopedListData<T> {
  mode: 'shared' | 'local';
  /** The raw shared-layer (`settings.json`) array — needed to compute the local delta on save. */
  shared: T[];
  /** The list the editor should display + edit: the shared array in Shared mode, else the resolved (effective) list. */
  items: T[];
  /** HS-9212 — the raw local-layer delta (when the local value is an element-level
   *  delta object), so an editor can reconstruct LOCALLY-HIDDEN shared items
   *  together with their per-machine `overrides` and round-trip them through a
   *  hide → un-hide. `undefined` when the local layer holds no delta (absent, a
   *  legacy whole-replacement array, or Shared mode). */
  localDelta?: ArrayDelta<T>;
}

/** Load a complex list key for the active scope mode. */
export async function loadScopedList<T>(key: string): Promise<ScopedListData<T>> {
  const mode = getScopeMode();
  const layered = await getLayeredFileSettings();
  const shared = asArray(layered.shared[key]) as T[];
  const resolved = asArray(layered.resolved[key]) as T[];
  const localRaw: unknown = layered.local[key];
  const localDelta = isArrayDelta(localRaw) ? (localRaw as ArrayDelta<T>) : undefined;
  return { mode, shared, items: mode === 'shared' ? shared : resolved, localDelta };
}

/**
 * Persist an edited complex list per the active scope mode: Shared writes the
 * array to settings.json; Local writes the delta vs `shared` (from
 * {@link loadScopedList}) to settings.local.json.
 *
 * HS-9212 — `hidden` carries shared items the local layer hides on this machine,
 * each holding its (possibly locally-customized) config. They're folded into the
 * delta computation so their `overrides` survive while they're hidden, then
 * force-marked `hidden`. Pass `[]` (the default) for editors with no hide concept.
 */
export async function saveScopedList<T>(
  key: string,
  idOf: (item: T) => string,
  shared: T[],
  edited: T[],
  hidden: T[] = [],
): Promise<void> {
  const mode = getScopeMode();
  if (mode === 'shared') {
    // Shared mode has no per-machine "hidden" concept — write the visible array.
    await updateFileSettingsLayer('shared', { [key]: edited });
  } else {
    const all = [...edited, ...hidden];
    const delta = computeArrayDelta(shared, all, idOf, hidden.map(idOf));
    await updateFileSettingsLayer('local', { [key]: delta });
  }
}

/**
 * HS-9209 — move ONE item of a scoped list between the shared and local layers,
 * editing both layer files (mirrors the custom-commands `moveCommandLayer`):
 *  - `to-shared` promotes a local-only addition into the committed `settings.json`.
 *  - `to-local` demotes a shared item to machine-only (drops it from `settings.json`,
 *    adds it as a local addition folding in any local override).
 *
 * Reads the layers fresh (so it's independent of the editor's in-memory state),
 * applies the pure {@link moveArrayItemToShared}/{@link moveArrayItemToLocal}, then
 * writes the shared array + the local delta (clearing the local key entirely when
 * the delta empties, so a stray `{}` doesn't linger). The caller reloads + rerenders.
 *
 * `T` parameterizes `idOf` so a caller's `(item: SpecificType) => string` type-checks;
 * the list values themselves cross the wire as `unknown`.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is for caller idOf ergonomics (see above); `unknown` would break contravariance.
export async function moveScopedListItem<T>(
  key: string,
  idOf: (item: T) => string,
  id: string,
  direction: 'to-shared' | 'to-local',
): Promise<void> {
  const layered = await getLayeredFileSettings();
  const shared = asArray(layered.shared[key]) as T[];
  const localRaw: unknown = layered.local[key];
  const delta: ArrayDelta<T> = isArrayDelta(localRaw) ? (localRaw as ArrayDelta<T>) : {};
  const next = direction === 'to-shared'
    ? moveArrayItemToShared(shared, delta, id, idOf)
    : moveArrayItemToLocal(shared, delta, id, idOf);
  await updateFileSettingsLayer('shared', { [key]: next.shared });
  if (Object.keys(next.delta).length === 0) {
    await clearLocalSettingOverride([key]);
  } else {
    await updateFileSettingsLayer('local', { [key]: next.delta });
  }
}
