/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the HS-6307 terminal theme registry (see
 * docs/35-terminal-themes.md §35.2).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_THEME_ID,
  getThemeById,
  readCssDefaultTheme,
  TERMINAL_THEMES,
  type TerminalTheme,
  themeToXtermOptions,
} from './terminalThemes.js';

const THEME_FIELDS: Array<keyof TerminalTheme> = [
  'id', 'name', 'isDark',
  'foreground', 'background', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionInactiveBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

describe('TERMINAL_THEMES registry', () => {
  it('ships 11 themes in a defined order', () => {
    expect(TERMINAL_THEMES).toHaveLength(11);
    // Spot-check the first and last entries so a future resort is caught.
    expect(TERMINAL_THEMES[0].id).toBe('default');
    expect(TERMINAL_THEMES[TERMINAL_THEMES.length - 1].id).toBe('github-light');
  });

  it('every theme has the full TerminalTheme shape', () => {
    for (const theme of TERMINAL_THEMES) {
      for (const field of THEME_FIELDS) {
        expect(theme[field], `theme ${theme.id} missing ${field}`).toBeDefined();
      }
      expect(typeof theme.id).toBe('string');
      expect(typeof theme.name).toBe('string');
      expect(typeof theme.isDark).toBe('boolean');
    }
  });

  it('theme ids are unique', () => {
    const ids = TERMINAL_THEMES.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('non-default themes have plausible hex color values', () => {
    const hexRe = /^#[0-9a-fA-F]{6,8}$/;
    for (const theme of TERMINAL_THEMES) {
      if (theme.id === 'default') continue; // default derives from CSS at runtime
      expect(theme.background, `${theme.id} background`).toMatch(hexRe);
      expect(theme.foreground, `${theme.id} foreground`).toMatch(hexRe);
      expect(theme.red, `${theme.id} red`).toMatch(hexRe);
      expect(theme.brightBlack, `${theme.id} brightBlack`).toMatch(hexRe);
    }
  });
});

describe('getThemeById', () => {
  it('returns the theme matching a known id', () => {
    const dracula = getThemeById('dracula');
    expect(dracula?.id).toBe('dracula');
    expect(dracula?.background).toBe('#282a36');
  });

  it('returns null for an unknown id', () => {
    expect(getThemeById('not-a-theme')).toBeNull();
    expect(getThemeById('')).toBeNull();
  });

  it('default is built fresh each call — tracks live CSS', () => {
    document.documentElement.style.setProperty('--bg', '#111111');
    document.documentElement.style.setProperty('--text', '#eeeeee');
    document.documentElement.style.setProperty('--accent', '#ff0000');
    const first = getThemeById('default')!;
    expect(first.background).toBe('#111111');
    expect(first.foreground).toBe('#eeeeee');
    expect(first.cursor).toBe('#ff0000');

    document.documentElement.style.setProperty('--bg', '#222222');
    const second = getThemeById('default')!;
    expect(second.background).toBe('#222222');
    expect(second).not.toBe(first); // fresh object
  });
});

describe('readCssDefaultTheme', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('--bg');
    document.documentElement.style.removeProperty('--text');
    document.documentElement.style.removeProperty('--accent');
  });

  it('falls back to #ffffff / #000000 / #3b82f6 when CSS vars are unset', () => {
    const theme = readCssDefaultTheme();
    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#000000');
    expect(theme.cursor).toBe('#3b82f6');
  });

  it('id and name are the fixed "default" / "Default" strings', () => {
    expect(readCssDefaultTheme().id).toBe(DEFAULT_THEME_ID);
    expect(readCssDefaultTheme().name).toBe('Default');
  });

  it('populates the ANSI palette even without any CSS var configuration', () => {
    const theme = readCssDefaultTheme();
    expect(theme.red).toBeTruthy();
    expect(theme.green).toBeTruthy();
    expect(theme.blue).toBeTruthy();
    expect(theme.brightWhite).toBeTruthy();
  });
});

describe('themeToXtermOptions', () => {
  it('round-trips every color field verbatim', () => {
    const theme = getThemeById('dracula')!;
    const opts = themeToXtermOptions(theme);
    expect(opts.background).toBe(theme.background);
    expect(opts.foreground).toBe(theme.foreground);
    expect(opts.cursor).toBe(theme.cursor);
    expect(opts.red).toBe(theme.red);
    expect(opts.brightBlue).toBe(theme.brightBlue);
    expect(opts.selectionBackground).toBe(theme.selectionBackground);
  });

  it('output shape does not include the TerminalTheme metadata (id, name, isDark)', () => {
    const theme = getThemeById('nord')!;
    const opts = themeToXtermOptions(theme);
    expect((opts as unknown as { id?: string }).id).toBeUndefined();
    expect((opts as unknown as { name?: string }).name).toBeUndefined();
    expect((opts as unknown as { isDark?: boolean }).isDark).toBeUndefined();
  });

  it('populates every ANSI color field so xterm never sees undefined', () => {
    const theme = getThemeById('monokai')!;
    const opts = themeToXtermOptions(theme);
    const requiredFields: Array<keyof typeof opts> = [
      'foreground', 'background', 'cursor', 'cursorAccent',
      'selectionBackground', 'selectionInactiveBackground',
      'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
      'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
    ];
    for (const field of requiredFields) {
      expect(opts[field], `missing ${field}`).toBeDefined();
      expect(typeof opts[field]).toBe('string');
    }
  });
});
