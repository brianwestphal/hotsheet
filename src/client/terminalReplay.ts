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
 * history's origin dims BEFORE writing the bytes — the bytes were produced
 * at the server-side session's (cols × rows) and only render correctly when
 * the receiving buffer matches those dims. Writing first into xterm's own
 * default 80×24 buffer and THEN resizing clips / wraps escape sequences,
 * zsh's PROMPT_SP EOL mark, and shell OSC-integration prefixes (e.g. Apple
 * Terminal's "Restored session: …"), and the leftover glyphs survive the
 * subsequent resize + `fit()` as stray characters at the top of the pane
 * (HS-6799).
 *
 * Note: first-attach to an eager-spawned session is handled specially on the
 * server — the registry resizes the PTY to the client's real dims, clears
 * the stale 80×24 scrollback, and pokes the shell with Ctrl-L so the prompt
 * is redrawn at the correct geometry. In that case the history frame is
 * effectively empty and this helper is a no-op.
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

/** Minimal fit-addon surface consumed by `applyDedicatedHistoryFrame`. */
export interface Fittable {
  fit(): void;
}

/**
 * Apply a history frame in the dashboard's dedicated view (HS-6836). Runs the
 * same resize-then-write replay as `replayHistoryToTerm`, then re-fits the
 * terminal to its pane.
 *
 * Why the extra fit (HS-7063): `replayHistoryToTerm` resizes xterm to the
 * history frame's cols × rows so the scrollback bytes render correctly. That
 * `term.resize(..)` fires `onResize`, and the dedicated-view handler relays
 * it to the server, which shrinks the PTY to the history dims. The dedicated
 * view is a full-viewport workspace, not a peek — without a follow-up fit,
 * nano / vim / less etc. stay at whatever size the drawer last sized them to
 * and leave the bottom of the pane empty.
 */
export function applyDedicatedHistoryFrame(
  term: ReplayableTerm,
  fit: Fittable,
  h: { bytes: string; cols: number; rows: number },
): void {
  replayHistoryToTerm(term, h);
  try { fit.fit(); } catch { /* body not laid out yet — next ResizeObserver tick retries */ }
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
