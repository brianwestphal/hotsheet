/**
 * @vitest-environment happy-dom
 *
 * Unit tests for the HS-6307 terminal font registry (see
 * docs/35-terminal-themes.md §35.3).
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetFontCacheForTests,
  buildGoogleFontsUrl,
  clampFontSize,
  DEFAULT_FONT_ID,
  DEFAULT_FONT_SIZE,
  getFontById,
  loadGoogleFont,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  TERMINAL_FONTS,
} from './terminalFonts.js';

afterEach(() => {
  _resetFontCacheForTests();
});

describe('TERMINAL_FONTS registry', () => {
  it('ships at least 11 fonts including System as the first entry', () => {
    expect(TERMINAL_FONTS.length).toBeGreaterThanOrEqual(11);
    expect(TERMINAL_FONTS[0].id).toBe('system');
  });

  it('every font has a non-empty family + id, and System alone has googleFontsName=null', () => {
    for (const font of TERMINAL_FONTS) {
      expect(font.id).toBeTruthy();
      expect(font.name).toBeTruthy();
      expect(font.family).toBeTruthy();
      if (font.id === 'system') {
        expect(font.googleFontsName).toBeNull();
      } else {
        expect(font.googleFontsName).toBeTruthy();
      }
    }
  });

  it('font ids are unique', () => {
    const ids = TERMINAL_FONTS.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('non-system fonts put the Google family first in the CSS family stack', () => {
    const jetbrains = getFontById('jetbrains-mono')!;
    expect(jetbrains.family.startsWith('"JetBrains Mono"')).toBe(true);
    // System fallback stack trails — so a missing web font still lands on
    // Menlo / SF Mono rather than an unreadable blank.
    expect(jetbrains.family).toContain('monospace');
  });
});

describe('getFontById', () => {
  it('returns null for unknown ids', () => {
    expect(getFontById('not-a-font')).toBeNull();
    expect(getFontById('')).toBeNull();
  });

  it('finds System by its DEFAULT_FONT_ID', () => {
    const font = getFontById(DEFAULT_FONT_ID)!;
    expect(font.googleFontsName).toBeNull();
  });
});

describe('clampFontSize', () => {
  it('rounds floats', () => {
    expect(clampFontSize(13.4)).toBe(13);
    expect(clampFontSize(13.6)).toBe(14);
  });

  it('clamps below MIN_FONT_SIZE', () => {
    expect(clampFontSize(0)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(-5)).toBe(MIN_FONT_SIZE);
  });

  it('clamps above MAX_FONT_SIZE', () => {
    expect(clampFontSize(100)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(MAX_FONT_SIZE + 1)).toBe(MAX_FONT_SIZE);
  });

  it('returns DEFAULT_FONT_SIZE for NaN / Infinity', () => {
    expect(clampFontSize(NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(Infinity)).toBe(DEFAULT_FONT_SIZE);
    expect(clampFontSize(-Infinity)).toBe(DEFAULT_FONT_SIZE);
  });
});

describe('buildGoogleFontsUrl', () => {
  it('encodes spaces in the family name', () => {
    const url = buildGoogleFontsUrl('JetBrains Mono');
    expect(url).toContain('family=JetBrains%20Mono');
  });

  it('uses css2 and display=swap to avoid FOIT', () => {
    const url = buildGoogleFontsUrl('Fira Code');
    expect(url).toContain('fonts.googleapis.com/css2');
    expect(url).toContain('display=swap');
  });
});

describe('loadGoogleFont', () => {
  it('resolves immediately for System without touching the DOM', async () => {
    const system = getFontById('system')!;
    const before = document.querySelectorAll('link').length;
    await loadGoogleFont(system);
    const after = document.querySelectorAll('link').length;
    expect(after).toBe(before);
  });

  it('appends one <link> per distinct font id', async () => {
    const jetbrains = getFontById('jetbrains-mono')!;
    await loadGoogleFont(jetbrains);
    const links = document.querySelectorAll('link[data-terminal-font-id="jetbrains-mono"]');
    expect(links.length).toBe(1);
  });

  it('is idempotent — a second call does not add a duplicate <link>', async () => {
    const fira = getFontById('fira-code')!;
    await loadGoogleFont(fira);
    await loadGoogleFont(fira);
    const links = document.querySelectorAll('link[data-terminal-font-id="fira-code"]');
    expect(links.length).toBe(1);
  });

  it('concurrent calls for the same font share one network request', async () => {
    const font = getFontById('roboto-mono')!;
    const [a, b, c] = await Promise.all([
      loadGoogleFont(font),
      loadGoogleFont(font),
      loadGoogleFont(font),
    ]);
    expect(a).toBeUndefined();
    expect(b).toBeUndefined();
    expect(c).toBeUndefined();
    const links = document.querySelectorAll('link[data-terminal-font-id="roboto-mono"]');
    expect(links.length).toBe(1);
  });
});
