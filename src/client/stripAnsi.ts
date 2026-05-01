/**
 * HS-7983 — pure ANSI-stripping helper for the Commands Log streaming
 * live render. Mirrors `src/terminals/scrollbackSnapshot.ts`'s
 * implementation; kept client-local so the bundler doesn't pull in the
 * server-side `Buffer`-using `buildScrollbackPreview`. The regex set is
 * conservative — it only collapses sequences we recognise; unknown
 * escapes stay in place rather than corrupting characters.
 *
 * `tailLines` was originally deleted with HS-8015's sidebar-preview
 * removal, then restored by HS-8015 follow-up #2 when the running-shell
 * Commands Log entry started rendering a 3-line live preview alongside
 * the full pre — collapsed rows show only the most recent few lines,
 * expanded rows show the full live buffer.
 *
 * See `docs/53-streaming-shell-output.md` §53.5 Phase 3.
 */

// HS-8093 — these regexes are intentionally matching control characters
// (ANSI escape `\x1b`, BEL `\x07`, BS `\x08`); the `no-control-regex`
// rule's default-on stance is for the common case where a control char
// in a regex is a typo. Here it's the literal contract.
/* eslint-disable no-control-regex */
const CSI_RX = /\x1b\[[0-9;?]*[A-Za-z]/g;
const OSC_RX = /\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const SIMPLE_ESC_RX = /\x1b[=>78NMPDEFGHc]/g;
const CR_BUT_NOT_CRLF_RX = /\r(?!\n)/g;
const BACKSPACE_RX = /\x08/g;
/* eslint-enable no-control-regex */

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
 * Return the trailing `maxLines` lines of `text`. A final empty line
 * caused by a trailing newline is dropped first so a buffer ending in
 * `\n` returns the visually-meaningful tail rather than `(N-1) lines + ''`.
 *
 * `maxLines <= 0` → empty string. Empty input → empty string.
 */
export function tailLines(text: string, maxLines: number): string {
  if (maxLines <= 0 || text === '') return '';
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-maxLines).join('\n');
}
