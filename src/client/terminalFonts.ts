/**
 * HS-6307 — terminal font registry. Mirrors the themes registry shape (see
 * terminalThemes.ts) — adding a font later is a single-entry append to
 * TERMINAL_FONTS; the gear popover reads the same array so the UI stays in
 * sync automatically.
 *
 * Every non-system entry is a Google Fonts family. The System entry uses the
 * OS's built-in mono stack (the same stack Hot Sheet's terminal used pre-
 * HS-6307) and short-circuits the loadGoogleFont path so it resolves
 * immediately with no network request.
 *
 * See docs/35-terminal-themes.md §35.3.
 */

export interface TerminalFont {
  id: string;
  name: string;
  /** Full CSS font-family value. Non-system entries put the Google Fonts
   *  family first, followed by the System fallback stack so a missing web
   *  font lands on Menlo / SF Mono without an error. */
  family: string;
  /** The Google Fonts family name (space-separated, e.g. "JetBrains Mono").
   *  null for System — no network fetch required. */
  googleFontsName: string | null;
}

/** Shared fallback stack appended after every Google Fonts family so a missing
 *  web font falls back cleanly to the OS mono. */
const SYSTEM_MONO_STACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", monospace';

function gf(id: string, name: string, googleName: string): TerminalFont {
  return {
    id,
    name,
    family: `"${googleName}", ${SYSTEM_MONO_STACK}`,
    googleFontsName: googleName,
  };
}

export const TERMINAL_FONTS: readonly TerminalFont[] = [
  { id: 'system', name: 'System', family: SYSTEM_MONO_STACK, googleFontsName: null },
  gf('jetbrains-mono', 'JetBrains Mono', 'JetBrains Mono'),
  gf('fira-code', 'Fira Code', 'Fira Code'),
  gf('source-code-pro', 'Source Code Pro', 'Source Code Pro'),
  gf('ibm-plex-mono', 'IBM Plex Mono', 'IBM Plex Mono'),
  gf('roboto-mono', 'Roboto Mono', 'Roboto Mono'),
  gf('inconsolata', 'Inconsolata', 'Inconsolata'),
  gf('ubuntu-mono', 'Ubuntu Mono', 'Ubuntu Mono'),
  gf('space-mono', 'Space Mono', 'Space Mono'),
  gf('anonymous-pro', 'Anonymous Pro', 'Anonymous Pro'),
  gf('cascadia-code', 'Cascadia Code', 'Cascadia Code'),
];

export const DEFAULT_FONT_ID = 'system';
export const DEFAULT_FONT_SIZE = 13;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

/** Look up a font by id. Returns null for unknown ids; callers fall back to
 *  System with a console.warn. */
export function getFontById(id: string): TerminalFont | null {
  for (const font of TERMINAL_FONTS) {
    if (font.id === id) return font;
  }
  return null;
}

/** Clamp a font size into the shipped [MIN, MAX] range. */
export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FONT_SIZE;
  const rounded = Math.round(value);
  if (rounded < MIN_FONT_SIZE) return MIN_FONT_SIZE;
  if (rounded > MAX_FONT_SIZE) return MAX_FONT_SIZE;
  return rounded;
}

/** Build the Google Fonts CSS URL for a given family. Exported for tests. */
export function buildGoogleFontsUrl(familyName: string): string {
  // Use css2 + display=swap so the browser paints with the fallback until the
  // webfont loads, avoiding FOIT on the xterm canvas.
  const encoded = encodeURIComponent(familyName);
  return `https://fonts.googleapis.com/css2?family=${encoded}&display=swap`;
}

// Cache of in-flight / completed font loads. Keyed by font id so concurrent
// calls for the same font share one network request.
const loadedFonts = new Map<string, Promise<void>>();

/**
 * Load a Google Font so xterm can render its glyphs. Idempotent and
 * concurrency-safe: repeated calls for the same font return the first call's
 * promise rather than opening a second <link> / fetch.
 *
 * System fonts short-circuit with an already-resolved promise.
 *
 * Failure mode: if Google Fonts is unreachable, `document.fonts.load` resolves
 * with an empty array rather than rejecting — xterm then lands on the System
 * fallback via the font-family stack. We deliberately do NOT round-trip the
 * failure to the UI in v1; the popover shows the font as "selected" and the
 * user sees System glyphs until the network recovers.
 */
export function loadGoogleFont(font: TerminalFont): Promise<void> {
  if (font.googleFontsName === null) return Promise.resolve();
  const existing = loadedFonts.get(font.id);
  if (existing !== undefined) return existing;

  const promise = (async () => {
    if (typeof document === 'undefined') return;
    // Append the <link> if not already present. Reuse a data-font-id attribute
    // for idempotency against the DOM itself (not just the in-memory cache) —
    // HMR / partial reloads can wipe the cache while leaving the DOM intact.
    const existingLink = document.querySelector<HTMLLinkElement>(`link[data-terminal-font-id="${font.id}"]`);
    if (existingLink === null) {
      // HS-8098 — file is `.ts` (no JSX). The `<link rel="stylesheet">`
      // injection is also borderline-pure-side-effect (it triggers Google
      // Fonts download); JSX would be ceremony for one append.
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = buildGoogleFontsUrl(font.googleFontsName!);
      link.setAttribute('data-terminal-font-id', font.id);
      document.head.appendChild(link);
    }
    // Wait for the actual glyph bytes. document.fonts.load resolves when any
    // matching FontFace has loaded — we use a medium size (13px) which is the
    // shipped default; size-specific loading isn't a correctness concern
    // because the same font file serves every size.
    // `document.fonts` is always present in modern browsers; this await
    // waits for the actual glyph bytes before xterm re-renders. Wrapped in
    // try/catch because Google Fonts can be unreachable (offline, firewalls)
    // and we'd rather fall back silently to the System stack than log.
    try {
      await document.fonts.load(`${DEFAULT_FONT_SIZE}px "${font.googleFontsName}"`);
    } catch {
      /* swallow — xterm will render with the fallback stack */
    }
  })();

  loadedFonts.set(font.id, promise);
  return promise;
}

/** Test-only helper: reset the in-flight cache + remove any injected <link>. */
export function _resetFontCacheForTests(): void {
  loadedFonts.clear();
  if (typeof document !== 'undefined') {
    document.querySelectorAll('link[data-terminal-font-id]').forEach(el => el.remove());
  }
}
