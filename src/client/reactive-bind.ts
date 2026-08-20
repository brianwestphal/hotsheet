/**
 * §60 / HS-8235 — DOM-binding helpers built on top of `effect()`.
 *
 * Three helpers, each returns a `() => void` disposer the caller MUST
 * invoke when the bound element leaves the DOM. The ESLint rule in
 * `eslint.config.js` flags discarded return values from `bindText` /
 * `bindAttr` to prevent the most common signals-primitive footgun
 * (orphaned effects keep firing against detached nodes — see §60.6).
 *
 * `bindList` owns its rows' lifecycles — caller doesn't manage per-row
 * disposers. When a row's key drops out of the source array, the row's
 * own effect tree is torn down and the node is detached.
 */
// HS-8342 — import via the `./reactive.js` shim per §60.4 instead of
// from `'kerfjs'` directly. The shim is the single mediation point for
// the underlying signals library — sibling helpers like this one go
// through it so a future swap (e.g. back to `@preact/signals-core`
// direct, or to a different signals primitive entirely) only touches
// `reactive.ts`.
import { bindList as kerfBindList, type ListKey } from 'kerfjs/list';

import type { ReadonlySignal, Signal } from './reactive.js';
import { effect } from './reactive.js';

type AnySignal<T> = ReadonlySignal<T> | Signal<T>;

/**
 * Bind `el.textContent` to `signal.value`. Re-runs whenever the signal
 * changes. Use for badge counts, status labels, ticket numbers, etc.
 *
 * The returned disposer stops further updates AND drops the effect's
 * reference to `el`, so the element can be GC'd once the caller drops
 * it. Idempotent — calling the disposer twice is a no-op.
 */
export function bindText(el: Element, signal: AnySignal<string | number | null | undefined>): () => void {
  return effect(() => {
    const v = signal.value;
    el.textContent = v === null || v === undefined ? '' : String(v);
  });
}

/**
 * Bind an attribute value to `signal.value`. Boolean `false` removes
 * the attribute entirely (matches HTML semantics — boolean attrs are
 * "on" by being present). `null` / `undefined` also remove. Everything
 * else is stringified via `String(v)`.
 *
 * Boolean `true` writes the attribute with an empty value (`""`),
 * matching how HTML serialises a present boolean attr in normal-form.
 */
export function bindAttr(
  el: Element,
  attr: string,
  signal: AnySignal<string | number | boolean | null | undefined>,
): () => void {
  return effect(() => {
    const v = signal.value;
    if (v === false || v === null || v === undefined) {
      el.removeAttribute(attr);
    } else if (v === true) {
      el.setAttribute(attr, '');
    } else {
      el.setAttribute(attr, String(v));
    }
  });
}

/**
 * Keyed list reconciliation against `signal.value`. Re-runs whenever
 * the signal's array reference changes. Items keep DOM identity across
 * updates by `key(item)`; new items get rendered via `render(item)`,
 * removed items get their per-row disposer called and the node detached,
 * order changes shuffle existing nodes via `insertBefore`.
 *
 * `render(item)` may set up further `bindText` / `bindAttr` against
 * per-item signals — return their disposers (or a single composed one)
 * via the `dispose` field on `RenderResult`. The returned disposer is
 * called when the row is removed from the list or when the outer
 * `bindList` is disposed.
 *
 * Key extraction is mandatory — no "use object identity" mode. That
 * way reorder + immutable-update flows (the dominant pattern in this
 * codebase) work without surprise re-renders.
 *
 * Implementation notes:
 * - Two-pass reconcile (build keep-set → tear down strays → walk new
 *   order, reinsert in place). Naive but correct for the lists we
 *   currently rebuild manually (project tabs ≤ ~20 entries; ticket
 *   list typically ≤ 200; command log ≤ 100). A longest-common-
 *   subsequence reorder is a half-day's drop-in if a real consumer
 *   feels the layout thrash on long lists (§60.7).
 * - Renders are plain DOM elements, NOT `SafeHtml`. Callers convert
 *   JSX via the existing `toElement(<jsx />)` helper inside `render`.
 *   This keeps the JSX-runtime adoption decision (HS-8241+ / §62)
 *   orthogonal to the reactivity primitive.
 */
export interface BindListRenderResult {
  el: Element;
  dispose?: () => void;
}

/**
 * HS-8371 / KERF-EVAL (feature 3, beta.5) — viewport virtualization for a long
 * keyed list, now kerf 4.2's NATIVE `bindList({ virtualize })`. kerf owns the
 * windowing end to end: `scrollParent` IS the scroll container (kerf reads its
 * `scrollTop` / `clientHeight` and listens for its `scroll`), and kerf creates +
 * owns an inner rows `<div>` inside it, mounting only the rows intersecting the
 * viewport (plus `overscan` above + below) and padding that inner div so
 * `scrollHeight` matches the full N × `rowHeight`. Rows keep DOM identity by
 * `key` exactly as in the non-virtualized `bindList`.
 *
 * This replaced Hot Sheet's hand-rolled wrapper (a derived windowed signal + a
 * padding effect + a scroll listener + a below-threshold fast path): ~80 lines →
 * one delegating call. kerf re-windows on every scroll (via `requestAnimationFrame`,
 * coalescing a rapid scroll to one re-window per frame) and, where `ResizeObserver`
 * exists, on the container resizing — so a list mounted before layout
 * (`clientHeight` 0) fills in once it's sized (KF-506, beta.6), no manual nudge.
 *
 * **`minRows` keeps small lists fully rendered — no call-site branch (KF-504,
 * beta.6).** Below `minRows` kerf renders EVERY row (no windowing, zero padding);
 * at or above it, it windows — and the DOM structure (kerf's inner container) is
 * identical either way. Hot Sheet WANTS small/medium lists fully in the DOM (for
 * find-in-page, screen readers, DOM-count tests), and `minRows` gives that without
 * the caller branching on list length. `containerClass` classes kerf's inner
 * container (KF-505) so `.ticket-list-rows` (the detachment marker + sidebar e2e
 * hook) is set declaratively — no `lastElementChild` guessing.
 *
 * **Fixed-height only here.** `opts.rowHeight` is a fixed pixel height (every
 * `.ticket-row` variant is 32 px). kerf also supports variable / measured heights
 * (`rowHeight` as a `(item, i) => number`, or `{ estimate }` + `setHeight` /
 * `observeRowHeights`) — that's the path for a future variable-height surface
 * (the HS-8373 column-view case), not needed for the fixed-height ticket list.
 *
 * **Multi-select / keyboard-nav scope.** Off-viewport rows are NOT in the DOM,
 * so consumers must read selection from state (`state.selectedIds` +
 * `filteredTickets.value`), never from a live `.ticket-row[data-id]` query — the
 * ticket-list keyboard handlers already do (audited under HS-8371).
 */
export function bindListVirtualized<T>(
  scrollParent: HTMLElement,
  source: AnySignal<readonly T[]>,
  key: (item: T) => unknown,
  render: (item: T) => BindListRenderResult,
  opts: { rowHeight: number; overscan?: number; minRows?: number; containerClass?: string },
): () => void {
  return kerfBindList(scrollParent, source, {
    key: (item) => key(item) as ListKey,
    render: (item) => {
      const r = render(item);
      return { el: r.el as HTMLElement, dispose: r.dispose };
    },
    virtualize: {
      rowHeight: opts.rowHeight,
      overscan: opts.overscan ?? 10,
      // KF-504 (beta.6) — below `minRows` kerf renders EVERY row (no windowing),
      // windowing only at/above it; the inner container is the same either way, so
      // the CALL SITE no longer branches on list length for find-in-page / a11y /
      // DOM-count. KF-505 — `containerClass` classes kerf's inner rows container
      // declaratively (no `lastElementChild` guessing; also `handle.container`).
      minRows: opts.minRows,
      containerClass: opts.containerClass,
    },
  });
}

/**
 * KERF-EVAL (feature 3 / KF-492) — the local three-pass keyed reconcile (build
 * keep-set → tear down strays → walk order + `insertBefore`) is now kerf 4.2's
 * `bindList` in **element mode**: `render` returns the row element (plus an
 * optional `dispose`) and kerf keys / moves / reuses the SAME element across
 * append / remove / reorder, running `dispose` only on genuine removal — the
 * exact contract this function had. beta.4 fixed the element-mode reuse bug I
 * filed as KF-492 (beta.3 re-rendered every row); the reactive-bind test suite
 * (append-reuses-node, remove-disposes-only-removed, reorder-preserves-identity)
 * pins the equivalence.
 *
 * The adapter bridges the two type shapes: our `key` returns `unknown` (kerf
 * wants `string | number`) and our `BindListRenderResult.el` is `Element` (kerf
 * wants `HTMLElement`) — both narrowings hold for every real caller (keys are
 * ids/strings; rows are `toElement(<jsx/>)` HTML elements).
 *
 * `opts.before` (KF-496, kerf beta.5) keeps the rows as a contiguous block
 * ending just before a fixed trailing sibling, so a list can share its `parent`
 * with a non-row control (an "add" button, an indicator) without kerf — which
 * otherwise anchors rows to the parent's end — reordering it. Used by the
 * project-tabs strip; omit it and kerf assumes exclusive ownership of `parent`.
 */
export function bindList<T>(
  parent: Element,
  signal: AnySignal<readonly T[]>,
  key: (item: T) => unknown,
  render: (item: T) => BindListRenderResult,
  opts?: { before?: Node | (() => Node | null) },
): () => void {
  return kerfBindList(parent as HTMLElement, signal, {
    key: (item) => key(item) as ListKey,
    render: (item) => {
      const r = render(item);
      return { el: r.el as HTMLElement, dispose: r.dispose };
    },
    before: opts?.before,
  });
}
