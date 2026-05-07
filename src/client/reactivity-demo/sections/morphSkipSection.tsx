/**
 * Section 5 — Tier 3: morph-skip for library-owned subtrees.
 *
 * Stand-in for a third-party widget (xterm-style) that owns its own children
 * and would be corrupted if morphdom recursed inside it. The host element is
 * marked `data-morph-skip`; `onBeforeElUpdated` returns `false` for it, so
 * morphdom never touches what's inside.
 *
 * The "widget" is a simple animated counter implemented with vanilla DOM
 * mutations on a 100ms interval. It runs uninterrupted even though the
 * surrounding card re-renders every second (driven by the same `tick` signal
 * pattern as Section 3).
 */

import { delegate } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { signal } from '../../reactivity/reactive.js';

export function mountMorphSkip(root: HTMLElement): void {
  const tick = signal(0);
  setInterval(() => { tick.value += 1; }, 1000);

  // The "library widget" — created once, mutated directly. The MOUNT div
  // (the JSX-rendered host) carries `data-morph-skip`; morphdom never
  // recurses inside it, so this widget DOM stays untouched even as the
  // surrounding card re-renders. The widget itself is plain HTML elements
  // mutated by a 100ms interval.
  const widgetHost = document.createElement('div');
  widgetHost.id = 'morph-skip-widget';
  widgetHost.className = 'demo-skip-widget';

  let internalTicks = 0;
  const internalLabel = document.createElement('strong');
  const internalDot = document.createElement('span');
  internalDot.className = 'demo-skip-dot';
  widgetHost.append('Library-owned widget · internal ticks: ', internalLabel, ' ', internalDot);

  function updateWidget(): void {
    internalTicks += 1;
    internalLabel.textContent = String(internalTicks);
    internalDot.style.transform = `translateX(${(internalTicks * 4) % 80}px)`;
  }
  setInterval(updateWidget, 100);
  updateWidget();

  morphBind(root, () => (
    <div className="demo-card">
      <h2>5. Morph-skip <span className="demo-tag">data-morph-skip • Tier 3 lifecycle</span></h2>

      <p className="demo-tick-line">
        Outer tick (forces parent re-render every second): <strong>{tick.value}</strong>
      </p>

      {/* `data-morph-skip` tells morphBind's onBeforeElUpdated to return
          false on this element — morphdom skips its subtree entirely, so
          the persistent widget DOM appended once below is preserved across
          every parent re-render. */}
      <div id="morph-skip-mount" className="demo-skip-mount" data-morph-skip>
      </div>

      <div className="demo-row">
        <button type="button" data-action="bump" className="demo-btn">bump outer state</button>
      </div>

      <p className="demo-note">
        The animated dot inside the bordered widget is a stand-in for an
        xterm-style library that owns its own children. Its host has
        <code> data-morph-skip</code>, so morphdom's <code>onBeforeElUpdated </code>
        returns <code>false</code> and the inside is never traversed. Notice
        the dot's animation never stutters even though the surrounding card
        re-renders every second.
      </p>
    </div>
  ));

  // Reattach the persistent widget host after every morph (the morph leaves the
  // mount placeholder in place, but the widget itself lives outside the morph
  // tree so we splice it in once and rely on data-morph-skip to keep it).
  // We attach it once and morphdom's data-morph-skip prevents it from being
  // touched on subsequent renders.
  const mount = root.querySelector<HTMLElement>('#morph-skip-mount');
  if (mount !== null) mount.appendChild(widgetHost);

  delegate(root, 'click', '[data-action="bump"]', () => { tick.value += 100; });
}
