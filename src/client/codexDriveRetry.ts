// HS-9513 (docs/121 §121.7) — the "Retry Codex drive" button.
//
// Replaces the `codexAppServerEnabled` Experimental toggle. That flag was labeled as a
// readiness gate but was really the only in-app way to clear a handshake-failure flag:
// the recovery from a protocol/version drift was "switch it off, switch it on". That is
// folklore, not an affordance — and worse, the surface it recovered simply VANISHED with
// no explanation, so there was nothing on screen to suggest the toggle had anything to
// do with it.
//
// Now the failure states itself and offers the one action that helps.

import { retryCodexDrive } from '../api/index.js';
import { byIdOrNull } from './dom.js';

/**
 * Wire the retry button. `onRetried` re-runs the channel init so the play surface
 * reappears immediately when the retry succeeds — without it the user would be left
 * looking at the failure row until the next poll, and reasonably assume nothing happened.
 */
export function bindCodexDriveRetry(onRetried: () => void | Promise<void>): void {
  const btn = byIdOrNull<HTMLButtonElement>('codex-drive-retry-btn');
  if (btn === null) return;
  btn.addEventListener('click', () => {
    // Disabled for the round-trip: the retry re-prestarts a daemon, so a double-click
    // would kick off a second one against the same project.
    btn.disabled = true;
    void retryCodexDrive()
      .then(() => onRetried())
      .catch(() => { /* the failure row stays up; the next status poll re-asserts it */ })
      .finally(() => { btn.disabled = false; });
  });
}
