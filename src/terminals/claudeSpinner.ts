/**
 * HS-6702 — Claude busy-spinner detection.
 *
 * Claude Code renders a small animated spinner whenever it's actively
 * working (thinking, calling tools, drafting a response). The spinner
 * cycles through these glyphs:
 *
 *   · ✢ ✳ ✶ ✻ ✽
 *
 * Detecting them in the PTY byte stream is a much more reliable busy
 * signal than the original "no output for 5s = idle" heuristic, because
 * the spinner is ALWAYS animating while Claude is working — so a 1+
 * second window of recent PTY output that contains any spinner glyph
 * proves Claude is busy. Conversely, a 5+ second window without ANY
 * spinner glyph proves Claude is idle (waiting for user input or done).
 *
 * Pure helper. Used by `src/terminals/registry.ts` to stamp
 * `lastSpinnerAtMs` on every PTY data chunk and exposed via
 * `/api/terminal/list` so the client can render a degraded-busy state
 * when `isChannelBusy()` is true but Claude looks idle.
 */

/** The exact spinner glyphs Claude emits, captured from the user's
 *  HS-6702 note. Stored as a Set for O(1) `has` checks per character. */
export const CLAUDE_SPINNER_GLYPHS: ReadonlySet<string> = new Set([
  '·', // · MIDDLE DOT
  '✢', // ✢ FOUR BALLOON-SPOKED ASTERISK
  '✳', // ✳ EIGHT SPOKED ASTERISK
  '✶', // ✶ SIX POINTED BLACK STAR
  '✻', // ✻ TEARDROP-SPOKED ASTERISK
  '✽', // ✽ HEAVY TEARDROP-SPOKED ASTERISK
]);

/**
 * Returns true when the input string contains at least one Claude
 * spinner glyph. The check iterates the string's code points so a
 * surrogate-pair encoded astral glyph (none of the spinner glyphs are
 * astral, but the iteration is robust for free) doesn't false-positive.
 *
 * O(n) in input length. Used in the per-chunk PTY data handler — the
 * scrollback ring buffer caps PTY chunks at MTU-ish sizes so this is
 * always cheap.
 */
export function containsClaudeSpinner(text: string): boolean {
  for (const ch of text) {
    if (CLAUDE_SPINNER_GLYPHS.has(ch)) return true;
  }
  return false;
}

/**
 * Decide whether the channel-busy state should be downgraded to
 * "degraded busy" given the most recent spinner timestamp + the
 * current time. Pure helper so the channel-UI logic is unit-testable
 * without mocking timers.
 *
 * Returns true when:
 * - Channel reports busy AND
 * - Either we've never seen a spinner OR the most recent spinner is
 *   older than `silenceThresholdMs` (default 5000 ms).
 *
 * False when channel isn't busy in the first place (no degradation
 * to compute) or when Claude is actively spinning.
 */
export function shouldShowDegradedBusy(
  channelBusy: boolean,
  lastSpinnerAtMs: number | null,
  nowMs: number,
  silenceThresholdMs: number = 5000,
): boolean {
  if (!channelBusy) return false;
  if (lastSpinnerAtMs === null) return true;
  return nowMs - lastSpinnerAtMs >= silenceThresholdMs;
}
