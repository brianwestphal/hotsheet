import { toElement as kerfToElement } from 'kerfjs';

import type { SafeHtml } from '../jsx-runtime.js';

/** Convert a JSX SafeHtml result to a DOM element.
 *
 * **HS-8241 (2026-05-09):** routed through `kerfjs::toElement` so SVG
 * roots / fragments get correct XML-namespace parsing via
 * `DOMParser('image/svg+xml')` (the §62 bug class — orphan SVG
 * fragments through `<template>.innerHTML` silently produce
 * `HTMLUnknownElement` and never paint). For HTML JSX — the dominant
 * case in this codebase, where SVG is always nested inside an HTML
 * wrapper via `raw(svgString)` — kerf falls back to the same
 * `<template>.innerHTML` path the local pre-fix implementation used,
 * byte-for-byte equivalent.
 *
 * Return type kept as `HTMLElement` (kerf's signature is `Element`) for
 * backwards-compat with the 244 existing callsites; SVG roots cast
 * through but the underlying DOM works the same. If a future callsite
 * legitimately needs the wider `Element` type for SVG handling, change
 * the cast at that call-site. */
export function toElement(jsx: SafeHtml): HTMLElement {
  // Stringify at the boundary: kerf's TS signature wants kerf's
  // `SafeHtml` class (with `__segment` + brand symbol) OR a plain
  // string. Hot Sheet's local `SafeHtml` class has neither, but at
  // runtime kerf just calls `.toString()` on non-string input — so
  // pre-stringifying gives the identical runtime path while satisfying
  // TS without a structural-cast hack.
  const html = jsx.toString();
  const result = kerfToElement(html);
  // HS-8562: kerfjs 0.12.0 (HS-8529 bump) widened the return type to
  // `Element | DocumentFragment` — invalid HTML that the browser parses
  // as multi-root (e.g. `<button><button>...</button></button>`, which
  // HTML5's parser splits into two sibling buttons) now returns a
  // `DocumentFragment` instead of silently dropping the trailing
  // siblings. The 244 existing callsites all type the result as
  // `HTMLElement` and reach for `.classList` / `.style` / `.remove` —
  // none of which exist on `DocumentFragment`. Catch the mistake here
  // with a callsite-visible error rather than letting it surface as a
  // mysterious `Cannot read properties of undefined` deep in the next
  // DOM mutation.
  if (!(result instanceof Element)) {
    throw new Error(
      'toElement: produced a DocumentFragment, not an Element. '
      + 'Most common cause: invalid nested HTML (e.g. <button> inside <button>, '
      + '<a> inside <a>, <form> inside <form>) that the parser splits into siblings. '
      + 'Fix the JSX so it has exactly one root element. '
      + `Input (first 200 chars): ${html.slice(0, 200)}`,
    );
  }
  return result as HTMLElement;
}

/**
 * HS-8092 — `requireChild<T>(root, selector)` is a typed `querySelector`
 * that throws a descriptive error when the selector doesn't match. Use
 * this anywhere a dialog / overlay JSX template guarantees a child
 * element exists — pre-fix six callsites in `feedbackDialog.tsx` and
 * `readerOverlay.tsx` used `root.querySelector(selector)!` non-null
 * assertions, which silently `null`-deref if the JSX template is later
 * edited and the class/id is renamed (the dialog crashes only when the
 * user actually tries to interact with it, with a useless stack trace).
 *
 * The thrown error message names the selector so a future maintainer
 * sees `requireChild: no match for ".reader-mode-close" in <div ...>`
 * instead of `Cannot read properties of null (reading 'addEventListener')`.
 *
 * Generic constraint: `T extends Element` (not `HTMLElement`) so SVG
 * roots / custom elements work; callers pass the concrete type they
 * expect (`HTMLButtonElement`, `HTMLInputElement`, etc.).
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- T is the contract: callers pass the concrete element type they expect (e.g. `HTMLButtonElement`) and the helper threads it through `querySelector<T>` so the returned non-null value is correctly typed at the callsite. Used as a return-type annotation, not just an internal narrowing.
export function requireChild<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (el === null) {
    const rootDesc = root instanceof Element
      ? `<${root.tagName.toLowerCase()}${root.id !== '' ? ` id="${root.id}"` : ''}${root.className !== '' ? ` class="${root.className}"` : ''}>`
      : 'document';
    throw new Error(`requireChild: no match for "${selector}" in ${rootDesc}`);
  }
  return el;
}

/**
 * HS-8083 — `byId<T>(id)` is a typed `document.getElementById` that
 * throws a descriptive error when the id misses. Use this anywhere a
 * server-rendered template guarantees an element exists — pre-fix 343
 * callsites across the client did
 * `document.getElementById('foo') as HTMLInputElement` (or just dropped
 * the cast and assumed `Element` was good enough), with the same JSX-
 * template-drift / element-renamed-but-id-stale failure mode as the
 * `querySelector!` pattern HS-8092 fixed.
 *
 * The thrown message names the missing id so a future maintainer reading
 * the stack trace sees `byId: no element with id "settings-trash-days"`
 * instead of `Cannot read properties of null (reading 'value')`.
 *
 * Sibling to `requireChild` — same generic-as-contract pattern: callers
 * pass the concrete element type they expect (`HTMLInputElement`,
 * `HTMLButtonElement`, etc.) and it threads through to the return type.
 *
 * For the case where missing-is-allowed (e.g. an element only present
 * in some surfaces), use `byIdOrNull<T>(id)` which returns `T | null`
 * without throwing.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- mirrors `requireChild`'s contract: T drives the return type, not just internal narrowing.
export function byId<T extends Element = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`byId: no element with id "${id}"`);
  // HS-8567 — `as unknown as T` is the unavoidable escape hatch for a
  // generic typed lookup. There's no runtime way to verify T (it's a
  // type-only parameter; happy-dom can't be asked "is this an
  // HTMLButtonElement?" without a constructor reference per call). The
  // safer alternative — `instanceof` check at every callsite — pushes
  // the burden onto 244+ callers. Caller is responsible for passing T
  // that matches the real element type; mismatch surfaces as a
  // descriptive runtime error on the very next access (e.g.
  // `.classList`, `.disabled`).
  return el as unknown as T;
}

/**
 * HS-8083 — like `byId` but returns `null` when the id misses.
 * For surfaces where the element is genuinely optional (e.g. a setting
 * UI rendered only in Tauri builds, or a Phase-2 element gated on a
 * feature flag).
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- same rationale as `byId`.
export function byIdOrNull<T extends Element = HTMLElement>(id: string): T | null {
  // HS-8567 — see the rationale on `byId` above. Same trade-off applies:
  // T is a type-only parameter that the runtime cannot validate.
  return document.getElementById(id) as unknown as T | null;
}
