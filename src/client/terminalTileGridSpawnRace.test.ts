// @vitest-environment happy-dom
/**
 * HS-9486 — a double-click on a COLD dashboard tile must run exactly one
 * spawn and land in exactly one view.
 *
 * The race: `spawnAndEnlarge` only sets `tile.state = 'alive'` AFTER awaiting
 * `restartTerminal`, and both enlarge entry points gate on `state !== 'alive'`.
 * macOS's double-click threshold (~500 ms) is well past the 220 ms
 * `SINGLE_CLICK_DELAY_MS`, so an unhurried double-click fires the single-click
 * timer FIRST — starting a spawn that asks for `center` — and the `dblclick`
 * then arrives mid-flight, still sees a non-alive tile, and starts a SECOND
 * spawn asking for `dedicated`. Two `restartTerminal` calls for one PTY, two
 * `mountTileViaCheckout` runs, and a centered overlay racing a dedicated view.
 *
 * These tests hold `restartTerminal` open on a controllable deferred, which is
 * the only way to make the in-flight window wide enough to drive
 * deterministically — the real window is however long the HTTP call takes, so a
 * timing-based test would be inherently flaky.
 *
 * The tile is `exited` rather than `not_spawned` deliberately: only the exited
 * path awaits anything, so it is the only one that can be re-entered. A
 * `not_spawned` tile runs `spawnAndEnlarge` straight through with no await and
 * is already `alive` by the time `dblclick` arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetForTesting } from './terminalCheckout.js';
import { mountTileGrid, type TileEntry, type TileGridHandle } from './terminalTileGrid.js';

const { restartTerminalMock } = vi.hoisted(() => ({
  restartTerminalMock: vi.fn<(id: string, secret: string) => Promise<unknown>>(),
}));

// Partial mock — `../api/index.js` is the whole typed API layer and sibling tile
// modules pull other callers (e.g. `clearTerminalBell`) out of it, so only
// `restartTerminal` is replaced.
vi.mock('../api/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  restartTerminal: restartTerminalMock,
}));

/** A promise plus its resolver, so a test decides when the spawn completes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = () => { res(); }; });
  return { promise, resolve };
}

/** Let queued microtasks (the awaits inside `spawnAndEnlarge`) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Past `SINGLE_CLICK_DELAY_MS` (220 ms) — the real single-click timer. */
function afterSingleClickDelay(): Promise<void> {
  return new Promise(r => setTimeout(r, 260));
}

type IntersectionObserverGlobal = { IntersectionObserver?: unknown };
let savedIntersectionObserver: unknown = undefined;

/** Enlarge events observed via the grid's `onTileEnlarge` hook. */
let enlarges: string[] = [];

beforeEach(() => {
  document.body.innerHTML = '';
  _resetForTesting();
  restartTerminalMock.mockReset();
  enlarges = [];
  // happy-dom's IntersectionObserver never fires entries, so stub it away and
  // take the module's eager-mount fallback (same as terminalTileGrid.test.ts).
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

function mountExitedTile(): TileGridHandle {
  const container = document.createElement('div');
  container.style.width = '800px';
  container.style.height = '600px';
  document.body.appendChild(container);

  const handle = mountTileGrid({
    container,
    cssPrefix: 'terminal-dashboard',
    centerSizeFrac: 0.7,
    centerScope: 'viewport',
    getColumnCount: () => 4,
    onTileEnlarge: (_entry, target) => { enlarges.push(target); },
  });
  const entry: TileEntry = { id: 'cold-1', secret: 's', label: 'cold-1', state: 'exited', exitCode: 1 };
  handle.rebuild([entry]);
  return handle;
}

function tileRoot(): HTMLElement {
  const el = document.querySelector<HTMLElement>('.terminal-dashboard-tile');
  expect(el).not.toBeNull();
  return el!;
}

describe('cold-tile double-click spawn race (HS-9486)', () => {
  it('runs ONE spawn and opens ONLY the dedicated view', async () => {
    const spawn = deferred();
    restartTerminalMock.mockReturnValue(spawn.promise);
    const grid = mountExitedTile();
    const root = tileRoot();

    // Single click, then wait past the 220 ms debounce so its timer actually
    // fires and starts a spawn — this is the ordering that makes the bug.
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    expect(restartTerminalMock).toHaveBeenCalledTimes(1);

    // The double-click lands while the restart is still in flight. Pre-fix the
    // tile is still non-alive here, so this started a SECOND spawn.
    root.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();
    expect(restartTerminalMock).toHaveBeenCalledTimes(1);

    spawn.resolve();
    await flush();

    // The latest request wins: dedicated, not the center the timer asked for.
    expect(grid.isDedicatedOpen()).toBe(true);
    expect(grid.isCentered()).toBe(false);
    expect(enlarges).toEqual(['dedicated']);

    grid.dispose();
  });

  it('still centers on a plain single click (the target is not stuck on dedicated)', async () => {
    const spawn = deferred();
    restartTerminalMock.mockReturnValue(spawn.promise);
    const grid = mountExitedTile();

    tileRoot().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    spawn.resolve();
    await flush();

    expect(grid.isCentered()).toBe(true);
    expect(grid.isDedicatedOpen()).toBe(false);
    expect(enlarges).toEqual(['center']);

    grid.dispose();
  });

  it('collapses repeated clicks during one in-flight spawn into a single spawn', async () => {
    const spawn = deferred();
    restartTerminalMock.mockReturnValue(spawn.promise);
    const grid = mountExitedTile();
    const root = tileRoot();

    // An impatient user clicking a tile that seems not to respond.
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();

    expect(restartTerminalMock).toHaveBeenCalledTimes(1);
    spawn.resolve();
    await flush();
    expect(enlarges).toEqual(['center']);

    grid.dispose();
  });

  it('releases the in-flight guard so a LATER cold spawn still runs', async () => {
    // The guard must not latch: once a spawn settles, a tile that goes cold
    // again has to be spawnable. Pins that `spawning` is cleared on the
    // success path, not only on failure.
    const first = deferred();
    restartTerminalMock.mockReturnValue(first.promise);
    const grid = mountExitedTile();
    const root = tileRoot();

    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    first.resolve();
    await flush();
    expect(grid.isCentered()).toBe(true);

    // Back to the grid — while centered the tile root lives in the overlay, so
    // a click there isn't the same gesture we want to re-test.
    document.querySelector<HTMLElement>('.terminal-dashboard-center-backdrop')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(grid.isCentered()).toBe(false);

    // Same tile goes cold again. The registry key is unchanged, so `rebuild`
    // updates in place and this stays the SAME InternalTile — hence the same
    // guard. Staged through `alive` on purpose: `spawnAndEnlarge` sets
    // `tile.state` without touching `tile.entry.state`, and `updateTileFromEntry`
    // diffs against the ENTRY, so going straight back to `exited` would look
    // like no change at all and leave the tile alive.
    grid.rebuild([{ id: 'cold-1', secret: 's', label: 'cold-1', state: 'alive', exitCode: null }]);
    grid.rebuild([{ id: 'cold-1', secret: 's', label: 'cold-1', state: 'exited', exitCode: 1 }]);
    const second = deferred();
    restartTerminalMock.mockReturnValue(second.promise);

    tileRoot().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    expect(restartTerminalMock).toHaveBeenCalledTimes(2);

    second.resolve();
    await flush();

    grid.dispose();
  });

  it('does not enlarge at all when the spawn fails', async () => {
    restartTerminalMock.mockRejectedValue(new Error('restart failed'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => { /* expected */ });
    const grid = mountExitedTile();
    const root = tileRoot();

    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await afterSingleClickDelay();
    root.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await flush();

    expect(grid.isCentered()).toBe(false);
    expect(grid.isDedicatedOpen()).toBe(false);
    expect(enlarges).toEqual([]);

    consoleError.mockRestore();
    grid.dispose();
  });
});
