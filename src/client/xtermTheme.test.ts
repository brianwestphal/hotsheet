import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readXtermTheme, withAlpha } from './xtermTheme.js';

describe('withAlpha (HS-7330)', () => {
  it('appends 8-bit alpha hex to a 6-digit hex colour', () => {
    expect(withAlpha('#3b82f6', 0x66)).toBe('#3b82f666');
    expect(withAlpha('#000000', 0xff)).toBe('#000000ff');
    expect(withAlpha('#ffffff', 0x00)).toBe('#ffffff00');
  });

  it('expands a 3-digit hex colour before appending alpha', () => {
    expect(withAlpha('#abc', 0x80)).toBe('#aabbcc80');
    expect(withAlpha('#f00', 0x66)).toBe('#ff000066');
  });

  it('falls back to the app accent when input is not a hex colour', () => {
    expect(withAlpha('rgb(10, 20, 30)', 0x66)).toBe('#3b82f666');
    expect(withAlpha('red', 0x66)).toBe('#3b82f666');
    expect(withAlpha('', 0x66)).toBe('#3b82f666');
  });

  it('clamps alpha out-of-range values', () => {
    expect(withAlpha('#3b82f6', -10)).toBe('#3b82f600');
    expect(withAlpha('#3b82f6', 999)).toBe('#3b82f6ff');
    expect(withAlpha('#3b82f6', 102.8)).toBe('#3b82f667');
  });

  it('lowercases the alpha hex so selectionBackground round-trips cleanly', () => {
    expect(withAlpha('#3b82f6', 0xab)).toBe('#3b82f6ab');
  });
});

describe('readXtermTheme (HS-7330)', () => {
  let originalGetComputedStyle: typeof window.getComputedStyle;

  beforeEach(() => {
    originalGetComputedStyle = globalThis.getComputedStyle;
    // Stub document.documentElement access — readXtermTheme calls
    // getComputedStyle(document.documentElement) then reads individual
    // --vars via .getPropertyValue. We provide a fake that returns the
    // map we set per test.
    const styleMap = new Map<string, string>();
    styleMap.set('--bg', '#ffffff');
    styleMap.set('--text', '#111827');
    styleMap.set('--accent', '#3b82f6');
    vi.stubGlobal('getComputedStyle', () => ({
      getPropertyValue: (name: string) => styleMap.get(name) ?? '',
    }));
    // readXtermTheme also references `document.documentElement`; in
    // Node without jsdom there is no document, so stub that too.
    vi.stubGlobal('document', { documentElement: {} as Element });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.getComputedStyle = originalGetComputedStyle;
  });

  it('includes selectionBackground derived from --accent', () => {
    const theme = readXtermTheme();
    expect(theme.selectionBackground).toBe('#3b82f666');
  });

  it('includes selectionInactiveBackground at a lower alpha', () => {
    const theme = readXtermTheme();
    expect(theme.selectionInactiveBackground).toBe('#3b82f633');
  });

  it('exposes background / foreground / cursor alongside the selection keys', () => {
    const theme = readXtermTheme();
    expect(theme.background).toBe('#ffffff');
    expect(theme.foreground).toBe('#111827');
    expect(theme.cursor).toBe('#3b82f6');
  });

  it('falls back to the default accent when --accent is unset', () => {
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: () => '' }));
    const theme = readXtermTheme();
    expect(theme.selectionBackground).toBe('#3b82f666');
    expect(theme.selectionInactiveBackground).toBe('#3b82f633');
  });

  it('never returns an empty selectionBackground (guards against the regression)', () => {
    // The bug (HS-7330) was that selectionBackground was undefined, so xterm
    // fell back to a near-white translucent default that was invisible on
    // the app's white --bg. This test locks in the invariant: whatever the
    // theme source returns, selectionBackground must be a non-empty hex
    // colour string with an alpha suffix.
    const theme = readXtermTheme();
    expect(theme.selectionBackground).toMatch(/^#[0-9a-f]{8}$/);
    expect(theme.selectionInactiveBackground).toMatch(/^#[0-9a-f]{8}$/);
  });
});
