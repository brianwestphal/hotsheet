/**
 * HS-9092 / HS-9093 (docs/107) — per-machine local customization of `custom_views`.
 *
 * Custom views are **flat** (no group tree), so they reuse the shared/local
 * `ArrayDelta` model from `src/settingsDelta.ts` (`resolveDeltaArray`, idOf=`id`),
 * already wired into `readFileSettings`. Unlike the mode-driven Settings editors
 * (terminals/auto_context/commands), the views surface has NO scope-mode toggle:
 * each ACTION targets a specific layer based on where the view lives —
 *   - **add** a new view → local `added` (one-click, never touches the committed file);
 *   - **edit** a shared view → the shared array; **edit** a local view → its `added` entry;
 *   - **hide** a shared view on this machine → local `hidden` (+ undo);
 *   - **delete** a local view → drop it from `added`;
 *   - **move** a view between layers (Settings "Views" tab, HS-9093).
 *
 * These pure functions (no DOM, no fs/network) take + return a {@link ViewLayers}
 * pair so they're unit-tested in isolation; `customViews.tsx` wires them to the
 * layered file-settings API + the sidebar DOM.
 */
import { type ArrayDelta, resolveDeltaArray } from '../settingsDelta.js';
import type { CustomView } from './state.js';

const idOf = (v: CustomView): string => v.id;

/** The two layer values a view action edits together. */
export interface ViewLayers {
  /** The committed shared array (`settings.json` `custom_views`). */
  shared: CustomView[];
  /** The local delta (`settings.local.json` `custom_views`). */
  delta: ArrayDelta<CustomView>;
}

/** The effective (resolved) view list for a layer pair. */
export function resolveViews(layers: ViewLayers): CustomView[] {
  return resolveDeltaArray(layers.shared, layers.delta, idOf);
}

/** Whether a view id lives in the SHARED array (vs being a local addition). */
export function isSharedView(layers: ViewLayers, id: string): boolean {
  return layers.shared.some(v => idOf(v) === id);
}

function cloneDelta(delta: ArrayDelta<CustomView>): ArrayDelta<CustomView> {
  const out: ArrayDelta<CustomView> = {};
  if (delta.hidden !== undefined) out.hidden = [...delta.hidden];
  if (delta.added !== undefined) out.added = delta.added.map(v => ({ ...v }));
  if (delta.overrides !== undefined) out.overrides = { ...delta.overrides };
  return out;
}

/** Drop empty delta fields so a fully-reconciled delta serializes as `{}`. */
export function pruneViewDelta(delta: ArrayDelta<CustomView>): ArrayDelta<CustomView> {
  const out: ArrayDelta<CustomView> = {};
  if (delta.hidden !== undefined && delta.hidden.length > 0) out.hidden = delta.hidden;
  if (delta.added !== undefined && delta.added.length > 0) out.added = delta.added;
  if (delta.overrides !== undefined && Object.keys(delta.overrides).length > 0) out.overrides = delta.overrides;
  return out;
}

/** Add a NEW view as a LOCAL addition (the sidebar's one-click default). */
export function addLocalView(layers: ViewLayers, view: CustomView): ViewLayers {
  const delta = cloneDelta(layers.delta);
  delta.added = [...(delta.added ?? []), { ...view }];
  return { shared: layers.shared, delta: pruneViewDelta(delta) };
}

/** Add a NEW view to the SHARED array (the Views-tab "add → Shared" path). */
export function addSharedView(layers: ViewLayers, view: CustomView): ViewLayers {
  return { shared: [...layers.shared, { ...view }], delta: layers.delta };
}

/**
 * Edit a view in place. Routes to the layer it lives in: a shared view updates
 * the shared array; a local-added view updates its `added` entry. No-op if the
 * id isn't found in either layer.
 */
export function editView(layers: ViewLayers, view: CustomView): ViewLayers {
  const id = idOf(view);
  const sharedIdx = layers.shared.findIndex(v => idOf(v) === id);
  if (sharedIdx >= 0) {
    const shared = layers.shared.map((v, i) => i === sharedIdx ? { ...view } : v);
    return { shared, delta: layers.delta };
  }
  const added = layers.delta.added ?? [];
  const addedIdx = added.findIndex(v => idOf(v) === id);
  if (addedIdx >= 0) {
    const delta = cloneDelta(layers.delta);
    delta.added = added.map((v, i) => i === addedIdx ? { ...view } : v);
    return { shared: layers.shared, delta: pruneViewDelta(delta) };
  }
  return layers;
}

/** Hide a SHARED view on this machine (local `hidden`). No-op for a local view
 *  (you'd delete that) or an already-hidden id. */
export function hideSharedView(layers: ViewLayers, id: string): ViewLayers {
  if (!isSharedView(layers, id)) return layers;
  const delta = cloneDelta(layers.delta);
  const hidden = delta.hidden ?? [];
  if (hidden.includes(id)) return layers;
  delta.hidden = [...hidden, id];
  return { shared: layers.shared, delta: pruneViewDelta(delta) };
}

/** Un-hide a locally-hidden shared view (undo). */
export function unhideSharedView(layers: ViewLayers, id: string): ViewLayers {
  const delta = cloneDelta(layers.delta);
  if (delta.hidden === undefined) return layers;
  delta.hidden = delta.hidden.filter(h => h !== id);
  return { shared: layers.shared, delta: pruneViewDelta(delta) };
}

/** Delete a LOCAL view (drop it from `added`). A shared view is hidden, not
 *  deleted, from the sidebar — see {@link hideSharedView}. */
export function deleteLocalView(layers: ViewLayers, id: string): ViewLayers {
  const added = layers.delta.added ?? [];
  if (!added.some(v => idOf(v) === id)) return layers;
  const delta = cloneDelta(layers.delta);
  delta.added = added.filter(v => idOf(v) !== id);
  return { shared: layers.shared, delta: pruneViewDelta(delta) };
}

/**
 * HS-9123 — Delete a SHARED view outright (remove it from the committed array,
 * editing `settings.json` for the whole team). Also drops any local `hidden` /
 * `overrides` entry that referenced it so no stale delta lingers. No-op if the
 * id isn't a shared view.
 */
export function deleteSharedView(layers: ViewLayers, id: string): ViewLayers {
  if (!isSharedView(layers, id)) return layers;
  const shared = layers.shared.filter(v => idOf(v) !== id);
  const delta = cloneDelta(layers.delta);
  if (delta.hidden !== undefined) delta.hidden = delta.hidden.filter(h => h !== id);
  if (delta.overrides !== undefined) {
    const { [id]: _dropped, ...rest } = delta.overrides;
    void _dropped;
    delta.overrides = rest;
  }
  return { shared, delta: pruneViewDelta(delta) };
}

/**
 * Reorder a view before another, WITHIN its layer (the local layer can't reorder
 * shared items — docs/95 §95.3). A shared→shared drag reorders the shared array;
 * a local→local drag reorders `added`. A cross-layer drag is a no-op (the
 * resolved order is always shared-first, then local). `toId` may be `null` to
 * move the dragged view to the END of its layer.
 */
export function reorderViews(layers: ViewLayers, fromId: string, toId: string | null): ViewLayers {
  if (fromId === toId) return layers;
  const fromShared = isSharedView(layers, fromId);
  if (toId !== null && fromShared !== isSharedView(layers, toId)) return layers;

  if (fromShared) {
    if (!layers.shared.some(v => idOf(v) === fromId)) return layers;
    const moved = layers.shared.find(v => idOf(v) === fromId);
    if (moved === undefined) return layers;
    const without = layers.shared.filter(v => idOf(v) !== fromId);
    const ti = toId === null ? without.length : without.findIndex(v => idOf(v) === toId);
    if (ti < 0) return layers;
    without.splice(ti, 0, moved);
    return { shared: without, delta: layers.delta };
  }

  const added = layers.delta.added ?? [];
  const moved = added.find(v => idOf(v) === fromId);
  if (moved === undefined) return layers;
  const without = added.filter(v => idOf(v) !== fromId);
  const ti = toId === null ? without.length : without.findIndex(v => idOf(v) === toId);
  if (ti < 0) return layers;
  without.splice(ti, 0, moved);
  const delta = cloneDelta(layers.delta);
  delta.added = without;
  return { shared: layers.shared, delta: pruneViewDelta(delta) };
}

/**
 * Move a SHARED view into the LOCAL layer ("make this machine-only"): drop it
 * from the shared array + add it as a local addition (net resolved list
 * unchanged; the view now lives only in `settings.local.json`). No-op if the id
 * isn't a shared view. (HS-9093 Views tab.)
 */
export function moveViewToLocal(layers: ViewLayers, id: string): ViewLayers {
  const idx = layers.shared.findIndex(v => idOf(v) === id);
  if (idx < 0) return layers;
  const view = layers.shared[idx];
  const shared = layers.shared.filter((_, i) => i !== idx);
  const delta = cloneDelta(layers.delta);
  if (delta.hidden !== undefined) delta.hidden = delta.hidden.filter(h => h !== id);
  if (delta.overrides !== undefined) {
    const { [id]: _dropped, ...rest } = delta.overrides;
    void _dropped;
    delta.overrides = rest;
  }
  delta.added = [...(delta.added ?? []), { ...view }];
  return { shared, delta: pruneViewDelta(delta) };
}

/**
 * Move a LOCAL view into the SHARED array ("promote to shared"): append it to
 * the shared array + drop it from the local `added`. No-op if the id isn't a
 * local addition. (HS-9093 Views tab.)
 */
export function moveViewToShared(layers: ViewLayers, id: string): ViewLayers {
  const added = layers.delta.added ?? [];
  const idx = added.findIndex(v => idOf(v) === id);
  if (idx < 0) return layers;
  const view = added[idx];
  const delta = cloneDelta(layers.delta);
  delta.added = added.filter((_, i) => i !== idx);
  return { shared: [...layers.shared, { ...view }], delta: pruneViewDelta(delta) };
}
