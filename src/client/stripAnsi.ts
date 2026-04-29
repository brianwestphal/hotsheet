/**
 * HS-7983 — pure ANSI-stripping helper for the Commands Log streaming
 * live render. Mirrors `src/terminals/scrollbackSnapshot.ts`'s
 * implementation; kept client-local so the bundler doesn't pull in the
 * server-side `Buffer`-using `buildScrollbackPreview`. The regex set is
 * conservative — it only collapses sequences we recognise; unknown
 * escapes stay in place rather than corrupting characters.
 *
 * (HS-8015 removed the sidebar partial-preview consumer; only the
 * Commands Log live render remains. `tailLines` lived alongside this
 * helper to truncate the sidebar preview to the trailing 1–2 lines and
 * was deleted with that path — the Commands Log writes the full
 * stripped buffer into a scrollable `<pre>`.)
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
