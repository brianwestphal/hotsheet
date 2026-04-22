/**
 * Pure helper used by `src/client/terminal.tsx` to apply a server-side
 * `history` frame to an xterm instance on attach.
 *
 * Extracted into its own `.ts` file (no JSX imports) so it can be unit-tested
 * without dragging in the JSX runtime (HS-6799). The ordering invariant is
 * what matters: **resize first, write second** — see `replayHistoryToTerm`.
 */

/** Minimal xterm surface that `replayHistoryToTerm` depends on. */
export interface ReplayableTerm {
  resize(cols: number, rows: number): void;
  write(data: Uint8Array): void;
}

/**
 * Replay a `history` frame onto an xterm instance. Resizes the buffer to the
 * history's origin dims BEFORE writing the bytes — eager-spawned terminals
 * (`lazy:false`) accumulate PTY output at the server's default 80×24 long
 * before any client attaches, and the history bytes only render correctly
 * when the receiving buffer matches those dims. Writing first into xterm's
 * own default 80×24 buffer and THEN resizing causes cursor-positioning
 * escapes, zsh's PROMPT_SP EOL mark, and shell OSC-integration prefixes
 * (e.g. Apple Terminal's "Restored session: …") to clip or wrap against the
 * narrow buffer; the leftover glyphs survive the subsequent resize + `fit()`
 * and appear as stray characters at the top of the pane in production
 * builds (HS-6799).
 */
export function replayHistoryToTerm(
  term: ReplayableTerm,
  h: { bytes: string; cols: number; rows: number },
): void {
  if (Number.isFinite(h.cols) && Number.isFinite(h.rows) && h.cols > 0 && h.rows > 0) {
    term.resize(h.cols, h.rows);
  }
  if (typeof h.bytes === 'string' && h.bytes.length > 0) {
    term.write(base64ToUint8Array(h.bytes));
  }
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
