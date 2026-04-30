/**
 * HS-7969 — produce a plain-text snapshot of a terminal's scrollback for
 * the §37 quit-confirm dialog's expand-row preview. Strips ANSI escape
 * sequences and trims to the last N rendered lines so the user can see
 * what the terminal is doing without needing to attach.
 *
 * Pure (Buffer in, string out) so unit tests don't need a live PTY.
 *
 * Conservative on what counts as "ANSI": handles CSI (`\x1b[...`),
 * OSC (`\x1b]...\x07`), and bare `\x1b` followed by the common single-
 * char escapes. Doesn't try to faithfully reconstruct the cursor/grid;
 * the goal is "human-readable last output", not "exact xterm render."
 */

/** Match CSI sequences: `\x1b[` + intermediate/parameter bytes + final byte. */
const CSI_RX = /\x1b\[[0-9;?]*[A-Za-z]/g;
/** Match OSC sequences: `\x1b]` ... `\x07` (BEL) OR `\x1b\` (ST). */
const OSC_RX = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
/** Bare ESC followed by one of the common single-char codes (e.g. cursor save). */
const SIMPLE_ESC_RX = /\x1b[=>78NMPDEFGHc]/g;
/** Carriage returns inside output blow up line counting unless we collapse them. */
const CR_BUT_NOT_CRLF_RX = /\r(?!\n)/g;
/** Backspace (`\x08`) — strip the previous char visually, but for the
 *  preview we just drop the BS itself. Approximation; good enough. */
const BACKSPACE_RX = /\x08/g;

/**
 * Strip the most common terminal escape sequences from a UTF-8 string so
 * the result is plain printable text + newlines. Conservative — leaves
 * any escape we don't recognise in place rather than corrupting characters.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(OSC_RX, '')
    .replace(CSI_RX, '')
    .replace(SIMPLE_ESC_RX, '')
    .replace(BACKSPACE_RX, '')
    .replace(CR_BUT_NOT_CRLF_RX, '\n');
}

/**
 * Return the last `maxLines` lines of `text`. Lines are split on `\n`
 * (after CR collapsing). Trailing blank lines are kept up to one (so the
 * preview retains a single trailing newline visual).
 */
export function tailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return '';
  const lines = text.split('\n');
  // Drop a single trailing empty line introduced by a final \n so we don't
  // waste a slot on it.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(lines.length - maxLines).join('\n');
}

// HS-8045 — `buildScrollbackPreview` + `buildScrollbackPreviewWithAnsi`
// deleted. Both were exclusively consumed by the deleted
// `/api/terminal/scrollback-preview` route + its registry helpers, all
// of which were removed along with the §37 ANSI-spans preview path now
// that every consumer routes through `terminalCheckout` for real xterm
// canvas previews. `stripAnsi` + `tailLines` stay as-is — they're pure
// utility functions with existing unit-test coverage that may be useful
// for future paths.
