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
import { computed, effect, signal } from './reactive.js';

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
 * HS-8371 — viewport-aware wrapper around `bindList` that only mounts
 * the rows intersecting the visible scroll window (plus a configurable
 * buffer above + below). For lists below `opts.threshold` rows the
 * wrapper is a no-op and delegates verbatim to `bindList`; for lists
 * above the threshold it slices `signal.value` to the visible window
 * + pads `parent` with `padding-top` / `padding-bottom` to keep the
 * scrollbar honest (the parent ends up with the same `scrollHeight`
 * as if every row were mounted).
 *
 * **Design choice — wrap `bindList`, don't refactor it.** `bindList` is
 * consumed by several non-virtualized surfaces (project tabs, command
 * log, ticket detail attachments, etc.). Going INSIDE `bindList` to
 * make it viewport-aware would force every consumer to pay viewport-
 * detection cost OR add a feature flag to the helper signature that
 * complicates the contract. The wrapper here is a thin slice-and-
 * resubscribe over the source signal — bindList stays unchanged for
 * other consumers (zero overhead), and the keyed-reconcile logic
 * inside bindList does the right thing when the windowed slice
 * shifts (new ids appear → mount fresh rows; old ids disappear → tear
 * down their per-row disposers).
 *
 * **Fixed-height assumption.** `opts.rowHeight` is fixed; rows
 * outside the window are accounted for purely by padding-top /
 * padding-bottom on `parent`. Variable-height rows (e.g. column-card
 * variants where the title wraps to multiple lines) need an estimated-
 * height-with-refinement system — out of scope for HS-8371 (Phase 1
 * is the default list variant only); see HS-8373 (Phase 3) for the
 * column-view case.
 *
 * **Below-threshold path.** When `items.length < threshold`, the
 * wrapper returns the full slice verbatim with zero padding. Skipping
 * virtualization for small lists keeps the no-overhead promise — a
 * 20-ticket project doesn't pay for scroll-listener registration or
 * scroll-position-to-window math.
 *
 * **Scroll container.** Defaults to `parent.parentElement`, which is
 * where Hot Sheet's `#ticket-list` scrollbar lives. Callers can
 * override via `opts.scrollContainer` for tests or future surfaces
 * where the scroll ancestor isn't the immediate parent.
 *
 * **Multi-select / keyboard-nav scope.** Off-viewport rows are NOT in
 * the DOM. Any consumer that reads from a `.ticket-row[data-id]`
 * DOM query would silently see a shrunken set. The Hot Sheet
 * keyboard handlers in `src/client/shortcuts.tsx` already read from
 * `state.selectedIds` + `filteredTickets.value` directly, NOT from
 * the live DOM (audited under HS-8371 Phase 1 implementation); verify
 * in tests that this contract holds.
 */
export function bindListVirtualized<T>(
  parent: HTMLElement,
  source: AnySignal<readonly T[]>,
  key: (item: T) => unknown,
  render: (item: T) => BindListRenderResult,
  opts: { rowHeight: number; buffer?: number; threshold?: number; scrollContainer?: HTMLElement },
): () => void {
  const rowHeight = opts.rowHeight;
  const buffer = opts.buffer ?? 10;
  const threshold = opts.threshold ?? 100;
  const scrollContainer: HTMLElement | null = opts.scrollContainer ?? parent.parentElement;

  // Below-threshold fast path — delegate to plain `bindList` with no
  // padding side effects and no scroll listener. The wrapper's overhead
  // collapses to a single `bindList` call + the outer disposer wrapper.
  // This branch decision is taken at MOUNT TIME using the source
  // signal's current value; if the project grows past the threshold
  // mid-session the wrapper stays in delegate mode until next remount.
  // For HS-8371's use case (the ticket-list re-mounts on every variant
  // switch + project switch), that's the natural boundary — a growing
  // project that crosses the threshold rebuilds the bindList on the
  // next mutation that triggers a fresh setTickets pass.
  if (scrollContainer === null || source.value.length < threshold) {
    return bindList(parent, source, key, render);
  }

  // Local signal for the scroll position. We feed it via a scroll-
  // event listener on `scrollContainer`. Updating this signal flows
  // through `windowedSignal` (the derived slice) and re-fires the
  // bindList reconcile.
  const scrollTop = signal(scrollContainer.scrollTop);

  // Derived signal — the visible slice. Pure read of `source.value`
  // and `scrollTop.value`; the padding mutation lives in a separate
  // `effect()` below so this stays a clean computed (no DOM side
  // effects inside computed) and the wrapper's behavior stays
  // testable without a layout system.
  const windowedSignal: ReadonlySignal<readonly T[]> = computed(() => {
    const items = source.value;
    if (items.length < threshold) return items;
    const top = scrollTop.value;
    const viewportHeight = scrollContainer.clientHeight || 600;
    const startIdx = Math.max(0, Math.floor(top / rowHeight) - buffer);
    const endIdx = Math.min(items.length, Math.ceil((top + viewportHeight) / rowHeight) + buffer);
    return items.slice(startIdx, endIdx);
  });

  // Side-effect: mutate `parent.style.paddingTop` / `paddingBottom`
  // to keep the scrollbar honest. Padding placeholders the
  // before-window + after-window rows so the parent's `scrollHeight`
  // equals the full N × rowHeight even though only the window-slice
  // children are mounted.
  const paddingEffectDispose = effect(() => {
    const items = source.value;
    if (items.length < threshold) {
      parent.style.paddingTop = '0px';
      parent.style.paddingBottom = '0px';
      return;
    }
    const top = scrollTop.value;
    const viewportHeight = scrollContainer.clientHeight || 600;
    const startIdx = Math.max(0, Math.floor(top / rowHeight) - buffer);
    const endIdx = Math.min(items.length, Math.ceil((top + viewportHeight) / rowHeight) + buffer);
    parent.style.paddingTop = `${String(startIdx * rowHeight)}px`;
    parent.style.paddingBottom = `${String((items.length - endIdx) * rowHeight)}px`;
  });

  // Scroll listener — wires scrollTop position into the local signal.
  // `{ passive: true }` so we don't block the browser's scroll thread.
  const onScroll = (): void => { scrollTop.value = scrollContainer.scrollTop; };
  scrollContainer.addEventListener('scroll', onScroll, { passive: true });

  // Delegate to plain `bindList` against the windowed signal. bindList's
  // keyed-reconcile path handles the slice shifting cleanly.
  const stopBindList = bindList(parent, windowedSignal, key, render);

  return () => {
    scrollContainer.removeEventListener('scroll', onScroll);
    paddingEffectDispose();
    stopBindList();
    // Reset padding so a future re-mount of `parent` with plain
    // children doesn't inherit stale offsets.
    parent.style.paddingTop = '';
    parent.style.paddingBottom = '';
  };
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
