/**
 * HS-6307 — resolve + apply per-terminal appearance (theme + font + size).
 *
 * Three layers, field-wise (see docs/35-terminal-themes.md §35.4):
 *   session override > configured override > project default > hard-coded fallback
 *
 * Each field of {theme, fontFamily, fontSize} is resolved independently — a
 * configured terminal with `{ theme: 'dracula' }` but no font override
 * inherits the project default's fontFamily.
 */
import {
  clampFontSize,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  getFontById,
  loadGoogleFont,
} from './terminalFonts.js';
import {
  DEFAULT_THEME_ID,
  getThemeById,
  themeToXtermOptions,
} from './terminalThemes.js';

export interface TerminalAppearance {
  theme: string;        // theme id
  fontFamily: string;   // font id
  fontSize: number;     // clamped integer px
}

export const FALLBACK_APPEARANCE: TerminalAppearance = {
  theme: DEFAULT_THEME_ID,
  fontFamily: DEFAULT_FONT_ID,
  fontSize: DEFAULT_FONT_SIZE,
};

export interface AppearanceLayers {
  projectDefault?: Partial<TerminalAppearance>;
  configOverride?: Partial<TerminalAppearance>;
  sessionOverride?: Partial<TerminalAppearance>;
}

/**
 * Walk the layers from highest priority (session) to lowest (fallback),
 * picking each field from the first layer that sets it. Returns a fully-
 * populated TerminalAppearance with no undefined fields.
 */
export function resolveAppearance(layers: AppearanceLayers): TerminalAppearance {
  const pick = <K extends keyof TerminalAppearance>(field: K): TerminalAppearance[K] => {
    const { sessionOverride, configOverride, projectDefault } = layers;
    if (sessionOverride?.[field] !== undefined) return sessionOverride[field] as TerminalAppearance[K];
    if (configOverride?.[field] !== undefined) return configOverride[field] as TerminalAppearance[K];
    if (projectDefault?.[field] !== undefined) return projectDefault[field] as TerminalAppearance[K];
    return FALLBACK_APPEARANCE[field];
  };

  const theme = pick('theme');
  const fontFamily = pick('fontFamily');
  const fontSize = clampFontSize(pick('fontSize'));

  return {
    // Unknown ids fall back to the hard-coded default — validated below so
    // the caller can log once rather than at every apply.
    theme: getThemeById(theme) !== null ? theme : FALLBACK_APPEARANCE.theme,
    fontFamily: getFontById(fontFamily) !== null ? fontFamily : FALLBACK_APPEARANCE.fontFamily,
    fontSize,
  };
}

// Module-scoped session-override map. Keyed by terminal id. Cleared on page
// reload; survives PTY restart so the user's manual tweak in the gear popover
// isn't wiped when they Stop → Start a terminal.
const sessionOverrides = new Map<string, Partial<TerminalAppearance>>();

/** Read the session override for a terminal. Undefined if none is set. */
export function getSessionOverride(terminalId: string): Partial<TerminalAppearance> | undefined {
  return sessionOverrides.get(terminalId);
}

/** Merge a partial override into the session map. Pass an empty object (or
 *  omit the field) to leave existing values untouched — pass field: undefined
 *  to delete a field. */
export function setSessionOverride(terminalId: string, partial: Partial<TerminalAppearance>): void {
  const current = sessionOverrides.get(terminalId) ?? {};
  const next: Record<string, unknown> = { ...current };
  // Cast the entries iteration so we can detect explicit `undefined` values
  // (the "delete this field" convention) — Object.entries strips optionality
  // from Partial<> so TS otherwise thinks `value` is never undefined.
  for (const [key, value] of Object.entries(partial) as Array<[string, unknown]>) {
    if (value === undefined) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  if (Object.keys(next).length === 0) {
    sessionOverrides.delete(terminalId);
  } else {
    sessionOverrides.set(terminalId, next as Partial<TerminalAppearance>);
  }
}

/** Drop the session override for a terminal — used by the "Reset to project
 *  default" link in the popover. */
export function clearSessionOverride(terminalId: string): void {
  sessionOverrides.delete(terminalId);
}

/** Test-only helper. */
export function _resetSessionOverridesForTests(): void {
  sessionOverrides.clear();
}

/** Minimal xterm surface the apply helper needs. Typed loosely so the helper
 *  works against both the real @xterm/xterm Terminal and test doubles. */
export interface XtermLikeForAppearance {
  options: {
    theme?: unknown;
    fontFamily?: string;
    fontSize?: number;
  };
}

/**
 * Apply a resolved appearance to an xterm instance. Loads the font first (so
 * the canvas doesn't flash system glyphs for a frame), then assigns
 * theme / fontFamily / fontSize. Returns a promise for the font-load step;
 * callers that don't care about the flash can fire-and-forget.
 */
export async function applyAppearanceToTerm(
  term: XtermLikeForAppearance,
  appearance: TerminalAppearance,
): Promise<void> {
  const theme = getThemeById(appearance.theme) ?? getThemeById(DEFAULT_THEME_ID)!;
  const font = getFontById(appearance.fontFamily) ?? getFontById(DEFAULT_FONT_ID)!;

  await loadGoogleFont(font);

  term.options.theme = themeToXtermOptions(theme);
  term.options.fontFamily = font.family;
  term.options.fontSize = clampFontSize(appearance.fontSize);
}

// ---- Project-default state + loader --------------------------------------

/**
 * Fetch the active project's `terminal_default` setting and cache it for
 * every mountXterm / mountTileXterm call to read. Fires the
 * default-changed event so already-mounted xterms re-resolve.
 *
 * Called on app boot, on project switch (via loadAndRenderTerminalTabs), and
 * after the Settings UI writes a new default.
 *
 * No-op on fetch failure — the cache keeps its prior value (falls back to
 * FALLBACK_APPEARANCE on first load).
 */
export async function loadProjectDefaultAppearance(): Promise<void> {
  if (typeof fetch === 'undefined') return;
  try {
    // Local import to avoid a circular dep between appearance <-> api.
    const { api } = await import('./api.js');
    const fs = await api<{ terminal_default?: unknown }>('/file-settings');
    const parsed = parseProjectDefault(fs.terminal_default);
    setProjectDefault(parsed);
  } catch {
    /* keep prior value */
  }
}


let projectDefault: Partial<TerminalAppearance> = {};

/** Read the cached project default appearance. */
export function getProjectDefault(): Partial<TerminalAppearance> {
  return projectDefault;
}

/** Replace the cached project default appearance and notify subscribers. */
export function setProjectDefault(next: Partial<TerminalAppearance>): void {
  projectDefault = { ...next };
  notifyDefaultAppearanceChanged();
}

/**
 * Normalize a raw `terminal_default` value from settings.json / the
 * /file-settings response into a Partial<TerminalAppearance>. Unknown-shape
 * inputs return an empty object so callers can safely `resolveAppearance`.
 *
 * Exported so tests can assert the parsing contract without round-tripping
 * through the live fetch.
 */
export function parseProjectDefault(raw: unknown): Partial<TerminalAppearance> {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const out: Partial<TerminalAppearance> = {};
  if (typeof obj.theme === 'string' && obj.theme !== '') out.theme = obj.theme;
  if (typeof obj.fontFamily === 'string' && obj.fontFamily !== '') out.fontFamily = obj.fontFamily;
  if (typeof obj.fontSize === 'number' && Number.isFinite(obj.fontSize)) out.fontSize = obj.fontSize;
  return out;
}

/** Test-only — reset the cached project default. */
export function _resetProjectDefaultForTests(): void {
  projectDefault = {};
}

// ---- Project-default change pub/sub --------------------------------------

const DEFAULT_CHANGED_EVENT = 'hotsheet:terminal-default-changed';

/**
 * Notify every mounted xterm that the project-default appearance changed —
 * fires when the Settings → Terminal "Default appearance" panel updates
 * `terminal_default` in `settings.json`. Listeners re-resolve their own
 * appearance and call applyAppearanceToTerm.
 */
export function notifyDefaultAppearanceChanged(): void {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(DEFAULT_CHANGED_EVENT));
  }
}

export function subscribeToDefaultAppearanceChanges(handler: () => void): () => void {
  if (typeof document === 'undefined') return () => { /* no-op */ };
  const listener = (): void => { handler(); };
  document.addEventListener(DEFAULT_CHANGED_EVENT, listener);
  return () => { document.removeEventListener(DEFAULT_CHANGED_EVENT, listener); };
}
