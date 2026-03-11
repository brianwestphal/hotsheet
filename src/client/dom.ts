import type { SafeHtml } from '../jsx-runtime.js';

/** Convert a JSX SafeHtml result to a DOM element */
export function toElement(jsx: SafeHtml): HTMLElement {
  const t = document.createElement('template');
  t.innerHTML = jsx.toString();
  return t.content.firstElementChild as HTMLElement;
}
