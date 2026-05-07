/**
 * SVG-aware drop-in replacement for `src/client/dom.ts::toElement`.
 *
 * The legacy implementation parses JSX through a `<template>` element's
 * `innerHTML`. That works for HTML and for SVG fragments whose root tag is
 * `<svg>` (the parser switches to "foreign content" mode). It silently
 * fails for SVG fragments WITHOUT an `<svg>` wrapper — the inner `<g>` /
 * `<path>` / `<circle>` end up as `HTMLUnknownElement` and never paint.
 *
 * This helper detects SVG content and routes through `DOMParser` with the
 * `image/svg+xml` MIME, which guarantees correct namespacing for all
 * descendants. HTML content takes the original path unchanged.
 *
 * See `docs/63-reactivity-demo-plan.md` §63.4 for the rationale and the
 * tag set covered.
 */

import type { SafeHtml } from '../../jsx-runtime.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const SVG_FRAGMENT_TAGS = new Set([
  'g', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse',
  'text', 'tspan', 'defs', 'use', 'symbol', 'clipPath', 'mask', 'pattern',
  'filter', 'marker', 'linearGradient', 'radialGradient', 'stop', 'image',
  'foreignObject',
]);

function leadingTag(html: string): string | null {
  const match = /^\s*<([a-zA-Z][a-zA-Z0-9]*)\b/.exec(html);
  return match !== null ? match[1] : null;
}

export function toElement(jsx: SafeHtml | string): Element {
  const html = typeof jsx === 'string' ? jsx : jsx.toString();
  const tag = leadingTag(html);

  if (tag === 'svg') {
    // SVG root — parse as XML to guarantee namespace propagation.
    const doc = new DOMParser().parseFromString(html, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err !== null) throw new Error(`toElement: SVG parse error — ${err.textContent}`);
    return doc.documentElement;
  }

  if (tag !== null && SVG_FRAGMENT_TAGS.has(tag)) {
    // SVG fragment without an <svg> wrapper — wrap, parse, unwrap.
    const wrapped = `<svg xmlns="${SVG_NS}">${html}</svg>`;
    const doc = new DOMParser().parseFromString(wrapped, 'image/svg+xml');
    const err = doc.querySelector('parsererror');
    if (err !== null) throw new Error(`toElement: SVG fragment parse error — ${err.textContent}`);
    const first = doc.documentElement.firstElementChild;
    if (first === null) throw new Error('toElement: SVG fragment produced no element');
    return first;
  }

  // HTML — original path.
  const t = document.createElement('template');
  t.innerHTML = html;
  const child = t.content.firstElementChild;
  if (child === null) throw new Error('toElement: produced no element');
  return child;
}
