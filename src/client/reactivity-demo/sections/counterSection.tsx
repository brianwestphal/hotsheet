/**
 * Section 1 — Counter via a single signal + Tier 1 click delegation.
 * The simplest possible "reactive primitive in action" example.
 */

import { delegate } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { signal } from '../../reactivity/reactive.js';

export function mountCounter(root: HTMLElement): void {
  const count = signal(0);

  morphBind(root, () => (
    <div className="demo-card">
      <h2>1. Counter <span className="demo-tag">single signal • Tier 1 click delegation</span></h2>
      <div className="demo-row">
        <button type="button" data-action="dec" className="demo-btn">−</button>
        <output className="demo-counter-value">{count.value}</output>
        <button type="button" data-action="inc" className="demo-btn">+</button>
        <button type="button" data-action="reset" className="demo-btn demo-btn-ghost">reset</button>
      </div>
      <p className="demo-note">
        One signal, one consumer. The buttons are wired via a single
        bubble-phase <code>click</code> listener on the section root and
        dispatched by <code>data-action</code>.
      </p>
    </div>
  ));

  delegate(root, 'click', '[data-action="inc"]', () => { count.value += 1; });
  delegate(root, 'click', '[data-action="dec"]', () => { count.value -= 1; });
  delegate(root, 'click', '[data-action="reset"]', () => { count.value = 0; });
}
