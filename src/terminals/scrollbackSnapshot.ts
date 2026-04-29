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

/**
 * Pure: produce the user-visible preview from raw scrollback bytes.
 * Returns a string with up to `maxLines` lines, ANSI-stripped. Empty
 * string if the buffer is empty.
 */
export function buildScrollbackPreview(buf: Buffer, maxLines: number): string {
  if (buf.length === 0) return '';
  const text = buf.toString('utf-8');
  const stripped = stripAnsi(text);
  return tailLines(stripped, maxLines);
}

/**
 * HS-7969 follow-up #2 — ANSI-preserving variant for the §37 quit-confirm
 * master-detail preview pane's rich rendering. Keeps CSI/OSC/SIMPLE-ESC
 * sequences in the output so a client-side ANSI-to-HTML parser can paint
 * coloured / bold / underlined spans against the resolved theme palette.
 *
 * Still collapses bare CR (so line-counting + tail logic matches the
 * stripped-text path) and still drops backspace bytes (no useful visual
 * meaning in a static preview). Tail logic is identical to the stripped
 * path because ANSI sequences never embed `\n` themselves.
 */
export function buildScrollbackPreviewWithAnsi(buf: Buffer, maxLines: number): string {
  if (buf.length === 0) return '';
  const text = buf.toString('utf-8')
    .replace(BACKSPACE_RX, '')
    .replace(CR_BUT_NOT_CRLF_RX, '\n');
  return tailLines(text, maxLines);
}
