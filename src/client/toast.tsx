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

export interface ShowToastOptions {
  durationMs?: number;
  /** Optional accent variant: `success` | `info` | `warning`. `info` is the default. */
  variant?: 'info' | 'success' | 'warning';
}

export function showToast(message: string, opts: ShowToastOptions = {}): void {
  const durationMs = opts.durationMs ?? 3000;
  const variant = opts.variant ?? 'info';

  document.querySelector('.hs-toast')?.remove();
  const toast = toElement(<div className={`hs-toast hs-toast-${variant} plugin-toast`}>{message}</div>);
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('visible'));
  window.setTimeout(() => {
    toast.classList.remove('visible');
    window.setTimeout(() => toast.remove(), 300);
  }, durationMs);
}
