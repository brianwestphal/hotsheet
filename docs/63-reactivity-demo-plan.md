# 63. Reactivity migration plan (TENTATIVE — pending demo review)

> **Status:** Tentative. This document supersedes parts of [§60](60-reactivity-primitive.md), [§61](61-composable-stores.md), and [§62](62-unified-jsx-render-targets.md) **only if the demo at `/_demo/reactivity` is approved.** If approved, this document is deleted and the relevant content is rolled back into §60 / §61 / §62, the `HS-8235`–`HS-8243` follow-up tickets are rewritten, and the migration begins. If rejected, this document is deleted and §60 / §61 / §62 stay as-is.

## 63.1 Why this exists

The original §60 / §61 / §62 design split reactivity into three concerns:
- §60 — fine-grained signals + three keyed-binding helpers (`bindText` / `bindAttr` / `bindList`).
- §61 — composable stores layered on §60.
- §62 — replace the client's `innerHTML`-roundtrip render path with a shared AST + dual `astToHtml` / `astToDom` consumers, permanently closing the SVG-namespace / entity / whitespace divergence bug class.

Cross-checking against `~/Documents/smalltale/src/app/scripts/modules/cardEditor/morphDom.ts` (smalltale's existing `morphdom` wrapper for its card editor) and reading [smalltale's rationale doc](../../smalltale/docs/64-card-editor-dom-diffing.md) surfaced a cleaner shape:

- **`morphdom` is a much better fit than the bespoke `bindList` keyed reconciler** that §60 was going to ship. It generalises to arbitrary subtree diffs, preserves DOM identity (focus / selection / in-flight drags / event listeners on preserved nodes) for free, and is ~3 KB gzipped. The three §60 helpers (`bindText` / `bindAttr` / `bindList`) collapse into a single `morphBind(el, render)` helper.
- **`morphdom` does NOT subsume §62.** Internally it still uses `template.innerHTML = newHtml`, so it inherits every one of the round-trip quirks §62 catalogued (SVG namespace, entity escaping, whitespace, custom-attr parsing). The AST-based fix in §62 was overbuilt for the actual pain — most divergences are SVG-shaped, and a targeted `toElement` SVG fix solves 95% of them with ~50 LOC instead of a runtime rewrite.

So the reshape:
- §60 → adopt `signals` + `morphdom` + a single `morphBind` helper.
- §61 → unchanged in shape; just consumes `morphBind` instead of `bindText` / `bindList`.
- §62 → drastically scoped down; targeted `toElement` SVG fix + small regression corpus instead of a dual-consumer AST runtime.

## 63.2 Reshaped module surface

Six new client modules, all under `src/client/reactivity/`. None of the existing client code changes during the demo phase.

### `src/client/reactivity/reactive.ts`

Re-exports `signal`, `computed`, `effect`, `batch` from `@preact/signals-core`. Lets the rest of the codebase depend on `'./reactive.js'` without naming Preact, so the underlying lib is swappable. ~5 lines.

### `src/client/reactivity/store.ts`

```ts
export interface Store<TState, TActions> {
  state: ReadonlySignal<TState>;
  actions: TActions;
  reset(): void;
}

export function defineStore<TState, TActions>(spec: {
  initial: () => TState;
  actions: (set: (next: TState) => void, get: () => TState) => TActions;
}): Store<TState, TActions>;

export function resetAllStores(): void;
```

Identical to §61's design. A module-level registry tracks every store created via `defineStore()`; `resetAllStores()` walks the registry and calls each `reset()`. Wired into `switchProject` / `reloadAppState` during migration.

Three rules (carried over from §61):
1. `state` is read-only — consumers read via `state.value` or subscribe via `effect()`.
2. `actions` is the only mutation surface.
3. `reset()` resets to `initial()`.

### `src/client/reactivity/morphBind.ts`

```ts
export function morphBind(rootEl: HTMLElement, render: () => SafeHtml | string): () => void;
```

The single render-path primitive. Internally:

```ts
return effect(() => {
  const html = String(render());
  const template = rootEl.cloneNode(false) as HTMLElement;
  template.innerHTML = html;
  morphdom(rootEl, template, { childrenOnly: true, getNodeKey, onBeforeElUpdated });
});
```

Defaults applied in `getNodeKey` / `onBeforeElUpdated` (modelled on smalltale's wrapper):
- **Diff keys:** `id`, `data-key` (generic), and a small set of conventional Hot Sheet keys (`data-ticket-id`, `data-terminal-id`, `data-project-secret`) so list reorders don't churn unrelated siblings.
- **Skip subtrees marked `data-morph-skip`.** For library-owned elements (xterm, Monaco-style editors, anything that mutates its own children) — `onBeforeElUpdated` returns `false` so morphdom never recurses inside.
- **Preserve focus + selection** for the `document.activeElement` if it's a text-entry input. A typing user never sees their cursor jump.

Returns the `effect()` disposer for cleanup.

### `src/client/reactivity/delegate.ts`

Tiny event-delegation helper for the Tier 1 / Tier 2 listener patterns:

```ts
// Tier 1 — bubbling event, dispatched via [data-action]:
export function delegate(rootEl: HTMLElement, type: string, selector: string, handler: (e: Event, target: Element) => void): () => void;

// Tier 2 — non-bubbling, capture-phase:
export function delegateCapture(rootEl: HTMLElement, type: string, selector: string, handler: (e: Event, target: Element) => void): () => void;
```

Tier 3 (per-element instances / observers / library-owned subtrees) is NOT a helper — it's the `data-morph-skip` attribute on the host element + ad-hoc lifecycle wherever the library is mounted (which is exactly how `terminalCheckout.tsx` already manages xterm today).

### `src/client/reactivity/svgAwareToElement.ts`

A drop-in replacement for `src/client/dom.ts::toElement` that handles SVG correctly:

- If the JSX root is an `<svg>` (or a known SVG tag like `<g>` / `<path>` / `<circle>`), parse via `DOMParser` with `'image/svg+xml'` MIME OR construct via `createElementNS` walk.
- Otherwise fall through to today's `<template>`-based parse.

Replaces today's `toElement` (eventually). Migration order: ship the new helper, prove correctness via demo + corpus, swap the import in `dom.ts`, remove the old implementation.

### `src/client/reactivity/listenerTiers.md`

Inline doc next to the code summarising the three tiers (mirror of §63.4 below) so future contributors don't re-derive it from this plan doc after it's been deleted.

## 63.3 Listener pattern — the three tiers

The non-trivial cost of moving to morph-driven re-renders is that listeners attached via `el.addEventListener(...)` after `toElement` don't survive a re-render — morphdom inserts fresh nodes for added subtrees and they have no listeners. The migration replaces direct attachment with delegation almost everywhere.

### Tier 1 — bubbling DOM events (default)

`click`, `input`, `change`, `submit`, `mousedown` / `mouseup`, `keydown` / `keyup`, `pointerdown` / `pointerup` / `pointermove`, `drag*`, `drop`, `contextmenu`, `wheel`, `copy` / `paste` / `cut`. One bubble-phase listener per event type at the morph-root, dispatched via `e.target.closest('[data-action="..."]')`. Covers ~95% of what we do today.

### Tier 2 — non-bubbling DOM events (capture-phase)

`focus`, `blur`, `scroll`, `load`, `error` — fire during the capture phase from the root, so `rootEl.addEventListener('focus', handler, true)` reaches them. `focusin` / `focusout` (bubbling versions) are even cleaner if available. `mouseenter` / `mouseleave` use bubbling `mouseover` / `mouseout` with a `closest()` check, or capture-phase variants. **Still delegation** — no per-element binding.

### Tier 3 — per-element instances (rare)

xterm.js terminals, Monaco-style editors, third-party widgets that mutate their own children, `IntersectionObserver` / `ResizeObserver` keyed to morph-replaceable elements. Pattern: mark the host element with `data-morph-skip` so morphdom never touches inside it; manage the library's lifecycle via the existing module convention (see `terminalCheckout.tsx`).

Per-list-row observers are theoretically Tier 3 but are uncommon in this codebase — almost every observer in `src/client/` attaches to a stable parent and observes the subtree generically.

## 63.4 SVG fix scope

The §62 design proposed a full AST + dual `astToHtml` / `astToDom` consumers to permanently close the divergence bug class. The actual divergence pain we see in practice is:

1. SVG icons rendered ad-hoc that need namespace context.
2. `<g>` / `<path>` fragments inserted into a non-SVG parent.

That's it. Whitespace / entity edge cases catalogued in §62.1 are theoretical — there's no open ticket from any of them.

The targeted fix:

```ts
const SVG_TAGS = new Set(['svg', 'g', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse', 'text', 'tspan', 'defs', 'use', 'symbol', 'clipPath', 'mask', 'pattern', 'filter', 'marker', 'linearGradient', 'radialGradient', 'stop']);
const SVG_NS = 'http://www.w3.org/2000/svg';

export function toElement(jsx: SafeHtml): Element {
  const html = jsx.toString();
  // SVG root → parse via DOMParser to preserve namespace
  if (/^\s*<svg[\s>]/.test(html)) {
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
    return doc.documentElement;
  }
  // SVG fragment without <svg> root → wrap, parse, unwrap
  if (/^\s*<(g|path|circle|rect|line|polygon|polyline|ellipse|text)[\s>]/.test(html)) {
    const wrapped = `<svg xmlns="${SVG_NS}">${html}</svg>`;
    const doc = new DOMParser().parseFromString(wrapped, 'image/svg+xml');
    return doc.documentElement.firstElementChild!;
  }
  // HTML — today's path
  const t = document.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild as HTMLElement;
}
```

~50 LOC, no AST, no runtime rewrite. The optional regression corpus from §62.2 Option A (a vitest fixture exercising ~30 representative JSX cases) becomes cheap insurance against the long tail.

## 63.5 Demo

A self-contained page at `/_demo/reactivity` with its own client bundle (`reactivity-demo.global.js`), fully detached from the rest of the app:

- New tsup entry — does not touch the main client bundle.
- New server route in `src/routes/pages.tsx` serving the demo page + bundle.
- New client modules under `src/client/reactivity-demo/` consuming the primitive from `src/client/reactivity/`.
- Zero changes to existing client modules (`app.tsx`, `state.tsx`, `ticketList.tsx`, etc.).

The demo page exercises every concern this plan needs to validate:

1. **Counter** — single signal, single consumer, click delegation (Tier 1).
2. **Cart store, multi-consumer** — `defineStore({ items, total, count })`, three independent regions on the page subscribe and update independently. Reset button calls `resetAllStores()`.
3. **Focus / cursor preservation** — a text input bound to a signal that's also displayed elsewhere; a 1 Hz tick signal forces re-renders. Type into the input — focus + cursor stay put.
4. **Keyed list with identity** — rows with stable `data-key` IDs and per-row `<input>` state. Add / remove / reorder → typed-into inputs survive (proves morphdom uses keys correctly).
5. **Tier 3 morph-skip** — a "third-party" animated counter widget marked `data-morph-skip`. Parent re-renders frequently; widget keeps animating uninterrupted.
6. **SVG that renders** — JSX-rendered nested SVG (`<svg>` with `<g>` / `<circle>` / `<path>`) using the new `toElement`. Rendered correctly, namespaced.
7. **Tier 2 capture-phase delegation** — a `focus` indicator that highlights any focused field via root-level capture-phase delegation.

Approximate size: ~600–800 LOC across the primitive + demo.

## 63.6 Review criteria

The demo is approved if all of the following are true:

- Every demo section behaves as described in §63.5.
- The primitive code in `src/client/reactivity/` reads cleanly and is < 500 LOC total (excluding tests).
- No changes to existing `src/client/` modules (`git diff` confirms it).
- `npx tsc --noEmit` clean, `npm run lint` clean.
- The user agrees the listener pattern is workable for the migration spike (project tabs, currently `HS-8235`).

## 63.7 If approved — migration path

1. Delete this doc.
2. Rewrite §60 to describe `signals` + `morphdom` + `morphBind` (drop the three keyed-binding helpers); add the listener-tier section; add the `data-morph-skip` convention.
3. Update §61 to reference `morphBind` consumers instead of `bindList`.
4. Rewrite §62 around the targeted SVG fix + optional regression corpus; remove the AST + dual-consumer design.
5. Rewrite the follow-up tickets:
   - `HS-8235` (trial migration: project tabs) — listener-pattern spike.
   - `HS-8236` (high-traffic: ticket list / command log / terminal tabs) — depends on `HS-8235` validation.
   - `HS-8237` (long tail) — sweep of remaining ad-hoc subscribers.
   - `HS-8238` (`defineStore` factory) — unchanged shape.
   - `HS-8239` (`ticketsStore`) — unchanged shape.
   - `HS-8240` (`projectsStore` / `terminalsStore` / `commandLogStore` / `channelStore`) — unchanged shape.
   - `HS-8241` (was: AST) → narrowed to "SVG-aware `toElement` + regression corpus."
   - `HS-8242` (was: flip `toElement` → `astToDom`) → folds into `HS-8241`.
   - `HS-8243` (was: equivalence harness) → keeps the regression corpus only; delete the dual-consumer harness.
6. Promote the demo's primitive code (`src/client/reactivity/`) to the canonical migration target. Demo page can stay as a living example or be deleted; either is fine.

## 63.8 If rejected — cleanup

1. Delete this doc.
2. Delete `src/client/reactivity/` and `src/client/reactivity-demo/`.
3. Delete the `/_demo/reactivity` route from `src/routes/pages.tsx`.
4. Delete the demo tsup entry from `tsup.config.ts`.
5. Remove `morphdom` and `@preact/signals-core` from `package.json`.
6. Original §60 / §61 / §62 design stays in force.
