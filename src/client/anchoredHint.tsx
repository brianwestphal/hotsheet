/**
 * HS-8784 — a transient hint bubble anchored to the element the user just
 * interacted with.
 *
 * The generic bottom-center `showToast` (`toast.tsx`) was missed by users when
 * it confirmed a top-toolbar action (e.g. the Glassbox button reporting "no
 * pending changes"): the feedback appeared at the far bottom of the window while
 * the user's attention was at the button they clicked. An anchored hint pops up
 * directly beside/under its anchor, so the confirmation lands where the user is
 * already looking.
 *
 * DOM-only + side-effecting; the lifecycle (create → show → auto-dismiss) is
 * unit-testable in happy-dom with fake timers.
 *
 * KERF-EVAL (feature 9 / KF-491) — positioning is kerf 4.2's `autoReposition`
 * (built on the `positionAnchored` placement core): it places the bubble below
 * the anchor (flipping above on viewport overflow), horizontally clamped, AND
 * keeps it glued as the page scrolls / resizes for the ~4.5 s it's shown. This
 * retired Hot Sheet's hand-rolled `positionDropdown` (its last consumer).
 */
import { autoReposition } from 'kerfjs/overlay';

import { toElement } from './dom.js';
import { TOAST_FADE_OUT_MS } from './uiTimings.js';

/** Only one anchored hint is shown at a time. */
const HINT_CLASS = 'anchored-hint';

/** Disposer for the current hint's kerf `autoReposition` scroll/resize listeners.
 *  Cleared whenever the hint is removed (fade-out, external dismiss, or replace). */
let stopReposition: (() => void) | null = null;

export interface AnchoredHintOptions {
  /** How long the bubble stays fully visible before fading (ms). Default 4500 —
   *  longer than the generic toast since it's a deliberate, read-once message. */
  durationMs?: number;
}

/**
 * Flash a short message anchored to `anchor`. Replaces any prior hint so a rapid
 * sequence collapses to the latest. Auto-dismisses after `durationMs`; also
 * dismissed by the next pointer-down anywhere (so it never lingers in the way).
 */
export function flashAnchoredHint(anchor: HTMLElement, message: string, opts: AnchoredHintOptions = {}): void {
  const durationMs = opts.durationMs ?? 4500;
  dismissAnchoredHint();

  const hint = toElement(
    <div className={HINT_CLASS} role="status" style="visibility:hidden">{message}</div>,
  );
  document.body.appendChild(hint);
  // Position now that it's measurable in the DOM (synchronously, so there's no
  // flash before reveal) and keep it glued while shown; then reveal.
  stopReposition = autoReposition(hint, anchor);
  hint.style.visibility = '';
  requestAnimationFrame(() => hint.classList.add('visible'));

  const fadeAndRemove = (): void => {
    stopReposition?.();
    stopReposition = null;
    hint.classList.remove('visible');
    window.setTimeout(() => hint.remove(), TOAST_FADE_OUT_MS);
  };
  const timer = window.setTimeout(fadeAndRemove, durationMs);

  // Dismiss on the next pointer-down so it can't obstruct the next click. Uses a
  // capture-phase one-shot listener registered on the next tick (so the click
  // that opened the hint doesn't immediately close it).
  window.setTimeout(() => {
    const onDown = (): void => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onDown, true);
      fadeAndRemove();
    };
    document.addEventListener('pointerdown', onDown, true);
    // Stop listening once the hint is gone on its own.
    window.setTimeout(() => document.removeEventListener('pointerdown', onDown, true), durationMs + TOAST_FADE_OUT_MS);
  }, 0);
}

/** Remove any visible anchored hint immediately. */
export function dismissAnchoredHint(): void {
  stopReposition?.();
  stopReposition = null;
  document.querySelector(`.${HINT_CLASS}`)?.remove();
}
