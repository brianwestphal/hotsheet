/**
 * Section 6 — SVG inside morphBind renders correctly + animates.
 *
 * The HTML5 parser switches to "foreign content" mode when it sees an
 * `<svg>` tag, so root-`<svg>` JSX strings ALREADY parse correctly under
 * today's `<template>.innerHTML` path — and morphdom inherits that
 * behaviour. The bug class §62 was solving (orphan SVG fragments inserted
 * into an existing `<svg>` parent) is real but rare and orthogonal to the
 * morphBind primitive.
 *
 * For this demo we exercise the common case: JSX-rendered SVG that re-renders
 * inside a morphBind block as a signal changes. If the SVG paints and
 * animates as the slider moves, the interaction between morphdom and SVG
 * namespace propagation works.
 *
 * The `svgAwareToElement` helper that ships alongside this primitive (see
 * `src/client/reactivity/svgAwareToElement.ts`) covers the orphan-fragment
 * case for direct `toElement` callers — not exercised here because the orphan
 * fragment doesn't paint standalone.
 */

import { delegate } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { signal } from '../../reactivity/reactive.js';

export function mountSvgRender(root: HTMLElement): void {
  const angle = signal(45);
  const radius = signal(40);

  morphBind(root, () => (
    <div className="demo-card">
      <h2>6. SVG inside morphBind <span className="demo-tag">root-svg • animated re-render</span></h2>

      <div className="demo-row">
        <label className="demo-label">
          rotation:
          <input type="range" min="0" max="360" value={String(angle.value)} data-action="set-angle" className="demo-slider" />
          <span className="demo-angle-value">{angle.value}°</span>
        </label>
        <label className="demo-label">
          radius:
          <input type="range" min="10" max="55" value={String(radius.value)} data-action="set-radius" className="demo-slider" />
          <span className="demo-angle-value">{radius.value}</span>
        </label>
      </div>

      <div className="demo-svg-cell">
        <svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 120 120" className="demo-svg">
          <g transform={`rotate(${angle.value} 60 60)`}>
            <circle cx="60" cy="60" r={radius.value} fill="#9bd1e5" stroke="#1a76b8" strokeWidth="2" />
            <path
              d={`M 60 ${60 - radius.value} L ${60 + radius.value} 60 L 60 ${60 + radius.value} L ${60 - radius.value} 60 Z`}
              fill="#fde68a"
              stroke="#92400e"
              strokeWidth="2"
              opacity="0.85"
            />
            <text x="60" y="64" textAnchor="middle" fontFamily="sans-serif" fontSize="13" fill="#1a76b8">{angle.value}°</text>
          </g>
        </svg>
      </div>

      <p className="demo-note">
        Drag the sliders. The SVG inside is re-rendered through
        <code> morphBind</code> on every input event. The
        <code> &lt;circle&gt; </code> and <code>&lt;path&gt;</code> attributes
        update in place via morphdom's keyless positional diff — element
        identity is preserved (you can confirm with the dev-tools inspector;
        the same nodes update rather than being replaced). The new
        <code> svgAwareToElement</code> helper lives next to this primitive
        for direct <code>toElement</code> callers that need the orphan-
        fragment fix.
      </p>
    </div>
  ));

  delegate(root, 'input', '[data-action="set-angle"]', (_e, target) => {
    angle.value = Number((target as HTMLInputElement).value);
  });
  delegate(root, 'input', '[data-action="set-radius"]', (_e, target) => {
    radius.value = Number((target as HTMLInputElement).value);
  });
}
