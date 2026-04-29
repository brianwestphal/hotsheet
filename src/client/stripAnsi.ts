/**
 * HS-7983 — pure ANSI-stripping helpers for the streaming-shell-output
 * client surfaces (sidebar partial-preview and Commands Log live render).
 * Mirrors `src/terminals/scrollbackSnapshot.ts`'s implementation; kept
 * client-local so the bundler doesn't pull in the server-side
 * `Buffer`-using `buildScrollbackPreview`. The `stripAnsi` regex set is
 * conservative — it only collapses sequences we recognise; unknown
 * escapes stay in place rather than corrupting characters.
 *
 * See `docs/53-streaming-shell-output.md` §53.5 Phase 3.
 */

const CSI_RX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OSC_RX = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const SIMPLE_ESC_RX = /\x1b[=>78NMPDEFGHc]/g;
const CR_BUT_NOT_CRLF_RX = /\r(?!\n)/g;
const BACKSPACE_RX = /\x08/g;

/**
 * Pure: strip the most common terminal escape sequences from a UTF-8
 * string. Returns plain printable text + newlines. Lone `\r` is collapsed
 * to `\n` so line-tail logic doesn't get fooled by progress bars, and
 * `\x08` is dropped (BS visually deletes the previous char — for a
 * preview we just remove the BS).
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
 * Pure: return the last `maxLines` lines of `text`. Lines split on `\n`.
 * A single trailing empty line (introduced by a final `\n`) is dropped so
 * we don't waste a slot on it. Returns an empty string when `maxLines <= 0`.
 */
export function tailLines(text: string, maxLines: number): string {
  if (maxLines <= 0) return '';
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= maxLines) return lines.join('\n');
  return lines.slice(lines.length - maxLines).join('\n');
}
