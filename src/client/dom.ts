import type { SafeHtml } from '../jsx-runtime.js';

/** Convert a JSX SafeHtml result to a DOM element */
export function toElement(jsx: SafeHtml): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = jsx.toString();
  return t.content.firstElementChild as HTMLElement;
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
  return document.getElementById(id) as unknown as T | null;
}
