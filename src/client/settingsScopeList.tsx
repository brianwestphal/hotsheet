/**
 * HS-9010 Phase 3 (HS-9014–9016) — helper for making the Settings dialog's
 * complex LIST editors (auto-context, terminals, custom commands) scope-aware,
 * so they participate in the dialog-wide Shared | Local overrides | Resolved
 * control (docs/95 §95.3) without each editor re-implementing the layer logic.
 *
 * The editors keep their existing whole-list editing UX. The mode only changes
 * which layer they read + write:
 *   - Resolved (default): edit the effective list; writes route to the key's
 *     default layer (the editor's existing `fallback` save) — unchanged behavior.
 *   - Shared: edit the committed `settings.json` array directly.
 *   - Local: edit the effective list; on save the change vs the shared array is
 *     persisted as an element-level delta in `settings.local.json` (removing a
 *     shared item hides it; adding one is local-only; editing one overrides it).
 *
 * Editors should reload on the `hotsheet:scope-mode-changed` event + on dialog
 * open, and render an origin hint so the user can tell shared from local items.
 */
import { getLayeredFileSettings, updateFileSettingsLayer } from '../api/index.js';
import { computeArrayDelta } from '../settingsDelta.js';
import { toElement } from './dom.js';
import { getScopeMode } from './settingsScope.js';

/** A short banner explaining how edits behave in the active scope mode.
 *  Appended into a list editor's container (no-op in the dead 'resolved' case).
 *  HS-9014–9016. (HS-9166 — 'resolved' is unreachable; the local editor mode
 *  types still declare it pending a follow-up cleanup.) */
const SCOPE_LIST_HINT: Record<'shared' | 'local' | 'resolved', string> = {
  shared: 'Editing the shared (committed) list — versioned for your team.',
  local: 'Editing local overrides — removing a shared item hides it on this machine; added items are local-only.',
  resolved: '',
};
export function renderScopeListHint(container: HTMLElement, mode: 'shared' | 'local' | 'resolved'): void {
  const el = scopeListHintElement(mode);
  if (el !== null) container.appendChild(el);
}

/** The hint as a standalone element (null in the dead 'resolved' case) — for
 *  editors that rebuild via `replaceChildren(...)`. */
export function scopeListHintElement(mode: 'shared' | 'local' | 'resolved'): HTMLElement | null {
  if (mode === 'resolved') return null;
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
}

/** Load a complex list key for the active scope mode. */
export async function loadScopedList<T>(key: string): Promise<ScopedListData<T>> {
  const mode = getScopeMode();
  const layered = await getLayeredFileSettings();
  const shared = asArray(layered.shared[key]) as T[];
  const resolved = asArray(layered.resolved[key]) as T[];
  return { mode, shared, items: mode === 'shared' ? shared : resolved };
}

/**
 * Persist an edited complex list per the active scope mode: Shared writes the
 * array to settings.json; Local writes the delta vs `shared` (from
 * {@link loadScopedList}) to settings.local.json.
 */
export async function saveScopedList<T>(
  key: string,
  idOf: (item: T) => string,
  shared: T[],
  edited: T[],
): Promise<void> {
  const mode = getScopeMode();
  if (mode === 'shared') {
    await updateFileSettingsLayer('shared', { [key]: edited });
  } else {
    await updateFileSettingsLayer('local', { [key]: computeArrayDelta(shared, edited, idOf) });
  }
}
