/**
 * HS-7969 follow-up #2 — minimal ANSI-to-safe-HTML converter for the
 * §37 quit-confirm master-detail preview pane.
 *
 * Pre-fix the preview rendered plain ANSI-stripped text — every visual
 * cue from coloured prompts, error highlights, syntax-coloured tool
 * output, etc. was lost. Mounting a real xterm.js instance would give
 * full fidelity but is overkill for a static preview; this parser
 * handles the SGR (`\x1b[…m`) sequences that 99 % of CLI tools use:
 *
 *   - 0 / empty  → reset all
 *   - 1 → bold, 22 → no-bold
 *   - 3 → italic, 23 → no-italic
 *   - 4 → underline, 24 → no-underline
 *   - 7 → reverse-video, 27 → no-reverse
 *   - 30-37 → fg basic 8 (black/red/green/yellow/blue/magenta/cyan/white)
 *   - 39 → default fg
 *   - 40-47 → bg basic 8
 *   - 49 → default bg
 *   - 90-97 → fg bright 8 (same colour names with `bright` prefix)
 *   - 100-107 → bg bright 8
 *   - 38;5;N → fg 256-colour (degraded to nearest basic-8 — the preview
 *     palette has no 256-colour table; the lossy mapping is fine for the
 *     preview)
 *   - 48;5;N → bg 256-colour (same lossy mapping)
 *   - 38;2;R;G;B → fg true-colour (rendered exactly)
 *   - 48;2;R;G;B → bg true-colour (rendered exactly)
 *
 * Any non-SGR CSI / OSC / SIMPLE-ESC sequence is dropped — it shouldn't
 * survive a static-preview render anyway (we'd need the full xterm
 * grid model to interpret cursor moves, OSC 8 hyperlinks, etc).
 *
 * Output is ALWAYS HTML-safe — the four entities `<`, `>`, `&`, `"` get
 * escaped; everything else is plain text wrapped in `<span style="…">`
 * elements. Newlines are preserved as `\n` so the caller's
 * `white-space: pre` (or `pre-wrap`) on the `<pre>` element handles
 * line breaks.
 */

export interface AnsiPalette {
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
  defaultFg: string;
  defaultBg: string;
}

interface SgrState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  reverse: boolean;
}

const INITIAL_STATE: SgrState = {
  fg: null,
  bg: null,
  bold: false,
  italic: false,
  underline: false,
  reverse: false,
};

const ESC = '';

/** Escape the four HTML special characters that matter inside a `<pre>`. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basicColorFromCode(code: number, palette: AnsiPalette): string | null {
  switch (code) {
    case 30: return palette.black;
    case 31: return palette.red;
    case 32: return palette.green;
    case 33: return palette.yellow;
    case 34: return palette.blue;
    case 35: return palette.magenta;
    case 36: return palette.cyan;
    case 37: return palette.white;
    case 90: return palette.brightBlack;
    case 91: return palette.brightRed;
    case 92: return palette.brightGreen;
    case 93: return palette.brightYellow;
    case 94: return palette.brightBlue;
    case 95: return palette.brightMagenta;
    case 96: return palette.brightCyan;
    case 97: return palette.brightWhite;
    case 40: return palette.black;
    case 41: return palette.red;
    case 42: return palette.green;
    case 43: return palette.yellow;
    case 44: return palette.blue;
    case 45: return palette.magenta;
    case 46: return palette.cyan;
    case 47: return palette.white;
    case 100: return palette.brightBlack;
    case 101: return palette.brightRed;
    case 102: return palette.brightGreen;
    case 103: return palette.brightYellow;
    case 104: return palette.brightBlue;
    case 105: return palette.brightMagenta;
    case 106: return palette.brightCyan;
    case 107: return palette.brightWhite;
  }
  return null;
}

/** Map a 256-colour index to one of the 16 basic palette entries. The
 *  preview is degraded — full 256-colour fidelity would need a 256-entry
 *  palette per theme. Indices 0-15 map to the basic 16; 16-231 fall back
 *  to brightWhite (close-enough for prompts / accents); 232-255 (greys)
 *  fall back to brightBlack / white based on intensity. */
function color256FromCode(code: number, palette: AnsiPalette): string {
  if (code <= 7) {
    return basicColorFromCode(30 + code, palette) ?? palette.defaultFg;
  }
  if (code <= 15) {
    return basicColorFromCode(90 + (code - 8), palette) ?? palette.defaultFg;
  }
  if (code <= 231) {
    return palette.brightWhite;
  }
  // 232-255 — 24-step greyscale ramp.
  return code < 244 ? palette.brightBlack : palette.white;
}

/** Render the current SGR state as a CSS string. Returns the empty string
 *  when no styling is active — caller should emit a plain text node in
 *  that case rather than wrapping in a noisy `<span style="">`. */
function stateToCss(state: SgrState): string {
  const parts: string[] = [];
  let fg = state.fg;
  let bg = state.bg;
  if (state.reverse) {
    const tmp = fg;
    fg = bg;
    bg = tmp;
  }
  if (fg !== null) parts.push(`color:${fg}`);
  if (bg !== null) parts.push(`background:${bg}`);
  if (state.bold) parts.push('font-weight:bold');
  if (state.italic) parts.push('font-style:italic');
  if (state.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

/** Apply a list of SGR codes to `state` (in place, but returns same ref). */
function applySgrCodes(state: SgrState, codes: number[], palette: AnsiPalette): void {
  // Empty `[m` is treated as `[0m` (reset) per ECMA-48.
  if (codes.length === 0) {
    Object.assign(state, INITIAL_STATE);
    return;
  }
  let i = 0;
  while (i < codes.length) {
    const code = codes[i];
    switch (code) {
      case 0:
        Object.assign(state, INITIAL_STATE);
        i++;
        break;
      case 1: state.bold = true; i++; break;
      case 22: state.bold = false; i++; break;
      case 3: state.italic = true; i++; break;
      case 23: state.italic = false; i++; break;
      case 4: state.underline = true; i++; break;
      case 24: state.underline = false; i++; break;
      case 7: state.reverse = true; i++; break;
      case 27: state.reverse = false; i++; break;
      case 39: state.fg = null; i++; break;
      case 49: state.bg = null; i++; break;
      case 38: {
        const sub = codes[i + 1];
        if (sub === 5 && i + 2 < codes.length) {
          state.fg = color256FromCode(codes[i + 2], palette);
          i += 3;
        } else if (sub === 2 && i + 4 < codes.length) {
          const r = codes[i + 2], g = codes[i + 3], b = codes[i + 4];
          state.fg = `rgb(${r},${g},${b})`;
          i += 5;
        } else {
          i++; // malformed — skip the 38 and let the next iteration recover
        }
        break;
      }
      case 48: {
        const sub = codes[i + 1];
        if (sub === 5 && i + 2 < codes.length) {
          state.bg = color256FromCode(codes[i + 2], palette);
          i += 3;
        } else if (sub === 2 && i + 4 < codes.length) {
          const r = codes[i + 2], g = codes[i + 3], b = codes[i + 4];
          state.bg = `rgb(${r},${g},${b})`;
          i += 5;
        } else {
          i++;
        }
        break;
      }
      default: {
        const basic = basicColorFromCode(code, palette);
        if (basic !== null) {
          if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
            state.fg = basic;
          } else {
            state.bg = basic;
          }
        }
        // Unrecognised codes (italic-bright, faint, blink, etc.) are skipped.
        i++;
      }
    }
  }
}

/**
 * Convert ANSI-decorated text to HTML-safe `<span>` markup. The output
 * is suitable for assigning to `el.innerHTML` because every text
 * fragment is escaped before being concatenated.
 *
 * Stops at any non-SGR CSI / OSC / SIMPLE-ESC sequence by skipping it
 * (cursor moves etc. don't make sense in a static preview).
 */
export function ansiToSafeHtml(text: string, palette: AnsiPalette): string {
  const out: string[] = [];
  const state: SgrState = { ...INITIAL_STATE };
  let plain = '';
  let openSpan = false;

  function flushPlain(): void {
    if (plain === '') return;
    const css = stateToCss(state);
    if (css === '') {
      out.push(escapeHtml(plain));
    } else {
      if (openSpan) out.push('</span>');
      out.push(`<span style="${css}">${escapeHtml(plain)}</span>`);
      openSpan = false; // each plain fragment is a self-contained span
    }
    plain = '';
  }

  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== ESC) {
      plain += ch;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next === '[') {
      // CSI sequence. Find the final byte (a letter A-Z / a-z).
      let j = i + 2;
      while (j < text.length) {
        const c = text[j];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) break;
        j++;
      }
      if (j >= text.length) { plain += ch; i++; continue; }
      const finalByte = text[j];
      const params = text.slice(i + 2, j);
      i = j + 1;
      if (finalByte !== 'm') continue; // non-SGR CSI — drop
      flushPlain();
      const codes = params === ''
        ? []
        : params.split(';').map(p => parseInt(p, 10)).filter(n => Number.isFinite(n));
      applySgrCodes(state, codes, palette);
      continue;
    }
    if (next === ']') {
      // OSC sequence — terminated by BEL or ST.
      let j = i + 2;
      while (j < text.length) {
        const c = text[j];
        if (c === '') { j++; break; }
        if (c === ESC && text[j + 1] === '\\') { j += 2; break; }
        j++;
      }
      i = j;
      continue;
    }
    // Bare ESC + single-char (cursor save / charset / etc.) — skip 2 bytes.
    if (next !== undefined && /[=>78NMPDEFGHc]/.test(next)) {
      i += 2;
      continue;
    }
    // Unrecognised — emit ESC as plain text (extremely rare).
    plain += ch;
    i++;
  }
  flushPlain();
  return out.join('');
}
