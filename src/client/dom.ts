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
