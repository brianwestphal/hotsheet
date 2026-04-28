/**
 * HS-7968 — pure-helper tests for the tile virtualization state machine.
 */
import { describe, expect, it } from 'vitest';

import {
  initialTileState,
  onDisposeTimerFired,
  onTileEnter,
  onTileExit,
} from './terminalTileVirtualization.js';

describe('initialTileState (HS-7968)', () => {
  it('starts unmounted + invisible + no exit timestamp', () => {
    const s = initialTileState();
    expect(s.mounted).toBe(false);
    expect(s.visible).toBe(false);
    expect(s.exitedAt).toBeNull();
    expect(s.pendingDisposeTimerId).toBeNull();
  });
});

describe('onTileEnter (HS-7968)', () => {
  it('mounts a never-seen alive tile on first visibility', () => {
    const before = initialTileState();
    const { next, actions } = onTileEnter(before, { tileId: 't1', mountIfNotMounted: true });
    expect(next.visible).toBe(true);
    expect(next.mounted).toBe(true);
    expect(actions).toEqual([{ type: 'mount', tileId: 't1' }]);
  });

  it('does NOT mount a non-alive tile (caller passes mountIfNotMounted: false)', () => {
    const before = initialTileState();
    const { next, actions } = onTileEnter(before, { tileId: 't1', mountIfNotMounted: false });
    expect(next.visible).toBe(true);
    expect(next.mounted).toBe(false);
    expect(actions).toEqual([]);
  });

  it('does not re-mount an already-mounted tile (mount is idempotent at the state machine level)', () => {
    const mounted = { ...initialTileState(), mounted: true, visible: false, exitedAt: 100 };
    const { next, actions } = onTileEnter(mounted, { tileId: 't1', mountIfNotMounted: true });
    expect(next.mounted).toBe(true);
    expect(next.visible).toBe(true);
    expect(actions.find(a => a.type === 'mount')).toBeUndefined();
  });

  it('cancels a pending dispose when the tile re-enters', () => {
    const exiting = { ...initialTileState(), mounted: true, visible: false, exitedAt: 100, pendingDisposeTimerId: 42 };
    const { next, actions } = onTileEnter(exiting, { tileId: 't1', mountIfNotMounted: true });
    expect(next.pendingDisposeTimerId).toBeNull();
    expect(actions).toContainEqual({ type: 'cancelDispose', tileId: 't1' });
  });
});

describe('onTileExit (HS-7968)', () => {
  it('schedules a debounced dispose for a mounted, visible tile', () => {
    const visible = { ...initialTileState(), mounted: true, visible: true };
    const { next, actions } = onTileExit(visible, { tileId: 't1', now: 5000, debounceMs: 8000 });
    expect(next.visible).toBe(false);
    expect(next.exitedAt).toBe(5000);
    expect(actions).toEqual([{ type: 'scheduleDispose', tileId: 't1', afterMs: 8000 }]);
  });

  it('is a no-op when the tile was never mounted (e.g. exited PTY tile)', () => {
    const before = initialTileState();
    const { next, actions } = onTileExit(before, { tileId: 't1', now: 5000, debounceMs: 8000 });
    expect(next.visible).toBe(false);
    expect(next.mounted).toBe(false);
    expect(next.exitedAt).toBe(5000);
    expect(actions).toEqual([]);
  });
});

describe('onDisposeTimerFired (HS-7968)', () => {
  it('disposes a still-off-screen mounted tile', () => {
    const offscreenMounted = { ...initialTileState(), mounted: true, visible: false, exitedAt: 5000, pendingDisposeTimerId: 99 };
    const { next, actions } = onDisposeTimerFired(offscreenMounted, { tileId: 't1' });
    expect(next.mounted).toBe(false);
    expect(next.pendingDisposeTimerId).toBeNull();
    expect(actions).toEqual([{ type: 'dispose', tileId: 't1' }]);
  });

  it('is a no-op when the tile re-entered before the timer fired', () => {
    const reentered = { ...initialTileState(), mounted: true, visible: true, pendingDisposeTimerId: 99 };
    const { next, actions } = onDisposeTimerFired(reentered, { tileId: 't1' });
    expect(next.mounted).toBe(true);
    expect(actions).toEqual([]);
  });

  it('is a no-op when the tile was never mounted', () => {
    const unmounted = { ...initialTileState(), mounted: false, visible: false };
    const { next, actions } = onDisposeTimerFired(unmounted, { tileId: 't1' });
    expect(next.mounted).toBe(false);
    expect(actions).toEqual([]);
  });
});

describe('full lifecycle (HS-7968)', () => {
  it('quick scroll past does not churn the renderer (re-enter cancels pending dispose)', () => {
    let s = initialTileState();
    // Initial enter — mount.
    let step = onTileEnter(s, { tileId: 't', mountIfNotMounted: true });
    s = step.next;
    expect(s.mounted).toBe(true);

    // Off-screen briefly — schedule dispose.
    step = onTileExit(s, { tileId: 't', now: 1000, debounceMs: 8000 });
    s = { ...step.next, pendingDisposeTimerId: 1 }; // caller would fill in after setTimeout

    // Quick re-enter (e.g. user scrolled back) — cancels dispose.
    step = onTileEnter(s, { tileId: 't', mountIfNotMounted: true });
    s = step.next;
    expect(s.mounted).toBe(true);
    expect(s.pendingDisposeTimerId).toBeNull();
    expect(step.actions).toContainEqual({ type: 'cancelDispose', tileId: 't' });
    // Did NOT re-mount — the renderer stayed alive.
    expect(step.actions.find(a => a.type === 'mount')).toBeUndefined();
  });

  it('long-off-screen tile gets disposed then re-mounted on return', () => {
    let s = initialTileState();
    // Mount, exit, dispose timer fires.
    let step = onTileEnter(s, { tileId: 't', mountIfNotMounted: true });
    s = step.next;
    step = onTileExit(s, { tileId: 't', now: 0, debounceMs: 8000 });
    s = { ...step.next, pendingDisposeTimerId: 1 };
    step = onDisposeTimerFired(s, { tileId: 't' });
    s = step.next;
    expect(s.mounted).toBe(false);
    expect(step.actions).toContainEqual({ type: 'dispose', tileId: 't' });

    // Re-enter — re-mounts.
    step = onTileEnter(s, { tileId: 't', mountIfNotMounted: true });
    s = step.next;
    expect(s.mounted).toBe(true);
    expect(step.actions).toContainEqual({ type: 'mount', tileId: 't' });
  });
});
