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

interface ListEntry {
  key: unknown;
  el: Element;
  dispose: (() => void) | undefined;
}

export function bindList<T>(
  parent: Element,
  signal: AnySignal<readonly T[]>,
  key: (item: T) => unknown,
  render: (item: T) => BindListRenderResult,
): () => void {
  // Map of key → entry, holding the live row + its per-row disposer.
  const live = new Map<unknown, ListEntry>();

  const stop = effect(() => {
    const items = signal.value;
    // Pass 1: figure out which existing keys survive AND construct any
    // new rows up-front so subsequent `insertBefore` calls have a node
    // to move. Stash the desired order so pass 2 can walk it linearly.
    const desired: ListEntry[] = [];
    const survivors = new Set<unknown>();
    for (const item of items) {
      const k = key(item);
      survivors.add(k);
      let entry = live.get(k);
      if (entry === undefined) {
        const result = render(item);
        entry = { key: k, el: result.el, dispose: result.dispose };
        live.set(k, entry);
      }
      desired.push(entry);
    }
    // Pass 2: tear down rows whose key didn't survive — dispose first,
    // then detach. Disposing first ensures any per-row effects don't
    // re-fire against an in-flight detach.
    for (const [k, entry] of live) {
      if (!survivors.has(k)) {
        if (entry.dispose !== undefined) {
          try { entry.dispose(); } catch { /* swallow — caller's bug, don't block list update */ }
        }
        if (entry.el.parentNode === parent) parent.removeChild(entry.el);
        live.delete(k);
      }
    }
    // Pass 3: walk `desired` left-to-right. For each position, if the
    // current child at that index is the wrong node, `insertBefore`
    // moves the right node into place. Cheap on no-op renders (every
    // `insertBefore` of an already-positioned node is a browser no-op).
    for (let i = 0; i < desired.length; i++) {
      const want = desired[i].el;
      // `parent.childNodes[i]` is typed as ChildNode (non-nullable) under
      // strict lib types, but at runtime it returns undefined past the
      // current length. Pick `null` explicitly for the insertBefore-at-end
      // case so the move is well-defined.
      const have = i < parent.childNodes.length ? parent.childNodes[i] : null;
      if (have !== want) {
        parent.insertBefore(want, have);
      }
    }
  });

  // Outer disposer tears down the watching effect AND every live row's
  // per-row disposer. Detaching the rows themselves is the caller's
  // responsibility (typically by replacing or detaching `parent`).
  return () => {
    stop();
    for (const entry of live.values()) {
      if (entry.dispose !== undefined) {
        try { entry.dispose(); } catch { /* swallow */ }
      }
    }
    live.clear();
  };
}
