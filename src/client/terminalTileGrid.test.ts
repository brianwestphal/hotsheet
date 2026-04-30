// @vitest-environment happy-dom
/**
 * HS-8048 — unit-test surface for `terminalTileGrid.tsx`. The module is
 * heavily DOM-driven (xterm canvas, IntersectionObserver, ResizeObserver)
 * and has historically been Playwright-only — happy-dom can't render
 * xterm natively (no canvas). These tests pin the migration's key
 * stack-level invariants without trying to assert visual behaviour.
 *
 * All assertions go through `_inspectStackForTesting()` + `entryCount()`
 * from `terminalCheckout`, mirroring how `quitConfirm.test.ts` validates
 * its own checkout integration. happy-dom doesn't expose a WebSocket
 * constructor, so checkout's typeof-undefined short-circuit drops to
 * `ws=null` and the stack semantics work without a live socket; xterm
 * renders to a
 * minimal DOM tree under happy-dom that's enough for `term.element` to
 * exist + be reparentable.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _inspectStackForTesting,
  _resetForTesting,
  entryCount,
} from './terminalCheckout.js';
import { mountTileGrid, type TileEntry, type TileGridHandle } from './terminalTileGrid.js';

// happy-dom has `IntersectionObserver` but its `observe()` never fires
// entries — so under happy-dom the virtualization-driven mount path
// would never run. The shared module already has an eager-mount
// fallback for `typeof IntersectionObserver === 'undefined'` test envs;
// we stub the global to undefined here so that fallback is taken,
// matching the test envs the original `mountTileXterm + connectTileSocket`
// path was designed for.
type IntersectionObserverGlobal = { IntersectionObserver?: unknown };
let savedIntersectionObserver: unknown = undefined;

beforeEach(() => {
  document.body.innerHTML = '';
  _resetForTesting();
  savedIntersectionObserver = (globalThis as IntersectionObserverGlobal).IntersectionObserver;
  delete (globalThis as IntersectionObserverGlobal).IntersectionObserver;
});

afterEach(() => {
  _resetForTesting();
  document.body.innerHTML = '';
  if (savedIntersectionObserver !== undefined) {
    (globalThis as IntersectionObserverGlobal).IntersectionObserver = savedIntersectionObserver;
  }
});

function makeContainer(): HTMLDivElement {
  const div = document.createElement('div');
  div.id = 'test-grid';
  div.style.width = '800px';
  div.style.height = '600px';
  document.body.appendChild(div);
  return div;
}

function makeEntry(secret: string, id: string, state: 'alive' | 'exited' | 'not_spawned' = 'alive'): TileEntry {
  return {
    id,
    secret,
    label: id,
    state,
    exitCode: null,
  };
}

function mount(entries: TileEntry[]): TileGridHandle {
  const handle = mountTileGrid({
    container: makeContainer(),
    cssPrefix: 'terminal-dashboard',
    centerSizeFrac: 0.7,
    centerScope: 'viewport',
    getSliderValue: () => 50,
  });
  handle.rebuild(entries);
  return handle;
}

describe('terminalTileGrid — tile mounted via terminalCheckout (HS-8048)', () => {
  it('rebuild with a single alive tile creates a checkout entry', () => {
    const grid = mount([makeEntry('secret-A', 'live-1')]);
    // happy-dom doesn't have IntersectionObserver wired to scroll
    // events. `mountTileGrid` falls back to eager-mount when
    // `typeof IntersectionObserver === 'undefined'`. happy-dom DOES
    // expose IntersectionObserver but it never auto-fires entries —
    // so the test envs effectively get the eager fallback.
    expect(entryCount()).toBeGreaterThanOrEqual(1);
    const snap = _inspectStackForTesting();
    const ourEntry = snap.find(s => s.key === 'secret-A::live-1');
    expect(ourEntry).toBeDefined();
    expect(ourEntry?.stackDepth).toBe(1);
    grid.dispose();
  });

  it('exited / not_spawned tiles do NOT create a checkout entry on rebuild (no PTY to attach to)', () => {
    const grid = mount([
      makeEntry('s', 'cold-1', 'not_spawned'),
      makeEntry('s', 'dead-1', 'exited'),
    ]);
    expect(entryCount()).toBe(0);
    grid.dispose();
  });

  it('dispose releases every tile checkout — entryCount returns to 0', () => {
    const grid = mount([
      makeEntry('s1', 't1'),
      makeEntry('s2', 't2'),
      makeEntry('s3', 't3'),
    ]);
    expect(entryCount()).toBeGreaterThan(0);
    grid.dispose();
    expect(entryCount()).toBe(0);
  });

  it('rebuild with a fresh entry list disposes the old tiles + mounts new ones', () => {
    const grid = mount([makeEntry('s', 't1')]);
    expect(_inspectStackForTesting().some(e => e.key === 's::t1')).toBe(true);

    grid.rebuild([makeEntry('s', 't2')]);
    expect(_inspectStackForTesting().some(e => e.key === 's::t1')).toBe(false);
    expect(_inspectStackForTesting().some(e => e.key === 's::t2')).toBe(true);

    grid.dispose();
  });

  // Cross-project independence — two tiles in different projects with the
  // same terminalId must get independent checkout entries (`(secret,
  // terminalId)` is the key, not just terminalId). Mirrors the
  // checkout-test cross-project-independence assertion at the tile-grid
  // level, since this is a regression vector when the migration's
  // mountInto routing is wrong.
  it('two tiles with the same terminalId across projects get independent entries', () => {
    const grid = mount([
      makeEntry('proj-A', 'default'),
      makeEntry('proj-B', 'default'),
    ]);
    expect(entryCount()).toBe(2);
    const keys = _inspectStackForTesting().map(s => s.key);
    expect(keys).toContain('proj-A::default');
    expect(keys).toContain('proj-B::default');
    grid.dispose();
  });
});
