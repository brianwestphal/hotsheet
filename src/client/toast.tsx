/**
 * Shared transient toast UI.
 *
 * A single toast at a time lives on the body; calling `showToast` replaces any
 * prior toast so a rapid sequence collapses to the latest message. The caller
 * picks the visible duration — plugin actions fade fast (default 3 s), OSC 9
 * desktop-notification toasts linger longer because the user likely needs time
 * to read a multi-word message (HS-7264 uses 6 s).
 *
 * Originally inlined in `pluginUI.tsx`; extracted so the terminal OSC 9 path
 * and future notification sources (e.g. Phase 3 OSC 133 AI responses) can
 * reuse the same affordance with the same styling.
 *
 * KERF-EVAL (feature 1 / KF-487) — the imperative rAF-enter + timeout-exit
 * dance is now kerf 4.2's `toast()` engine:
 *   - `enterClass: 'visible'` ← kerf adds it on the next frame (was our own rAF)
 *   - `exitClass` + `exitDuration` ← kerf owns the fade + delayed removal
 *   - `duration` ← kerf owns the auto-dismiss timer
 * `container: document.body` keeps toasts as DIRECT body children (kerf otherwise
 * wraps them in a `.kerf-toasts` region) — preserving the `.hs-toast` selector,
 * the OSC 9 e2e MutationObserver (body childList, no subtree), and our SCSS.
 * kerf sets `role="status"` on the toast (an a11y gain over the old plain div).
 *
 * Two kerf-model notes worth recording (KF-487 follow-up feedback):
 *   1. kerf's exit ADDS `exitClass` and KEEPS `enterClass`, so the fade-out is
 *      driven by a dedicated `.hs-toast-hide` rule that overrides `.visible`
 *      (source-ordered after it), not by removing `.visible`.
 *   2. kerf's `mode: 'replace'` *fade-dismisses* the prior toast (exit
 *      transition + delayed removal). For a STACKING region that's right, but
 *      Hot Sheet's toast is a single, exactly-centered slot — a fading old
 *      message would cross-fade THROUGH the new one for `exitDuration`. So we
 *      keep an instant synchronous pre-clear for the collapse-to-latest and let
 *      kerf own only the enter/exit of the surviving toast. (A kerf
 *      `collapse: 'instant' | 'fade'` knob would let us drop this.)
 */
import { toast as kerfToast } from 'kerfjs/overlay';

import { TOAST_FADE_OUT_MS } from './uiTimings.js';

export interface ShowToastOptions {
  durationMs?: number;
  /** Optional accent variant: `success` | `info` | `warning`. `info` is the default. */
  variant?: 'info' | 'success' | 'warning';
  /** HS-9092 — optional inline action button (e.g. "Undo"). Clicking it runs
   *  `onClick` and dismisses the toast. */
  action?: { label: string; onClick: () => void };
}

export function showToast(message: string, opts: ShowToastOptions = {}): void {
  const durationMs = opts.durationMs ?? 3000;
  const variant = opts.variant ?? 'info';
  const action = opts.action;

  const content = (
    <>
      <span className="hs-toast-msg">{message}</span>
      {action !== undefined ? <button className="hs-toast-action">{action.label}</button> : null}
    </>
  );

  // Collapse-to-latest, instantly (see note 2 above): drop any prior toast
  // before mounting the new one so two centered slots never overlap.
  document.querySelectorAll('.hs-toast').forEach(t => t.remove());

  const handle = kerfToast(content, {
    container: document.body,
    className: `hs-toast hs-toast-${variant} plugin-toast`,
    duration: durationMs,
    enterClass: 'visible',
    exitClass: 'hs-toast-hide',
    exitDuration: TOAST_FADE_OUT_MS,
  });

  if (action !== undefined) {
    handle.el.querySelector('.hs-toast-action')?.addEventListener('click', () => {
      action.onClick();
      handle.dismiss();
    });
  }
}
