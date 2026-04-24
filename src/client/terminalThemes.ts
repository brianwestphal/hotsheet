/**
 * HS-6307 — terminal theme registry. Ordered list of curated color palettes
 * applied to every xterm surface (drawer, dashboard tile, dashboard dedicated
 * view). Adding a theme later = append an entry to TERMINAL_THEMES; the gear
 * popover reads the same array so no UI change is required.
 *
 * The `default` theme is the only entry that reads live CSS (via
 * readCssDefaultTheme) — it preserves the pre-HS-6307 behaviour from HS-7330
 * where the terminal picked up the app's --bg / --text / --accent custom
 * properties. Every other theme is a static data record.
 *
 * See docs/35-terminal-themes.md §35.2.
 */
import { withAlpha } from './xtermTheme.js';

export interface TerminalTheme {
  id: string;
  name: string;
  isDark: boolean;
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
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
}

/** xterm's ITheme subset we populate — matches @xterm/xterm's ITheme. */
export interface XtermThemeOptions {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  selectionInactiveBackground: string;
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
}

/**
 * Convert a TerminalTheme to the ITheme shape xterm expects. Every field is
 * passed through verbatim — the two shapes are intentionally parallel so this
 * mapping stays trivial.
 */
export function themeToXtermOptions(theme: TerminalTheme): XtermThemeOptions {
  return {
    foreground: theme.foreground,
    background: theme.background,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    selectionInactiveBackground: theme.selectionInactiveBackground,
    black: theme.black,
    red: theme.red,
    green: theme.green,
    yellow: theme.yellow,
    blue: theme.blue,
    magenta: theme.magenta,
    cyan: theme.cyan,
    white: theme.white,
    brightBlack: theme.brightBlack,
    brightRed: theme.brightRed,
    brightGreen: theme.brightGreen,
    brightYellow: theme.brightYellow,
    brightBlue: theme.brightBlue,
    brightMagenta: theme.brightMagenta,
    brightCyan: theme.brightCyan,
    brightWhite: theme.brightWhite,
  };
}

/**
 * Build the `default` theme at call time from the app's CSS custom properties.
 * Unlike every other theme (static records below), this one is dynamic so it
 * tracks the user's light/dark mode and accent colour. Preserves HS-7330.
 */
export function readCssDefaultTheme(): TerminalTheme {
  const css = typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
  const getColor = (name: string, fallback: string): string => {
    if (css === null) return fallback;
    return css.getPropertyValue(name).trim() || fallback;
  };
  const bg = getColor('--bg', '#ffffff');
  const fg = getColor('--text', '#000000');
  const accent = getColor('--accent', '#3b82f6');
  // Inherit xterm's default ANSI palette — users who pick `default` want the
  // app chrome colours for fg/bg/cursor without a strong opinion on the 16-
  // colour palette. These are xterm.js's own defaults.
  return {
    id: 'default',
    name: 'Default',
    isDark: false,
    foreground: fg,
    background: bg,
    cursor: accent,
    cursorAccent: bg,
    selectionBackground: withAlpha(accent, 0x66),
    selectionInactiveBackground: withAlpha(accent, 0x33),
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  };
}

const DRACULA: TerminalTheme = {
  id: 'dracula', name: 'Dracula', isDark: true,
  foreground: '#f8f8f2', background: '#282a36',
  cursor: '#f8f8f2', cursorAccent: '#282a36',
  selectionBackground: '#44475a', selectionInactiveBackground: '#44475a80',
  black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
  blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
  brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94',
  brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df',
  brightCyan: '#a4ffff', brightWhite: '#ffffff',
};

const SOLARIZED_DARK: TerminalTheme = {
  id: 'solarized-dark', name: 'Solarized Dark', isDark: true,
  foreground: '#93a1a1', background: '#002b36',
  cursor: '#93a1a1', cursorAccent: '#002b36',
  selectionBackground: '#073642', selectionInactiveBackground: '#07364280',
  black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
  blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
  brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75',
  brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
};

const SOLARIZED_LIGHT: TerminalTheme = {
  id: 'solarized-light', name: 'Solarized Light', isDark: false,
  foreground: '#657b83', background: '#fdf6e3',
  cursor: '#657b83', cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5', selectionInactiveBackground: '#eee8d580',
  black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
  blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
  brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75',
  brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
};

const NORD: TerminalTheme = {
  id: 'nord', name: 'Nord', isDark: true,
  foreground: '#d8dee9', background: '#2e3440',
  cursor: '#d8dee9', cursorAccent: '#2e3440',
  selectionBackground: '#434c5e', selectionInactiveBackground: '#434c5e80',
  black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b',
  blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
  brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb', brightWhite: '#eceff4',
};

const GRUVBOX_DARK: TerminalTheme = {
  id: 'gruvbox-dark', name: 'Gruvbox Dark', isDark: true,
  foreground: '#ebdbb2', background: '#282828',
  cursor: '#ebdbb2', cursorAccent: '#282828',
  selectionBackground: '#504945', selectionInactiveBackground: '#50494580',
  black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921',
  blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
  brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26',
  brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b',
  brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
};

const MONOKAI: TerminalTheme = {
  id: 'monokai', name: 'Monokai', isDark: true,
  foreground: '#f8f8f2', background: '#272822',
  cursor: '#f8f8f0', cursorAccent: '#272822',
  selectionBackground: '#49483e', selectionInactiveBackground: '#49483e80',
  black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
  blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
  brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e',
  brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff',
  brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
};

const ONE_DARK: TerminalTheme = {
  id: 'one-dark', name: 'One Dark', isDark: true,
  foreground: '#abb2bf', background: '#282c34',
  cursor: '#528bff', cursorAccent: '#282c34',
  selectionBackground: '#3e4451', selectionInactiveBackground: '#3e445180',
  black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#abb2bf',
  brightBlack: '#5c6370', brightRed: '#e06c75', brightGreen: '#98c379',
  brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd',
  brightCyan: '#56b6c2', brightWhite: '#ffffff',
};

const TOMORROW_NIGHT: TerminalTheme = {
  id: 'tomorrow-night', name: 'Tomorrow Night', isDark: true,
  foreground: '#c5c8c6', background: '#1d1f21',
  cursor: '#c5c8c6', cursorAccent: '#1d1f21',
  selectionBackground: '#373b41', selectionInactiveBackground: '#373b4180',
  black: '#1d1f21', red: '#cc6666', green: '#b5bd68', yellow: '#f0c674',
  blue: '#81a2be', magenta: '#b294bb', cyan: '#8abeb7', white: '#c5c8c6',
  brightBlack: '#969896', brightRed: '#cc6666', brightGreen: '#b5bd68',
  brightYellow: '#f0c674', brightBlue: '#81a2be', brightMagenta: '#b294bb',
  brightCyan: '#8abeb7', brightWhite: '#ffffff',
};

const GITHUB_DARK: TerminalTheme = {
  id: 'github-dark', name: 'GitHub Dark', isDark: true,
  foreground: '#c9d1d9', background: '#0d1117',
  cursor: '#c9d1d9', cursorAccent: '#0d1117',
  selectionBackground: '#264f78', selectionInactiveBackground: '#264f7880',
  black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

const GITHUB_LIGHT: TerminalTheme = {
  id: 'github-light', name: 'GitHub Light', isDark: false,
  foreground: '#24292f', background: '#ffffff',
  cursor: '#24292f', cursorAccent: '#ffffff',
  selectionBackground: '#0969da33', selectionInactiveBackground: '#0969da1a',
  black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00',
  blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
  brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
  brightYellow: '#633c01', brightBlue: '#218bff', brightMagenta: '#a475f9',
  brightCyan: '#3192aa', brightWhite: '#8c959f',
};

/**
 * Ordered registry of every theme that ships with Hot Sheet. The gear-button
 * popover renders one <option> per entry in this order. Adding a new theme is
 * a single-entry append — no other code changes required.
 *
 * `default` is first intentionally so the dropdown shows it at the top, where
 * users looking for "the normal one" expect to find it.
 */
export const TERMINAL_THEMES: readonly TerminalTheme[] = [
  // `default` is produced dynamically via getThemeById so it reads the current
  // CSS at apply time — we still list it first so the popover can reference it
  // via getThemeById + the id/name metadata.
  { ...readCssDefaultTheme(), id: 'default', name: 'Default' },
  DRACULA,
  SOLARIZED_DARK,
  SOLARIZED_LIGHT,
  NORD,
  GRUVBOX_DARK,
  MONOKAI,
  ONE_DARK,
  TOMORROW_NIGHT,
  GITHUB_DARK,
  GITHUB_LIGHT,
];

export const DEFAULT_THEME_ID = 'default';

/**
 * Resolve a theme by id. Returns null for an unknown id so callers can decide
 * whether to fall back + warn or hard-fail. The `default` entry is built
 * fresh on every call so it tracks live CSS changes (dark-mode toggle etc).
 */
export function getThemeById(id: string): TerminalTheme | null {
  if (id === 'default') return readCssDefaultTheme();
  for (const theme of TERMINAL_THEMES) {
    if (theme.id === id) return theme;
  }
  return null;
}
