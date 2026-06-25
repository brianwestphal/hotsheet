/**
 * HS-9029 — a one-way "the app is shutting down" flag.
 *
 * When the desktop "Shutting Down" overlay goes up (`shutdownOverlay.tsx`), the
 * server is about to close. Every in-flight request (long-polls, bell/cost
 * polls, ws reconnects) then fails with a `TypeError`, which would otherwise pop
 * the "Connection Error — Unable to reach the server" dialog *behind* the
 * shutdown overlay (the user saw it blurred through on every quit). Suppressing
 * those popups once shutdown has begun removes the noise — the overlay already
 * tells the user exactly what's happening.
 *
 * Kept in its own tiny module so the low-level `api.tsx` transport can read the
 * flag without importing the (DOM-building) overlay module.
 */
let shuttingDown = false;

/** Mark that shutdown has begun. One-way — there's no "un-shutdown". */
export function markShuttingDown(): void {
  shuttingDown = true;
}

/** Whether shutdown has begun (network-error popups should be suppressed). */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

/** **TEST ONLY** — reset the flag between tests. */
export function _resetShutdownStateForTesting(): void {
  shuttingDown = false;
}
