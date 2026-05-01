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
  _getEntryForTesting,
  _inspectStackForTesting,
  _resetForTesting,
  checkout,
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

/**
 * HS-8059 — `mountTileViaCheckout` writes the active theme bg onto the
 * tile preview's inline `style.backgroundColor` so the gutter around the
 * `.xterm-screen` canvas reads as part of the terminal frame instead of
 * the contrasting app `--bg`. Mirrors the §22 drawer treatment and the
 * §37 quit-confirm preview (HS-8058).
 */
describe('terminalTileGrid — preview bg cascade (HS-8059)', () => {
  function mountWithEntry(entry: TileEntry): TileGridHandle {
    const handle = mountTileGrid({
      container: makeContainer(),
      cssPrefix: 'terminal-dashboard',
      centerSizeFrac: 0.7,
      centerScope: 'viewport',
      getSliderValue: () => 50,
    });
    handle.rebuild([entry]);
    return handle;
  }

  it('paints the preview frame with the theme bg when an alive tile mounts', () => {
    // Dracula's bg is `#282a36`. happy-dom keeps the inline value as-written
    // (real browsers normalise to `rgb(40, 42, 54)`); both forms are
    // semantically equivalent so we assert against the source hex.
    const entry: TileEntry = { ...makeEntry('s', 't1'), theme: 'dracula' };
    const grid = mountWithEntry(entry);
    const preview = document.querySelector<HTMLElement>('.terminal-dashboard-tile-preview');
    expect(preview).not.toBeNull();
    expect(preview!.style.backgroundColor.toLowerCase()).toBe('#282a36');
    grid.dispose();
  });

  it('uses different theme bgs for tiles with different theme overrides', () => {
    const grid = mountTileGrid({
      container: makeContainer(),
      cssPrefix: 'terminal-dashboard',
      centerSizeFrac: 0.7,
      centerScope: 'viewport',
      getSliderValue: () => 50,
    });
    grid.rebuild([
      { ...makeEntry('s', 't-dracula'), theme: 'dracula' },
      { ...makeEntry('s', 't-solar'), theme: 'solarized-dark' },
    ]);
    const previews = document.querySelectorAll<HTMLElement>('.terminal-dashboard-tile-preview');
    expect(previews.length).toBe(2);
    // Dracula `#282a36`, solarized-dark `#002b36`.
    expect(previews[0].style.backgroundColor.toLowerCase()).toBe('#282a36');
    expect(previews[1].style.backgroundColor.toLowerCase()).toBe('#002b36');
    grid.dispose();
  });

  it('inline bg falls back to empty (CSS --bg wins) for non-alive placeholder tiles', () => {
    const grid = mountWithEntry({ ...makeEntry('s', 'cold-1', 'not_spawned'), theme: 'dracula' });
    const preview = document.querySelector<HTMLElement>('.terminal-dashboard-tile-preview');
    expect(preview).not.toBeNull();
    // Cold tile didn't go through `mountTileViaCheckout` — the inline bg
    // never gets written so the SCSS `--bg` fallback paints the placeholder
    // frame.
    expect(preview!.style.backgroundColor).toBe('');
    grid.dispose();
  });

  /**
   * HS-8073 — when the dedicated full-screen view is bumped down by a
   * competing checkout consumer (e.g. the quit-confirm preview pane
   * claiming the same `(secret, terminalId)` for its preview frame) and
   * subsequently restored (user cancels the quit dialog), the dedicated
   * view's `pane` dimensions never changed during the round-trip — so the
   * `bodyResizeObserver` never refires `runFit()`, leaving the term
   * stuck at whatever (smaller) size the bumping consumer last applied.
   * Pre-fix, the user saw their full-screen terminal with all output
   * centered inside an oversized empty frame.
   *
   * The fix is a per-consumer `onRestoredToTop` callback on the
   * dedicated view's `checkout()` call that schedules a refit via
   * `requestAnimationFrame(runFit)`. This test pins that contract: after
   * a competing consumer pushes onto the stack and releases, a new
   * `requestAnimationFrame` is scheduled inside the release flow — the
   * structural signal that the dedicated view re-fitted to its pane.
   */
  it('refits on restore after a competing consumer pushes/releases (HS-8073)', async () => {
    const grid = mount([makeEntry('s', 't1')]);
    // Trigger dedicated view via dblclick on the tile.
    const tile = document.querySelector('.terminal-dashboard-tile');
    expect(tile).not.toBeNull();
    tile!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    // Stack now has tile (depth 1) + dedicated view (depth 2) = 2 consumers.
    const snap1 = _inspectStackForTesting().find(e => e.key === 's::t1');
    expect(snap1?.stackDepth).toBe(2);

    // Push a competing consumer at smaller dims (simulating the quit-confirm
    // preview pane). The entry's lastApplied flips to the smaller size.
    const previewMount = document.createElement('div');
    document.body.appendChild(previewMount);
    const competing = checkout({
      projectSecret: 's', terminalId: 't1',
      cols: 40, rows: 12,
      mountInto: previewMount,
    });
    const snap2 = _inspectStackForTesting().find(e => e.key === 's::t1');
    expect(snap2?.stackDepth).toBe(3);
    expect(snap2?.lastAppliedCols).toBe(40);
    expect(snap2?.lastAppliedRows).toBe(12);

    // Spy on `fit.fit` (the FitAddon shared on the entry — both the
    // tile and the dedicated view's checkout handles point at it). The
    // dedicated view's `onRestoredToTop` schedules a `runFit()` which
    // calls `fit.fit()`. We flush via `await new Promise(setTimeout)`
    // so the rAF-deferred `runFit()` actually runs.
    const entry = _getEntryForTesting('s', 't1');
    expect(entry).not.toBeNull();
    let fitCalls = 0;
    const origFit = entry!.fit.fit.bind(entry!.fit);
    entry!.fit.fit = () => { fitCalls++; return origFit(); };
    competing.release();
    // Drain the rAF the dedicated view scheduled in onRestoredToTop.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    entry!.fit.fit = origFit;

    // After release, dedicated view is back on top of the stack.
    const snap3 = _inspectStackForTesting().find(e => e.key === 's::t1');
    expect(snap3?.stackDepth).toBe(2);
    // Pre-fix, the dedicated view's checkout had no `onRestoredToTop`,
    // so `fit.fit()` was never called on restore — the term stayed at
    // the bumping consumer's last-applied dims. Post-fix the dedicated
    // view's `onRestoredToTop` schedules `runFit()` (which calls
    // `fit.fit()`) via rAF.
    expect(fitCalls).toBeGreaterThan(0);

    grid.dispose();
  });

  it('drawer-grid tiles get the same theme-bg treatment via the shared mount path', () => {
    const handle = mountTileGrid({
      container: makeContainer(),
      cssPrefix: 'drawer-terminal-grid',
      centerSizeFrac: 0.9,
      centerScope: 'container',
      getSliderValue: () => 50,
    });
    handle.rebuild([{ ...makeEntry('s', 't1'), theme: 'dracula' }]);
    const preview = document.querySelector<HTMLElement>('.drawer-terminal-grid-tile-preview');
    expect(preview).not.toBeNull();
    expect(preview!.style.backgroundColor.toLowerCase()).toBe('#282a36');
    handle.dispose();
  });
});
