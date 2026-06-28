import { describe, expect, it } from 'vitest';

import {
  addLocalView,
  addSharedView,
  deleteLocalView,
  deleteSharedView,
  editView,
  hideSharedView,
  isSharedView,
  moveViewToLocal,
  moveViewToShared,
  reorderViews,
  resolveViews,
  unhideSharedView,
  type ViewLayers,
} from './customViewsLayers.js';
import type { CustomView } from './state.js';

const view = (id: string, name = id): CustomView => ({ id, name, logic: 'all', conditions: [] });

/** A layer pair: two shared views, no local delta. */
const base = (): ViewLayers => ({ shared: [view('s1'), view('s2')], delta: {} });

describe('customViewsLayers (HS-9092/9093)', () => {
  it('resolveViews = shared minus hidden + added; isSharedView reflects origin', () => {
    const layers: ViewLayers = { shared: [view('s1'), view('s2')], delta: { hidden: ['s2'], added: [view('l1')] } };
    expect(resolveViews(layers).map(v => v.id)).toEqual(['s1', 'l1']);
    expect(isSharedView(layers, 's1')).toBe(true);
    expect(isSharedView(layers, 'l1')).toBe(false);
  });

  it('addLocalView appends to the local `added` delta, leaving shared untouched', () => {
    const layers = addLocalView(base(), view('l1'));
    expect(layers.shared.map(v => v.id)).toEqual(['s1', 's2']); // shared unchanged
    expect(layers.delta.added?.map(v => v.id)).toEqual(['l1']);
    expect(resolveViews(layers).map(v => v.id)).toEqual(['s1', 's2', 'l1']);
  });

  it('addSharedView appends to the shared array', () => {
    const layers = addSharedView(base(), view('s3'));
    expect(layers.shared.map(v => v.id)).toEqual(['s1', 's2', 's3']);
    expect(layers.delta).toEqual({});
  });

  it('editView routes a shared-view edit to the shared array', () => {
    const layers = editView(base(), view('s1', 'Renamed'));
    expect(layers.shared.find(v => v.id === 's1')?.name).toBe('Renamed');
    expect(layers.delta).toEqual({});
  });

  it('editView routes a local-view edit to the local `added` entry', () => {
    const start = addLocalView(base(), view('l1', 'Local'));
    const layers = editView(start, view('l1', 'Local Renamed'));
    expect(layers.delta.added?.find(v => v.id === 'l1')?.name).toBe('Local Renamed');
    expect(layers.shared.map(v => v.id)).toEqual(['s1', 's2']); // shared untouched
  });

  it('editView is a no-op for an unknown id', () => {
    const layers = base();
    expect(editView(layers, view('nope'))).toBe(layers);
  });

  it('hideSharedView + unhideSharedView round-trip (resolved omits then restores)', () => {
    const hidden = hideSharedView(base(), 's1');
    expect(hidden.delta.hidden).toEqual(['s1']);
    expect(resolveViews(hidden).map(v => v.id)).toEqual(['s2']);
    const restored = unhideSharedView(hidden, 's1');
    expect(restored.delta.hidden).toBeUndefined();
    expect(resolveViews(restored).map(v => v.id)).toEqual(['s1', 's2']);
  });

  it('hideSharedView is a no-op for a local view or a double-hide', () => {
    const withLocal = addLocalView(base(), view('l1'));
    expect(hideSharedView(withLocal, 'l1')).toBe(withLocal); // can't hide a local view
    const hidden = hideSharedView(base(), 's1');
    expect(hideSharedView(hidden, 's1')).toBe(hidden); // already hidden
  });

  it('deleteLocalView drops a local addition; no-op for a shared view', () => {
    const withLocal = addLocalView(base(), view('l1'));
    expect(deleteLocalView(withLocal, 'l1').delta.added).toBeUndefined();
    const b = base();
    expect(deleteLocalView(b, 's1')).toBe(b); // shared view: not deletable here (no-op)
  });

  // HS-9123 — shared views can be deleted outright (edits the committed array).
  it('deleteSharedView removes from the shared array + clears stale hidden/override; no-op for a local id', () => {
    const layers: ViewLayers = { shared: [view('s1'), view('s2')], delta: { hidden: ['s1'], added: [view('l1')] } };
    const out = deleteSharedView(layers, 's1');
    expect(out.shared.map(v => v.id)).toEqual(['s2']);
    expect(out.delta.hidden).toBeUndefined(); // pruned the now-stale hidden entry
    expect(out.delta.added?.map(v => v.id)).toEqual(['l1']); // local addition untouched
    // A local id isn't a shared view → no-op.
    const withLocal = addLocalView(base(), view('l1'));
    expect(deleteSharedView(withLocal, 'l1')).toBe(withLocal);
  });

  it('moveViewToLocal: shared view leaves the array, becomes a local addition; resolved membership unchanged', () => {
    const moved = moveViewToLocal(base(), 's1');
    expect(moved.shared.map(v => v.id)).toEqual(['s2']);
    expect(moved.delta.added?.map(v => v.id)).toEqual(['s1']);
    expect(resolveViews(moved).map(v => v.id).sort()).toEqual(['s1', 's2']);
  });

  it('moveViewToShared: local addition appended to shared, dropped from delta', () => {
    const withLocal = addLocalView(base(), view('l1'));
    const moved = moveViewToShared(withLocal, 'l1');
    expect(moved.shared.map(v => v.id)).toEqual(['s1', 's2', 'l1']);
    expect(moved.delta.added).toBeUndefined();
  });

  it('move round-trips: to-local then to-shared restores shared membership', () => {
    const back = moveViewToShared(moveViewToLocal(base(), 's1'), 's1');
    expect(back.shared.map(v => v.id).sort()).toEqual(['s1', 's2']);
    expect(back.delta.added).toBeUndefined();
  });

  it('reorderViews reorders within the shared layer (insert-before-target)', () => {
    const layers: ViewLayers = { shared: [view('s1'), view('s2'), view('s3')], delta: {} };
    expect(reorderViews(layers, 's3', 's1').shared.map(v => v.id)).toEqual(['s3', 's1', 's2']);
    expect(reorderViews(layers, 's1', null).shared.map(v => v.id)).toEqual(['s2', 's3', 's1']); // to end
  });

  it('reorderViews reorders within the local `added` layer', () => {
    const layers: ViewLayers = { shared: [view('s1')], delta: { added: [view('l1'), view('l2')] } };
    expect(reorderViews(layers, 'l2', 'l1').delta.added?.map(v => v.id)).toEqual(['l2', 'l1']);
  });

  it('reorderViews is a no-op across layers (shared can not be reordered by local)', () => {
    const layers: ViewLayers = { shared: [view('s1')], delta: { added: [view('l1')] } };
    expect(reorderViews(layers, 'l1', 's1')).toBe(layers);
    expect(reorderViews(layers, 's1', 'l1')).toBe(layers);
  });
});
