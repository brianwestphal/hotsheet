/**
 * HS-8089 — OSC + bell scanner extracted from `src/terminals/registry.ts`.
 *
 * Scans a chunk of PTY output for (1) a *real* bell — a `\x07` byte that
 * isn't the terminator of an OSC/DCS/APC/PM/SOS string — (2) OSC 9 desktop
 * notification payloads (`\x1b]9;<message>\x07`, HS-7264), and (3) OSC 7
 * current-working-directory pushes (`\x1b]7;file://host/path\x07`,
 * HS-7278 — so the dashboard can render a CWD badge on cold tiles
 * without mounting xterm).
 *
 * Many shells emit OSC sequences like `\x1b]0;TITLE\x07` or
 * `\x1b]7;file://host/cwd\x07` on every prompt; the trailing BEL is a
 * terminator, not a user-visible bell. A naive `chunk.includes(0x07)`
 * check would treat those as bells (HS-6766), so we track in-string state
 * across chunks and only count BEL bytes that aren't terminators.
 *
 * `OscScanState` is the subset of the host session state the scanner
 * mutates; the registry's `SessionState` is a superset of this so the
 * registry can pass `session` directly.
 */

/** Cap on the OSC accumulator so a malformed or adversarial stream can't pin
 *  a session's heap usage. OSC payloads in real use are short (titles, URLs,
 *  notification strings) — 4 KiB is generous. HS-7264. */
export const MAX_OSC_PAYLOAD_LEN = 4096;

export interface OscScanState {
  /** Currently inside an OSC/DCS/APC/PM/SOS string (`\x1b]...` so far). */
  bellScanInString: boolean;
  /** Just saw an `ESC`; deciding what kind of escape this is on the next byte. */
  bellScanAfterEsc: boolean;
  /** Accumulated OSC payload bytes so we can inspect on string close.
   *  null when not inside an OSC (DCS/APC/PM/SOS skip the alloc). */
  oscAccumulator: string | null;
}

export interface ScanChunkResult {
  bell: boolean;
  osc9Message: string | null;
  osc7Cwd: string | null;
}

/**
 * Scan one chunk of PTY output. State is stored on the caller's `state`
 * object so it carries across chunks — a shell could flush an OSC
 * introducer in one write and the BEL terminator in the next. Returns the
 * most recent osc9 / osc7 values seen in the chunk (later payloads
 * overwrite earlier ones — latest-wins).
 */
export function scanPtyChunk(state: OscScanState, chunk: Buffer): ScanChunkResult {
  let foundBell = false;
  let osc9Message: string | null = null;
  let osc7Cwd: string | null = null;
  for (let i = 0; i < chunk.length; i++) {
    const b = chunk[i];
    if (state.bellScanInString) {
      if (b === 0x07) {
        // BEL = OSC-style terminator; close the string and inspect payload.
        const parsed = finishOscString(state);
        if (parsed.osc9 !== null) osc9Message = parsed.osc9;
        if (parsed.osc7 !== null) osc7Cwd = parsed.osc7;
        state.bellScanInString = false;
        state.bellScanAfterEsc = false;
        state.oscAccumulator = null;
        continue;
      }
      if (state.bellScanAfterEsc) {
        state.bellScanAfterEsc = false;
        if (b === 0x5C /* backslash */) {
          // ESC\ (ST) = terminator.
          const parsed = finishOscString(state);
          if (parsed.osc9 !== null) osc9Message = parsed.osc9;
          if (parsed.osc7 !== null) osc7Cwd = parsed.osc7;
          state.bellScanInString = false;
          state.oscAccumulator = null;
          continue;
        }
        // ESC followed by other: the string is effectively broken, but to
        // stay conservative we remain in string-state until a real terminator.
      }
      if (b === 0x1B) {
        state.bellScanAfterEsc = true;
        continue;
      }
      // Plain content byte inside a string escape. Append to the OSC payload
      // buffer if we're tracking one (i.e. this is an OSC, not DCS/APC/PM/SOS).
      if (state.oscAccumulator !== null && state.oscAccumulator.length < MAX_OSC_PAYLOAD_LEN) {
        state.oscAccumulator += String.fromCharCode(b);
      }
      continue;
    }
    if (state.bellScanAfterEsc) {
      state.bellScanAfterEsc = false;
      if (b === 0x5D /* ] */) {
        // OSC introducer — begin string AND begin accumulating payload bytes.
        state.bellScanInString = true;
        state.oscAccumulator = '';
        continue;
      }
      if (b === 0x50 || b === 0x5F || b === 0x5E || b === 0x58) {
        // DCS=P, APC=_, PM=^, SOS=X: string-type escapes whose contents must
        // not be interpreted as bells, but we don't need to inspect their
        // payloads. Leave accumulator null so no memory is spent.
        state.bellScanInString = true;
        state.oscAccumulator = null;
        continue;
      }
      // Any other ESC-prefixed byte is a non-string escape (CSI, SS3, charset
      // switches like ESC(0, etc.) — drop back to normal scanning so the next
      // iteration evaluates `b` against the bell check below.
    }
    if (b === 0x1B) {
      state.bellScanAfterEsc = true;
      continue;
    }
    if (b === 0x07) {
      foundBell = true;
    }
  }
  return { bell: foundBell, osc9Message, osc7Cwd };
}

/**
 * Called on OSC-string close. Inspects the accumulated payload for the
 * two OSC numbers Hot Sheet cares about — `9;<message>` for desktop
 * notifications (HS-7264) and `7;file://host/path` for the shell's
 * current working directory (HS-7278). Titles (`0;`, `1;`, `2;`),
 * hyperlinks (`8;`), and everything else pass through without affecting
 * state. Returns the parsed value for whichever OSC number matched (at
 * most one can match).
 */
export function finishOscString(state: OscScanState): { osc9: string | null; osc7: string | null } {
  if (state.oscAccumulator === null) return { osc9: null, osc7: null };
  const payload = state.oscAccumulator;
  if (payload.startsWith('9;')) {
    const rest = payload.slice(2);
    // iTerm2 has proprietary numeric sub-commands in the 9 namespace (9;1
    // for progress, 9;4 for newer progress, etc.). They start with
    // `<digit>;` which is NOT a human-readable message. Skip them — the
    // plain `9;<message>` form is the only one we surface as a
    // notification.
    if (/^\d+;/.test(rest)) return { osc9: null, osc7: null };
    return { osc9: rest, osc7: null };
  }
  if (payload.startsWith('7;')) {
    // HS-7278 — `file://host/path` parsing. Empty host is accepted
    // (`file:///path`); percent-encoded bytes are decoded. Anything that
    // doesn't parse to a file URL is rejected — we don't want to surface
    // garbled text as a CWD.
    const rest = payload.slice(2);
    if (!rest.startsWith('file://')) return { osc9: null, osc7: null };
    const afterScheme = rest.slice('file://'.length);
    const pathStart = afterScheme.indexOf('/');
    if (pathStart < 0) return { osc9: null, osc7: null };
    try {
      return { osc9: null, osc7: decodeURIComponent(afterScheme.slice(pathStart)) };
    } catch {
      return { osc9: null, osc7: null };
    }
  }
  return { osc9: null, osc7: null };
}
