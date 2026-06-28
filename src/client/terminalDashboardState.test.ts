// @vitest-environment happy-dom
/**
 * HS-9130 — unit coverage for the dashboard common-state holder
 * (`terminalDashboardState.ts`): the fresh-state defaults + the test-reset
 * disposer behavior (runs every disposer, clears the grid-handle map, and
 * swaps in a fresh state).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  _resetCommonStateForTesting,
  dashboardState,
  freshDashboardState,
  gridHandles,
} from './terminalDashboardState.js';
import type { TileGridHandle } from './terminalTileGrid.js';

describe('freshDashboardState', () => {
  it('returns an inactive state with all handles/refs null + empty collections', () => {
    const s = freshDashboardState();
    expect(s.active).toBe(false);
    expect(s.centeredHandle).toBeNull();
    expect(s.toggleButton).toBeNull();
    expect(s.rootElement).toBeNull();
    expect(s.resizeRaf).toBeNull();
    expect(s.statsRefreshTimer).toBeNull();
    expect(s.currentSnapPoints).toEqual([]);
    expect(s.lastSectionData).toEqual([]);
  });
});

describe('_resetCommonStateForTesting', () => {
  it('runs every disposer, clears gridHandles, and swaps in a fresh state', () => {
    const bell = vi.fn();
    const appearance = vi.fn();
    const hidden = vi.fn();
    const dispose = vi.fn();
    dashboardState.active = true;
    dashboardState.bellUnsubscribe = bell;
    dashboardState.appearanceUnsubscribe = appearance;
    dashboardState.hiddenChangeUnsubscribe = hidden;
    gridHandles.set('s1', { dispose } as unknown as TileGridHandle);

    _resetCommonStateForTesting();

    expect(bell).toHaveBeenCalledTimes(1);
    expect(appearance).toHaveBeenCalledTimes(1);
    expect(hidden).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(gridHandles.size).toBe(0);
    expect(dashboardState.active).toBe(false); // fresh state swapped in
  });

  it('tolerates throwing disposers (each is swallowed; reset still completes)', () => {
    dashboardState.bellUnsubscribe = () => { throw new Error('bell boom'); };
    gridHandles.set('s', { dispose: () => { throw new Error('dispose boom'); } } as unknown as TileGridHandle);
    expect(() => _resetCommonStateForTesting()).not.toThrow();
    expect(gridHandles.size).toBe(0);
  });
});
