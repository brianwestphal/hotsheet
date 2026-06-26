/**
 * Shared transient toast UI.
 *
 * A single toast element lives at `.hs-toast` on the body; calling `showToast`
 * replaces any prior toast so a rapid sequence collapses to the latest
 * message. The caller picks the visible duration — plugin actions fade fast
 * (default 3 s), OSC 9 desktop-notification toasts linger longer because the
 * user likely needs time to read a multi-word message (HS-7264 uses 6 s).
 *
 * Originally inlined in `pluginUI.tsx`; extracted so the terminal OSC 9 path
 * and future notification sources (e.g. Phase 3 OSC 133 AI responses) can
 * reuse the same affordance with the same styling.
 */
import { toElement } from './dom.js';
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

  document.querySelector('.hs-toast')?.remove();
  const toast = toElement(<div className={`hs-toast hs-toast-${variant} plugin-toast`}><span className="hs-toast-msg">{message}</span></div>);
  if (opts.action !== undefined) {
    const action = opts.action;
    const btn = toElement(<button className="hs-toast-action">{action.label}</button>);
    btn.addEventListener('click', () => {
      action.onClick();
      toast.classList.remove('visible');
      window.setTimeout(() => toast.remove(), TOAST_FADE_OUT_MS);
    });
    toast.appendChild(btn);
  }
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), TOAST_FADE_OUT_MS);
  }, durationMs);
}
