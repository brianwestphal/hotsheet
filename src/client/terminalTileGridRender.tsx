import type { SafeHtml } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { effect, signal } from './reactive.js';
import {
  applyAppearanceToTerm,
  getProjectDefault,
  getSessionOverride,
  resolveAppearance,
} from './terminalAppearance.js';
import {
  computeTileScale,
  innerContentWidth,
  TILE_ASPECT,
  tileWidthFromColumnCount,
} from './terminalDashboardSizing.js';
import { getThemeById, themeToXtermOptions } from './terminalThemes.js';
import type { TileEntry, TileSessionState } from './terminalTileGrid.js';
import { onTileClick, onTileDblClick } from './terminalTileGridCenter.js';
import { tileKey, tileKeyFor } from './terminalTileGridKeys.js';
import { markTileMounted, mountTileViaCheckout, softDisposeTile } from './terminalTileGridLifecycle.js';
import type { InternalTile, TileGridContext } from './terminalTileGridTypes.js';
import { TILE_INITIAL_COLS, TILE_INITIAL_ROWS } from './terminalTileGridTypes.js';
import { initialTileState } from './terminalTileVirtualization.js';

const PLAY_GLYPH: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"/></svg>;

/**
 * HS-8412 / HS-8411 (Cycle 4a lift + Cycle 4b split) — tile DOM
 * construction, sizing math, appearance resolution, and HS-8313
 * in-place property updates for surviving tiles across `bindList`
 * rebuilds.
 *
 * Imports from `…Center` (click + dblclick handlers for the new
 * tile's event listeners) and `…Lifecycle` (mount + dispose paths
 * for state transitions inside `updateTileFromEntry`). Forms
 * function-level circular imports with both — ES modules resolve
 * those fine.
 */

// --- Appearance ---

export function resolveTileAppearance(_ctx: TileGridContext, tile: InternalTile) {
  const configOverride: { theme?: string; fontFamily?: string; fontSize?: number } = {};
  if (tile.entry.theme !== undefined) configOverride.theme = tile.entry.theme;
  if (tile.entry.fontFamily !== undefined) configOverride.fontFamily = tile.entry.fontFamily;
  if (tile.entry.fontSize !== undefined) configOverride.fontSize = tile.entry.fontSize;
  return resolveAppearance({
    // HS-8283 — resolve against the TILE's project default, not the
    // active project's. The Terminal Dashboard shows tiles for terminals
    // across every open project; pre-fix every tile resolved against the
    // single shared cache (which only ever held the active project's
    // value), so non-active projects' tiles flashed to defaults whenever
    // the active project switched.
    projectDefault: getProjectDefault(tile.entry.secret),
    configOverride,
    sessionOverride: getSessionOverride(tile.entry.id),
  });
}

// --- DOM construction ---

export function renderPreviewContent(ctx: TileGridContext, state: TileSessionState, exitCode: number | null): HTMLElement {
  const c = ctx.classes;
  if (state === 'alive') {
    return toElement(<div className={c.placeholderClass}></div>);
  }
  const status = state === 'exited'
    ? (exitCode === null ? 'Exited' : `Exited (code ${exitCode})`)
    : 'Not yet started';
  return toElement(
    <div className={`${c.placeholderClass} ${c.placeholderColdClass}`}>
      {PLAY_GLYPH}
      <span className={c.placeholderStatusClass}>{status}</span>
    </div>
  );
}

export function renderTile(ctx: TileGridContext, entry: TileEntry): HTMLElement {
  const c = ctx.classes;
  const cssPrefix = ctx.cssPrefix;
  const opts = ctx.opts;
  const initialBell = entry.bellPending === true;
  const cwdLabel = entry.cwdLabel ?? '';
  const cwdRaw = entry.cwdRaw ?? '';
  // HS-7662 — flow-mode project prefix: `{ProjectName} ›` BEFORE the
  // terminal label on the first tile of each project's run. Absent in
  // sectioned mode and on subsequent tiles in the same project run.
  // HS-7824 dropped the colored badge dot that originally sat in front
  // of the prefix.
  const badge = entry.projectBadge;
  const fullLabelTitle = badge?.name !== undefined && badge.name !== ''
    ? `${badge.name} › ${entry.label}`
    : entry.label;
  // HS-8469 — `has-bell` is no longer baked into the initial className.
  // The bell-effect below subscribes to `bellPending` and toggles the
  // class via `classList.toggle`, so the class only exists when the
  // signal says so. `bellPending` is seeded with `initialBell` and the
  // effect fires synchronously on creation, applying the initial class
  // (if any) before the tile is returned.
  const root = toElement(
    <div
      className={`${c.tileClass} ${c.tileClass}-${entry.state}`}
      data-secret={entry.secret}
      data-terminal-id={entry.id}
    >
      <div className={c.previewClass}>
      </div>
      <div className={c.labelClass} title={fullLabelTitle}>
        {badge?.name !== undefined && badge.name !== ''
          // HS-7943 follow-up — only the project name itself should
          // carry the link affordance (pointer cursor + accent underline
          // on hover); the trailing ` › ` chevron stays as muted plain
          // text. Pre-fix the whole `{name} › ` span was the click +
          // hover target, so the chevron was underlined alongside the
          // name. The click listener stays on the outer span so a click
          // on the chevron still routes (matches the pre-fix click
          // hitbox); SCSS scopes the hover affordance to the inner name
          // span only.
          ? <span className={`${cssPrefix}-tile-project${opts.onProjectBadgeClick !== undefined ? ' is-clickable' : ''}`} title={`Switch to ${badge.name}`}><span className={`${cssPrefix}-tile-project-name`}>{badge.name}</span>{' › '}</span>
          : null}
        <span className={`${cssPrefix}-tile-name`}>{entry.label}</span>
        {/* HS-8286 — per-tile "Server slow" chip removed. Stall
            detection feeds the global server-slow banner via the per-
            entry watcher in `terminalCheckout.tsx::createEntry`. */}
      </div>
      {cwdLabel === ''
        ? null
        : <div className={c.cwdClass} title={cwdRaw}>{cwdLabel}</div>}
    </div>
  );

  // HS-7943 — project-badge click switches to that project's tab. The
  // listener is wired only when the callsite passes a handler (sectioned
  // mode never renders the badge prefix, so its tiles get no listener
  // either — checking the callback at attach time keeps the hover
  // affordance consistent with the actual behavior). `stopPropagation`
  // beats the tile-center click handler that sits on the tile root.
  if (opts.onProjectBadgeClick !== undefined && badge?.name !== undefined && badge.name !== '') {
    const projectEl = root.querySelector<HTMLElement>(`.${cssPrefix}-tile-project`);
    const onProjectBadgeClick = opts.onProjectBadgeClick;
    if (projectEl !== null) {
      projectEl.addEventListener('click', (e) => {
        e.stopPropagation();
        onProjectBadgeClick(entry);
      });
    }
  }
  const preview = root.querySelector<HTMLElement>(`.${c.previewClass}`);
  const labelEl = root.querySelector<HTMLElement>(`.${c.labelClass}`);
  if (preview === null || labelEl === null) return root;
  preview.appendChild(renderPreviewContent(ctx, entry.state, entry.exitCode));

  // HS-8469 — bell-pending signal + class-toggle effect. The signal is
  // the source of truth (consumers in `syncBellState` write to it); the
  // effect mirrors writes to `root.classList`. Fires synchronously on
  // creation so the initial-bell case applies the class before the
  // caller receives the element.
  const bellPending = signal<boolean>(initialBell);
  const bellEffectDispose = effect(() => {
    root.classList.toggle('has-bell', bellPending.value);
  });

  const tile: InternalTile = {
    entry,
    state: entry.state,
    exitCode: entry.exitCode,
    root,
    preview,
    labelEl,
    checkout: null,
    xtermRoot: null,
    gridPreviewWidth: 0,
    gridPreviewHeight: 0,
    targetCols: TILE_INITIAL_COLS,
    targetRows: TILE_INITIAL_ROWS,
    cachedCellW: null,
    cachedCellH: null,
    slotPlaceholder: null,
    screenObserver: null,
    termHandlerDisposers: [],
    bellPending,
    bellEffectDispose,
  };
  const key = tileKeyFor(entry);
  ctx.tiles.set(key, tile);

  // HS-7968 — virtualized mount. Tile starts unmounted; the IntersectionObserver
  // drives mount/dispose based on viewport visibility. Tiles in non-alive
  // state never auto-mount (no PTY to attach to); spawn-and-enlarge still
  // mounts eagerly via `spawnAndEnlarge`. When the observer is unavailable
  // (test envs without IO) we fall back to the eager-mount behavior so tests
  // don't have to install a polyfill.
  ctx.virtState.set(key, initialTileState());
  const observer = ctx.virtObserver.current;
  if (observer !== null) {
    ctx.virtRootToId.set(root, key);
    observer.observe(root);
  } else if (entry.state === 'alive') {
    mountTileViaCheckout(ctx, tile);
    markTileMounted(ctx, tile);
  }

  root.addEventListener('click', (e) => { onTileClick(ctx, tile, e); });
  root.addEventListener('dblclick', (e) => { onTileDblClick(ctx, tile, e); });
  if (opts.onContextMenu !== undefined) {
    const handler = opts.onContextMenu;
    root.addEventListener('contextmenu', (e) => { handler(tile.entry, e); });
  }

  return root;
}

// --- Tile sizing ---

export function applySizing(ctx: TileGridContext): void {
  const c = ctx.classes;
  const opts = ctx.opts;
  // HS-8442 — use the container's actual content-area width, not the
  // hard-coded outer-dashboard padding. See `innerContentWidth` for the
  // failure mode this closes.
  const rootWidth = innerContentWidth(opts.container);
  if (rootWidth <= 0) return;
  const columnCount = opts.getColumnCount();
  const tileWidth = tileWidthFromColumnCount(columnCount, rootWidth);
  const tileHeight = Math.round(tileWidth / TILE_ASPECT);

  for (const tile of opts.container.querySelectorAll<HTMLElement>(`.${c.tileClass}`)) {
    if (!tile.classList.contains('centered')) {
      tile.style.width = `${tileWidth}px`;
    }
    const preview = tile.querySelector<HTMLElement>(`.${c.previewClass}`);
    if (preview !== null && !tile.classList.contains('centered')) {
      preview.style.width = `${tileWidth}px`;
      preview.style.height = `${tileHeight}px`;
    }
    const xtermRoot = tile.querySelector<HTMLElement>(`.${c.xtermClass}`);
    if (xtermRoot !== null && !tile.classList.contains('centered')) {
      applyTileScale(ctx, xtermRoot, tileWidth, tileHeight);
    }
    // HS-8285 follow-up — read both `data-secret` and `data-terminal-id`
    // so the lookup hits the per-(secret, id) tile rather than the wrong
    // project's tile when two projects share an id (e.g., 'default').
    const tsec = tile.dataset.secret ?? '';
    const tid = tile.dataset.terminalId ?? '';
    const live = ctx.tiles.get(tileKey(tsec, tid));
    if (live !== undefined) {
      live.gridPreviewWidth = tileWidth;
      live.gridPreviewHeight = tileHeight;
    }
  }
}

export function reapplyTileScaleFromPreview(ctx: TileGridContext, tile: InternalTile): void {
  if (tile.xtermRoot === null) return;
  const pw = tile.preview.offsetWidth;
  const ph = tile.preview.offsetHeight;
  if (pw <= 0 || ph <= 0) return;
  applyTileScale(ctx, tile.xtermRoot, pw, ph);
}

export function applyTileScale(_ctx: TileGridContext, xtermRoot: HTMLElement, tileWidth: number, tileHeight: number): void {
  xtermRoot.style.transform = '';
  xtermRoot.style.transformOrigin = 'top left';
  xtermRoot.style.width = '';
  xtermRoot.style.height = '';
  xtermRoot.style.position = '';
  xtermRoot.style.left = '';
  xtermRoot.style.top = '';

  const screen = xtermRoot.querySelector<HTMLElement>('.xterm-screen');
  const naturalWidth = screen?.offsetWidth ?? 0;
  const naturalHeight = screen?.offsetHeight ?? 0;
  const scale = computeTileScale(tileWidth, tileHeight, naturalWidth, naturalHeight);
  if (scale === null) {
    // HS-8288 — when there's no live `.xterm-screen` in this xtermRoot
    // (the consumer is currently bumped down — `mountInto` holds the
    // `.terminal-checkout-placeholder` div instead of the live xterm)
    // we still need to give the xtermRoot a definite box. Pre-fix the
    // function bailed here AFTER clearing every inline size style, so
    // xtermRoot rendered as 0×0 — and the placeholder's CSS
    // `width: 100% / height: 100%` collapsed against the 0-height
    // parent, leaving the user with a blank tile (or a totally
    // missing tile in the layout, the "0x0 px" symptom). Snap to the
    // tile slot dims so the placeholder fills the tile box just like
    // the live xterm would. `position: relative` is required so the
    // placeholder (which has its own `width: 100% / height: 100%`)
    // resolves against this box. Tile dims of 0 (slot collapsed
    // mid-relayout) still bail — let the next applySizing tick paint
    // a real box.
    if (tileWidth > 0 && tileHeight > 0) {
      xtermRoot.style.position = 'relative';
      xtermRoot.style.width = `${tileWidth}px`;
      xtermRoot.style.height = `${tileHeight}px`;
    }
    return;
  }

  xtermRoot.style.position = 'absolute';
  xtermRoot.style.left = `${scale.left}px`;
  xtermRoot.style.top = `${scale.top}px`;
  xtermRoot.style.width = `${scale.width}px`;
  xtermRoot.style.height = `${scale.height}px`;
  xtermRoot.style.transform = `scale(${scale.scale})`;
}

// --- HS-8313 — in-place property updates for surviving tiles ---

/** HS-8313 — apply a fresh `TileEntry`'s property changes to a
 *  surviving tile in place. Pre-fix every `rebuild()` destroyed and
 *  re-created the tile, so all property changes propagated for free
 *  via the renderTile path. The bindList migration preserves identity
 *  for surviving keys, so we have to actively diff the entry fields
 *  and update the matching DOM / checkout state. State transitions
 *  (alive ↔ exited / not_spawned) are the most structural — they
 *  release the checkout or re-mount it; the rest are cosmetic. */
export function updateTileFromEntry(ctx: TileGridContext, tile: InternalTile, newEntry: TileEntry): void {
  const c = ctx.classes;
  const oldEntry = tile.entry;
  tile.entry = newEntry;

  const stateChanged = oldEntry.state !== newEntry.state;
  const exitCodeChanged = oldEntry.exitCode !== newEntry.exitCode;

  if (stateChanged) {
    tile.root.classList.remove(`${c.tileClass}-${oldEntry.state}`);
    tile.root.classList.add(`${c.tileClass}-${newEntry.state}`);
    tile.state = newEntry.state;
  }
  if (exitCodeChanged) tile.exitCode = newEntry.exitCode;

  if (stateChanged) {
    if (oldEntry.state === 'alive' && newEntry.state !== 'alive') {
      // alive → exited / not_spawned: release the live checkout, drop
      // the preview to a placeholder. Reuses softDisposeTile, which
      // leaves the tile in `tiles` + virtualization registries (same
      // shape used by the off-screen virt-dispose path).
      softDisposeTile(ctx, tile);
    } else if (oldEntry.state !== 'alive' && newEntry.state === 'alive') {
      // not-alive → alive: when IO is unavailable (test envs) the
      // renderTile path eager-mounts; mirror that for in-place
      // transitions so the new state is reflected immediately. With
      // IO available, leave the mount to the next observer cycle —
      // the tile may not be in the viewport, in which case eager-
      // mounting would defeat virtualization. (Tile re-renders the
      // alive placeholder via softDisposeTile-style cleanup of the
      // stale exited / not_spawned placeholder.)
      if (ctx.virtObserver.current === null) {
        mountTileViaCheckout(ctx, tile);
        markTileMounted(ctx, tile);
      } else if (tile.checkout === null) {
        // No live xterm — refresh placeholder so the visual matches
        // the new alive state (will be replaced on next mount).
        tile.preview.replaceChildren(renderPreviewContent(ctx, tile.state, tile.exitCode));
      }
    } else if (tile.checkout === null) {
      // exited ↔ not_spawned (both placeholder states): refresh the
      // placeholder with the new label / icon.
      tile.preview.replaceChildren(renderPreviewContent(ctx, tile.state, tile.exitCode));
    }
  } else if (exitCodeChanged && newEntry.state !== 'alive' && tile.checkout === null) {
    // Same not-alive state, exit code changed (e.g., a `not_spawned`
    // becoming `exited` with the same outer state class — won't happen
    // in practice but covered for completeness).
    tile.preview.replaceChildren(renderPreviewContent(ctx, tile.state, tile.exitCode));
  }

  // Label / projectBadge — re-render label area when either changed.
  const oldBadgeName = oldEntry.projectBadge?.name ?? '';
  const newBadgeName = newEntry.projectBadge?.name ?? '';
  if (oldEntry.label !== newEntry.label || oldBadgeName !== newBadgeName) {
    rerenderTileLabel(ctx, tile);
  }

  // CWD chip — add / remove / update the chip element.
  const oldCwd = oldEntry.cwdLabel ?? '';
  const newCwd = newEntry.cwdLabel ?? '';
  const oldCwdRaw = oldEntry.cwdRaw ?? '';
  const newCwdRaw = newEntry.cwdRaw ?? '';
  if (oldCwd !== newCwd || oldCwdRaw !== newCwdRaw) {
    updateTileCwdChip(ctx, tile, newCwd, newCwdRaw);
  }

  // Appearance — re-apply to the live xterm if mounted. (When not
  // mounted, the next mountTileViaCheckout reads tile.entry directly
  // via resolveTileAppearance so the new override values are picked
  // up automatically without further work here.)
  if (oldEntry.theme !== newEntry.theme
      || oldEntry.fontFamily !== newEntry.fontFamily
      || oldEntry.fontSize !== newEntry.fontSize) {
    if (tile.checkout !== null) {
      const appearance = resolveTileAppearance(ctx, tile);
      const themeData = getThemeById(appearance.theme) ?? getThemeById('default')!;
      tile.checkout.term.options.theme = themeToXtermOptions(themeData);
      void applyAppearanceToTerm(tile.checkout.term, appearance);
      tile.preview.style.backgroundColor = themeData.background;
    }
  }
}

/** HS-8313 — rebuild the tile's labelEl content from `tile.entry`.
 *  Mirrors the JSX in renderTile so flow-mode badge prefixes + the
 *  inner clickable handler stay in sync across in-place label
 *  updates. */
function rerenderTileLabel(ctx: TileGridContext, tile: InternalTile): void {
  const cssPrefix = ctx.cssPrefix;
  const opts = ctx.opts;
  const entry = tile.entry;
  const badge = entry.projectBadge;
  const fullLabelTitle = badge?.name !== undefined && badge.name !== ''
    ? `${badge.name} › ${entry.label}`
    : entry.label;
  tile.labelEl.title = fullLabelTitle;

  const newChildren: Element[] = [];
  if (badge?.name !== undefined && badge.name !== '') {
    const projectSpan = toElement(
      <span className={`${cssPrefix}-tile-project${opts.onProjectBadgeClick !== undefined ? ' is-clickable' : ''}`} title={`Switch to ${badge.name}`}>
        <span className={`${cssPrefix}-tile-project-name`}>{badge.name}</span>{' › '}
      </span>,
    );
    if (opts.onProjectBadgeClick !== undefined) {
      const onProjectBadgeClick = opts.onProjectBadgeClick;
      projectSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        onProjectBadgeClick(entry);
      });
    }
    newChildren.push(projectSpan);
  }
  newChildren.push(toElement(<span className={`${cssPrefix}-tile-name`}>{entry.label}</span>));
  tile.labelEl.replaceChildren(...newChildren);
}

/** HS-8313 — add / remove / update the optional CWD chip on a surviving
 *  tile. The chip lives as a sibling of `tile.preview` + `tile.labelEl`
 *  inside the tile root; renderTile only emits it when `cwdLabel` is
 *  non-empty, so this helper has to handle the absent → present and
 *  present → absent transitions in addition to text updates. */
function updateTileCwdChip(ctx: TileGridContext, tile: InternalTile, cwdLabel: string, cwdRaw: string): void {
  const cwdClass = ctx.classes.cwdClass;
  const existing = tile.root.querySelector<HTMLElement>(`.${cwdClass}`);
  if (cwdLabel === '') {
    existing?.remove();
    return;
  }
  if (existing !== null) {
    existing.textContent = cwdLabel;
    existing.title = cwdRaw;
  } else {
    tile.root.appendChild(toElement(<div className={cwdClass} title={cwdRaw}>{cwdLabel}</div>));
  }
}
