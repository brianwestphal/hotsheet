/**
 * HS-6307 — resolve + apply per-terminal appearance (theme + font + size).
 *
 * Three layers, field-wise (see docs/35-terminal-themes.md §35.4):
 *   session override \> configured override \> project default \> hard-coded fallback
 *
 * Each field of `{theme, fontFamily, fontSize}` is resolved independently — a
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
 *  works against both the real `@xterm/xterm` Terminal and test doubles. */
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

/**
 * HS-7960 — resolve the active theme background color for an appearance,
 * exported so callers (drawer terminal, dashboard tile, dashboard dedicated
 * view) can paint their padded gutter to match the canvas. Returns the
 * theme's `background` field directly; falls back to the default theme's bg
 * when the configured theme id is unknown.
 */
export function resolveAppearanceBackground(appearance: TerminalAppearance): string {
  const theme = getThemeById(appearance.theme) ?? getThemeById(DEFAULT_THEME_ID)!;
  return theme.background;
}

// ---- Project-default state + loader --------------------------------------

/**
 * HS-8283 — per-project default appearance cache, keyed by project secret.
 *
 * Pre-fix this was a single module-level `Partial<TerminalAppearance>` shared
 * across every consumer. The Terminal Dashboard ({@link
 * subscribeToDefaultAppearanceChanges} subscriber) shows tiles for terminals
 * across EVERY project simultaneously, but every tile resolved its appearance
 * against that one shared cache — which only ever held the active project's
 * default. Adding a new project folder kicked the cache to the new project's
 * empty default, fired the change event, and the dashboard re-resolved every
 * tile's appearance against the now-empty default — so tiles for other
 * projects (whose terminals had no per-terminal override) flashed to
 * {@link FALLBACK_APPEARANCE}. The user's symptom: "all my terminals
 * temporarily revert to default coloring."
 *
 * Now keyed by secret. {@link getProjectDefault} defaults to the active
 * project's secret when none is provided (preserves the pre-fix call shape
 * for consumers that only care about the active project), but the dashboard
 * passes each tile's project secret so cross-project tiles resolve against
 * their own project's default.
 */
const projectDefaultsBySecret = new Map<string, Partial<TerminalAppearance>>();

/**
 * Fetch the given project's `terminal_default` setting and cache it under
 * its secret. Fires the default-changed event so already-mounted xterms
 * (whose project this is) re-resolve. Called on app boot, on project
 * switch (via loadAndRenderTerminalTabs — no secret arg uses the active
 * project), per-project from the dashboard's `fetchProjectSections`, and
 * after the Settings UI writes a new default.
 *
 * No-op on fetch failure — the cache keeps its prior value (falls back to
 * FALLBACK_APPEARANCE on first load).
 *
 * @param secret - Optional project secret. When omitted, fetches for the
 *                  active project via the default `/file-settings` route.
 *                  When provided and not the active project, uses
 *                  `apiWithSecret` to address that project specifically.
 */
export async function loadProjectDefaultAppearance(secret?: string): Promise<void> {
  if (typeof fetch === 'undefined') return;
  try {
    // Local imports to avoid a circular dep between appearance <-> api/state.
    const { getFileSettings } = await import('../api/index.js');
    const { getActiveProject } = await import('./state.js');

    const activeSecret = getActiveProject()?.secret ?? null;
    const targetSecret = secret ?? activeSecret;
    if (targetSecret === null) return; // no active project, nothing to cache

    const fs = (secret !== undefined && secret !== activeSecret)
      ? await getFileSettings(secret)
      : await getFileSettings();

    const parsed = parseProjectDefault(fs.terminal_default);
    setProjectDefault(targetSecret, parsed);
  } catch {
    /* keep prior value */
  }
}


/**
 * Read the cached project default appearance for a specific project.
 *
 * @param secret - Project secret. Empty string returns `{}` (caller has no
 *                  active project / no secret known at the callsite). Unknown
 *                  secrets also return `{}` so the resolve path always
 *                  degrades to `FALLBACK_APPEARANCE` rather than throwing.
 */
export function getProjectDefault(secret: string): Partial<TerminalAppearance> {
  if (secret === '') return {};
  return projectDefaultsBySecret.get(secret) ?? {};
}

/**
 * Replace the cached project default appearance for a specific secret and
 * notify subscribers. Dedups: skips notification when the new value
 * shallow-equals the prior value (no observable consumer effect, but
 * spurious re-renders would flicker the dashboard / drawer terminal during
 * back-to-back project switches that don't actually change a default).
 *
 * @param secret - Project secret the value belongs to. Required — the
 *                  pre-HS-8283 implementation took an unscoped global value;
 *                  that's what the bug was.
 * @param next - The new partial appearance.
 */
export function setProjectDefault(secret: string, next: Partial<TerminalAppearance>): void {
  if (secret === '') return;
  const prev = projectDefaultsBySecret.get(secret);
  const sanitized = { ...next };
  if (prev !== undefined && shallowEqualPartial(prev, sanitized)) return;
  projectDefaultsBySecret.set(secret, sanitized);
  notifyDefaultAppearanceChanged(secret);
}

function shallowEqualPartial(a: Partial<TerminalAppearance>, b: Partial<TerminalAppearance>): boolean {
  return a.theme === b.theme && a.fontFamily === b.fontFamily && a.fontSize === b.fontSize;
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

/** Test-only — reset every cached project default. */
export function _resetProjectDefaultForTests(): void {
  projectDefaultsBySecret.clear();
}

// ---- Project-default change pub/sub --------------------------------------

const DEFAULT_CHANGED_EVENT = 'hotsheet:terminal-default-changed';

/**
 * Notify subscribers that the project-default appearance changed for a
 * specific project. HS-8283 — pre-fix this carried no detail, so every
 * subscriber re-rendered indiscriminately. Now carries the changed secret
 * so subscribers can scope their work (drawer ignores non-active changes;
 * dashboard re-renders only the affected project's section).
 */
export function notifyDefaultAppearanceChanged(secret: string): void {
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent(DEFAULT_CHANGED_EVENT, { detail: { secret } }));
  }
}

/**
 * Subscribe to default-appearance changes. The handler receives the secret
 * of the project whose default changed — subscribers should filter on it
 * before doing any expensive re-render work.
 */
export function subscribeToDefaultAppearanceChanges(handler: (secret: string) => void): () => void {
  if (typeof document === 'undefined') return () => { /* no-op */ };
  const listener = (e: Event): void => {
    const detail = (e as CustomEvent<{ secret?: unknown } | null>).detail;
    const secret = detail != null && typeof detail.secret === 'string' ? detail.secret : '';
    handler(secret);
  };
  document.addEventListener(DEFAULT_CHANGED_EVENT, listener);
  return () => { document.removeEventListener(DEFAULT_CHANGED_EVENT, listener); };
}
