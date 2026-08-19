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
 * KERF-EVAL (feature 1 / KF-487) — the imperative rAF-enter + timeout-exit +
 * single-toast dedup dance is now kerf 4.2's `toast()` engine:
 *   - `mode: 'replace'` + `collapse: 'instant'` ← collapse-to-latest, removing
 *     the prior toast synchronously (KF-495, beta.4) so two centered slots never
 *     cross-fade in place — was a manual `.hs-toast?.remove()` pre-clear.
 *   - `enterClass: 'visible'` + `exitDuration` ← kerf adds `visible` on the next
 *     frame and, on dismiss, REMOVES it (beta.4) before removing the node after
 *     the delay — so our original symmetric one-class fade works as-is, no
 *     separate exit class needed.
 *   - `duration` ← kerf owns the auto-dismiss timer.
 * `container: document.body` keeps toasts as DIRECT body children (kerf otherwise
 * wraps them in a `.kerf-toasts` region) — preserving the `.hs-toast` selector,
 * the OSC 9 e2e MutationObserver (body childList, no subtree), and our SCSS.
 * kerf sets `role="status"` on the toast (an a11y gain over the old plain div).
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

  const handle = kerfToast(content, {
    container: document.body,
    className: `hs-toast hs-toast-${variant} plugin-toast`,
    mode: 'replace',
    collapse: 'instant',
    duration: durationMs,
    enterClass: 'visible',
    exitDuration: TOAST_FADE_OUT_MS,
  });

  if (action !== undefined) {
    const onClick = action.onClick;
    handle.el.querySelector('.hs-toast-action')?.addEventListener('click', () => {
      // Close this toast INSTANTLY, then run the action. `handle.dismiss()` fades
      // over `exitDuration`, and a mid-exit toast is skipped by a later
      // `mode:'replace'` collapse — so if the action shows a replacement toast
      // (e.g. "Force-release" → "Released") the fading one would overlap it. kerf
      // has no instant single-toast dismiss, so cancel the timer (dismiss) and
      // drop the node now (el.remove). See KF-497.
      handle.dismiss();
      handle.el.remove();
      onClick();
    });
  }
}
