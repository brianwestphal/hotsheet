/**
 * Section 7 — Tier 2 (capture-phase) delegation for non-bubbling events.
 *
 * `focus` and `blur` don't bubble in the bubble phase, so a root-level
 * bubble-phase listener never sees them. They DO fire during the capture
 * phase though, so `addEventListener('focus', handler, true)` on the morph
 * root reaches them without per-element binding — even for elements
 * morphdom newly inserts on a re-render.
 *
 * Demo: three input fields. A live "currently focused field" indicator
 * updates whenever any of them gains or loses focus, driven entirely by
 * one `delegateCapture('focus', ...)` and one `delegateCapture('blur', ...)`
 * on the section root. The fields are part of a morphBind-rendered tree, so
 * they get rebuilt whenever the tracker tick signal changes — the capture-
 * phase listener still sees their focus events.
 */

import { delegate, delegateCapture } from '../../reactivity/delegate.js';
import { morphBind } from '../../reactivity/morphBind.js';
import { signal } from '../../reactivity/reactive.js';

export function mountTier2Capture(root: HTMLElement): void {
  const focused = signal<string | null>(null);
  const tick = signal(0);
  setInterval(() => { tick.value += 1; }, 1000);

  morphBind(root, () => (
    <div className="demo-card">
      <h2>7. Tier 2 capture-phase <span className="demo-tag">focus / blur — non-bubbling</span></h2>

      <p className="demo-tick-line">
        Re-render tick: <strong>{tick.value}</strong>
        {' · '}
        Focused field: <strong>{focused.value ?? '<none>'}</strong>
      </p>

      <div className="demo-row demo-tier2-row">
        <input type="text" placeholder="Field A" data-field="A" className="demo-input" autocomplete="off" spellcheck="false" />
        <input type="text" placeholder="Field B" data-field="B" className="demo-input" autocomplete="off" spellcheck="false" />
        <input type="text" placeholder="Field C" data-field="C" className="demo-input" autocomplete="off" spellcheck="false" />
        <button type="button" data-action="clear" className="demo-btn demo-btn-ghost">clear all</button>
      </div>

      <p className="demo-note">
        Click into any field — the indicator updates. The whole card re-renders
        every second, but the capture-phase delegated listeners on the section
        root see <code>focus</code> / <code>blur</code> events from any
        descendant input regardless of how many times morphdom has rebuilt
        them. No per-element binding required.
      </p>
    </div>
  ));

  // Tier 2 — capture-phase, non-bubbling.
  delegateCapture(root, 'focus', 'input', (_e, target) => {
    focused.value = (target as HTMLElement).dataset.field ?? null;
  });
  delegateCapture(root, 'blur', 'input', () => {
    focused.value = null;
  });

  // Tier 1 — bubbling, for the clear button.
  delegate(root, 'click', '[data-action="clear"]', () => {
    root.querySelectorAll<HTMLInputElement>('input').forEach((i) => { i.value = ''; });
  });
}
