/**
 * HS-8175 — Pure helper for the per-terminal stall indicator.
 *
 * Detects "I typed something but the PTY hasn't echoed it back yet" by
 * comparing two timestamps:
 * - `lastTypeTs` is recorded in `terminalCheckout.tsx::createEntry`'s
 *   `term.onData` handler (every keystroke send to the WebSocket).
 * - `lastEchoTs` is recorded in the binary `ws.message` path (every PTY
 *   output byte received from the server).
 *
 * The indicator should fire when:
 * 1. The user has typed since the last echo (`lastTypeTs > lastEchoTs`).
 * 2. The most recent type is older than the threshold (`now - lastTypeTs > thresholdMs`).
 *
 * Default threshold is 1500 ms — empirically tuned against the HS-8054
 * freeze.log baseline. Most server-side spikes the user sees are 100-300 ms
 * (normal GC / fs / db ops); 1500 ms cleanly separates real freezes (≥ 1 s)
 * from baseline noise.
 *
 * Hide-on-echo is implemented by the caller, NOT here — the moment a
 * binary message arrives, `lastEchoTs >= lastTypeTs` and this helper
 * returns false. Callers tick every ~250 ms (or just on echo arrival /
 * keystroke send) and toggle a CSS class accordingly.
 */
export const STALL_INDICATOR_THRESHOLD_MS = 1500;

export function shouldShowStallIndicator(
  lastTypeTs: number,
  lastEchoTs: number,
  now: number,
  thresholdMs: number = STALL_INDICATOR_THRESHOLD_MS,
): boolean {
  // Never typed: indicator stays hidden regardless of `now`.
  if (lastTypeTs === 0) return false;
  // Echo arrived after (or at the same instant as) the most recent type:
  // the keystroke was confirmed to have made it to the PTY.
  if (lastEchoTs >= lastTypeTs) return false;
  // Typed past the threshold without an echo back — show the indicator.
  return now - lastTypeTs > thresholdMs;
}
